// N-API bridge over mGBA's public C core API (mCore). Mirrors the Android
// JNI bridge it replaces (app/android/gbacore/src/main/cpp/gba_jni.cpp in
// the shared repo) -- including the config dance below, which is not
// optional and not obvious.
//
// Unlike gb_addon, there is no core of our own here: writing a second
// cycle-accurate core from scratch (ARM7TDMI plus a much heavier PPU) was
// judged out of scope, so mGBA (MPL-2.0) is the actual engine.
#include <napi.h>

#include <fcntl.h>

#include <cstddef>
#include <cstdint>
#include <vector>

#include "mgba/core/blip_buf.h"
#include "mgba/core/core.h"
#include "mgba-util/vfs.h"

namespace {

// mGBA can be built with 16-bit pixels; this build isn't, and the frame
// conversion below assumes 4 bytes per pixel.
static_assert(sizeof(color_t) == 4, "expected a 32-bit colour build of mGBA");

// mGBA's GBA core defaults both audio channels to 96000Hz (the
// blip_set_rates calls in src/gba/audio.c) -- unusually high, and not what
// a browser AudioContext wants. Every real mGBA frontend overrides it right
// after creating the core; 48000 matches what melonDS outputs, so both
// cores here feed the same audio graph.
constexpr int kAudioSampleRateHz = 48000;

class Gba : public Napi::ObjectWrap<Gba> {
   public:
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "Gba",
                           {
                               InstanceMethod("runFrame", &Gba::runFrame),
                               InstanceMethod("frame", &Gba::frame),
                               InstanceMethod("setButton", &Gba::setButton),
                               InstanceMethod("readAudio", &Gba::readAudio),
                               InstanceMethod("saveState", &Gba::saveState),
                               InstanceMethod("loadState", &Gba::loadState),
                               InstanceAccessor("audioSampleRate", &Gba::audioSampleRate, nullptr),
                               InstanceAccessor("width", &Gba::width, nullptr),
                               InstanceAccessor("height", &Gba::height, nullptr),
                           });
    }

    // Gba(romBytes, savePath). savePath may be null; when given, mGBA's
    // cartridge RAM/flash emulation writes straight through to that file
    // as the game saves, the way a real GBA's save chip is memory-mapped.
    // There is no "export the save" step to do afterwards.
    explicit Gba(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Gba>(info) {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsTypedArray()) {
            Napi::TypeError::New(env, "Gba(rom, savePath): rom must be a Uint8Array")
                .ThrowAsJavaScriptException();
            return;
        }

        auto bytes = info[0].As<Napi::Uint8Array>();
        // VFileMemChunk copies, so the ROM doesn't have to outlive this call.
        VFile* romFile = VFileMemChunk(bytes.Data(), bytes.ByteLength());
        if (!romFile) {
            Napi::Error::New(env, "out of memory reading the ROM").ThrowAsJavaScriptException();
            return;
        }

        core_ = mCoreFindVF(romFile);
        // mCoreFindVF happily recognises GB/GBC too, but gb_addon is the
        // intended home for those -- reject rather than silently running
        // them through mGBA's own GB support.
        if (!core_ || core_->platform(core_) != mPLATFORM_GBA) {
            if (core_) core_->deinit(core_);
            core_ = nullptr;
            romFile->close(romFile);
            Napi::Error::New(env, "not a GBA ROM mGBA recognises").ThrowAsJavaScriptException();
            return;
        }

        core_->init(core_);

        // This sequence is what every real mGBA frontend does (see
        // src/platform/sdl/main.c) and skipping it is a trap:
        // core->opts would be left at whatever GBACoreCreate zero-filled,
        // which is undocumented rather than safe. In particular
        // core->opts.volume has no built-in default, and
        // _GBACoreLoadConfig assigns it straight into
        // gba->audio.masterVolume -- leaving it zero mutes the emulator
        // at the source. Audio isn't wired up on this side yet, but the
        // default belongs here so it isn't silence when it is.
        mCoreInitConfig(core_, "gba");
        mCoreConfigSetDefaultIntValue(&core_->config, "volume", 0x100);
        mCoreLoadForeignConfig(core_, &core_->config);

        core_->desiredVideoDimensions(core_, &width_, &height_);
        videoBuffer_.assign(static_cast<std::size_t>(width_) * height_, 0);
        core_->setVideoBuffer(core_, videoBuffer_.data(), width_);

        if (!core_->loadROM(core_, romFile)) {
            romFile->close(romFile);
            Napi::Error::New(env, "mGBA could not load this ROM").ThrowAsJavaScriptException();
            return;
        }

        if (info.Length() > 1 && info[1].IsString()) {
            std::string savePath = info[1].As<Napi::String>();
            VFile* saveFile = VFileOpen(savePath.c_str(), O_CREAT | O_RDWR);
            if (saveFile) core_->loadSave(core_, saveFile);
        }

        core_->reset(core_);

        core_->setAudioBufferSize(core_, 2048);
        blip_set_rates(core_->getAudioChannel(core_, 0), core_->frequency(core_), kAudioSampleRateHz);
        blip_set_rates(core_->getAudioChannel(core_, 1), core_->frequency(core_), kAudioSampleRateHz);

        loaded_ = true;
    }

    ~Gba() {
        if (!core_) return;
        mCoreConfigDeinit(&core_->config);
        core_->deinit(core_);
    }

   private:
    void runFrame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        core_->runFrame(core_);
    }

    // mGBA's color_t packs R into bits 0-7, G into 8-15, B into 16-23 and
    // leaves alpha unset (M_COLOR_RED/GREEN/BLUE in mgba/core/interface.h).
    // On a little-endian host that is already R,G,B in byte order, so the
    // conversion to canvas RGBA is a byte copy plus an opaque alpha.
    Napi::Value frame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();

        auto out = Napi::Uint8Array::New(info.Env(), videoBuffer_.size() * 4);
        uint8_t* pixels = out.Data();
        for (std::size_t i = 0; i < videoBuffer_.size(); i++) {
            auto pixel = static_cast<uint32_t>(videoBuffer_[i]);
            pixels[i * 4 + 0] = pixel & 0xFF;
            pixels[i * 4 + 1] = (pixel >> 8) & 0xFF;
            pixels[i * 4 + 2] = (pixel >> 16) & 0xFF;
            pixels[i * 4 + 3] = 0xFF;
        }
        return out;
    }

    // buttonId is the ordinal of enum GBAKey (mgba/internal/gba/input.h):
    // 0=A 1=B 2=Select 3=Start 4=Right 5=Left 6=Up 7=Down 8=R 9=L.
    void setButton(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;

        int buttonId = info[0].As<Napi::Number>().Int32Value();
        if (buttonId < 0 || buttonId > 9) {
            Napi::RangeError::New(info.Env(), "buttonId must be 0-9").ThrowAsJavaScriptException();
            return;
        }

        uint32_t bit = 1u << buttonId;
        if (info[1].As<Napi::Boolean>().Value()) {
            core_->addKeys(core_, bit);
        } else {
            core_->clearKeys(core_, bit);
        }
    }

    // Whatever mGBA has synthesised since the last call, as interleaved
    // stereo s16 at kAudioSampleRateHz. mGBA keeps the two channels in
    // separate blip_buf queues, so they are woven together here -- unlike
    // melonDS, which already hands over interleaved output.
    Napi::Value readAudio(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();

        blip_t* left = core_->getAudioChannel(core_, 0);
        blip_t* right = core_->getAudioChannel(core_, 1);

        int capacity = info[0].As<Napi::Number>().Int32Value();
        int frames = blip_samples_avail(left);
        if (frames > capacity) frames = capacity;
        if (frames <= 0) return Napi::Int16Array::New(info.Env(), 0);

        auto out = Napi::Int16Array::New(info.Env(), static_cast<size_t>(frames) * 2);
        // Stride 1 means "write every other slot", which interleaves the two
        // reads into one buffer.
        blip_read_samples(left, out.Data(), frames, 1);
        blip_read_samples(right, out.Data() + 1, frames, 1);
        return out;
    }

    Napi::Value audioSampleRate(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), kAudioSampleRateHz);
    }

    // The whole machine (CPU, memory, PPU, APU), not just cartridge save
    // RAM, so the user can rewind to anywhere rather than to wherever the
    // game's own save system allows. mCore implements this fully, so both
    // of these are passthroughs.
    Napi::Value saveState(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();

        const std::size_t size = core_->stateSize(core_);
        auto out = Napi::Uint8Array::New(info.Env(), size);
        if (!core_->saveState(core_, out.Data())) {
            Napi::Error::New(info.Env(), "no se pudo guardar el estado").ThrowAsJavaScriptException();
            return info.Env().Undefined();
        }
        return out;
    }

    Napi::Value loadState(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();

        auto bytes = info[0].As<Napi::Uint8Array>();
        if (bytes.ByteLength() != core_->stateSize(core_)) {
            Napi::Error::New(info.Env(), "el estado no corresponde a este juego")
                .ThrowAsJavaScriptException();
            return info.Env().Undefined();
        }
        return Napi::Boolean::New(info.Env(), core_->loadState(core_, bytes.Data()));
    }

    Napi::Value width(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), width_);
    }
    Napi::Value height(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), height_);
    }

    // The constructor reports failures by throwing, but N-API still hands
    // the half-built object back to JS, so every method has to refuse to
    // touch a core that never finished loading.
    bool ready(Napi::Env env) {
        if (loaded_) return true;
        Napi::Error::New(env, "this GBA instance failed to load").ThrowAsJavaScriptException();
        return false;
    }

    mCore* core_ = nullptr;
    std::vector<color_t> videoBuffer_;
    unsigned width_ = 0;
    unsigned height_ = 0;
    bool loaded_ = false;
};

Napi::Object init(Napi::Env env, Napi::Object exports) {
    exports.Set("Gba", Gba::define(env));
    return exports;
}

}  // namespace

NODE_API_MODULE(gba_addon, init)
