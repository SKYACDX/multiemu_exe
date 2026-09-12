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

#include <cstdint>
#include <vector>

#include "mgba/core/core.h"
#include "mgba-util/vfs.h"

namespace {

// mGBA can be built with 16-bit pixels; this build isn't, and the frame
// conversion below assumes 4 bytes per pixel.
static_assert(sizeof(color_t) == 4, "expected a 32-bit colour build of mGBA");

class Gba : public Napi::ObjectWrap<Gba> {
   public:
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "Gba",
                           {
                               InstanceMethod("runFrame", &Gba::runFrame),
                               InstanceMethod("frame", &Gba::frame),
                               InstanceMethod("setButton", &Gba::setButton),
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
