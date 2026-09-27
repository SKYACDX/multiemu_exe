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

#include <condition_variable>
#include <cstddef>
#include <cstdint>
#include <memory>
#include <mutex>
#include <string>
#include <unordered_map>
#include <vector>

#include "gba_link.h"
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
                               InstanceMethod("close", &Gba::close),
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

    ~Gba() { release(); }

   private:
    // Tears the core down now rather than whenever the garbage collector
    // gets round to the wrapper. That matters because mGBA holds the save
    // file open and writable for the core's lifetime: anything that wants
    // to replace that file -- restoring one from the cloud, say -- has to
    // be able to make it let go first, and has to know it happened.
    void release() {
        if (!core_) return;
        mCoreConfigDeinit(&core_->config);
        core_->deinit(core_);
        core_ = nullptr;
        loaded_ = false;
    }

   public:
    void close(const Napi::CallbackInfo&) { release(); }

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

// ---- Link cable ---------------------------------------------------------

// The same loading sequence as Gba's constructor, minus the video buffer
// and the reset: LinkedGbaSession does those itself, in the order mGBA
// needs (reset only associates the renderer if the buffer is already set --
// getting that backwards is a permanently black screen). Kept separate
// rather than shared with Gba, like the Android side does, so the
// single-player path this app mostly runs is left exactly as it was.
mCore* loadLinkedCore(const Napi::Uint8Array& rom, const std::string& savePath) {
    VFile* romFile = VFileMemChunk(rom.Data(), rom.ByteLength());
    if (!romFile) return nullptr;

    mCore* core = mCoreFindVF(romFile);
    if (!core || core->platform(core) != mPLATFORM_GBA) {
        if (core) core->deinit(core);
        romFile->close(romFile);
        return nullptr;
    }
    core->init(core);
    mCoreInitConfig(core, "gba");
    mCoreConfigSetDefaultIntValue(&core->config, "volume", 0x100);
    mCoreLoadForeignConfig(core, &core->config);

    if (!core->loadROM(core, romFile)) {
        mCoreConfigDeinit(&core->config);
        core->deinit(core);
        romFile->close(romFile);
        return nullptr;
    }
    VFile* saveFile = VFileOpen(savePath.c_str(), O_CREAT | O_RDWR);
    if (saveFile) core->loadSave(core, saveFile);
    return core;
}

// Pausing a linked pair. Each console runs on its own thread inside
// LinkedGbaSession, which has no notion of pausing -- on Android there was
// no pause menu to need one. Rather than change that shared code, each
// core's runFrame (a plain function pointer in mCore) is swapped for one
// that first waits at this gate. A console held here between frames also
// holds its partner, the next time the lockstep protocol makes it wait.
struct PauseGate {
    std::mutex mutex;
    std::condition_variable cv;
    bool paused = false;
};

struct GatedCore {
    PauseGate* gate;
    void (*runFrame)(mCore*);
};

// mCore has nowhere to hang data of our own, so the gate is looked up by
// core. At most two entries, and only while a link is open.
std::mutex gatedCoresMutex;
std::unordered_map<mCore*, GatedCore> gatedCores;

void gatedRunFrame(mCore* core) {
    GatedCore gated;
    {
        std::lock_guard<std::mutex> lock(gatedCoresMutex);
        gated = gatedCores.at(core);
    }
    {
        std::unique_lock<std::mutex> lock(gated.gate->mutex);
        gated.gate->cv.wait(lock, [&] { return !gated.gate->paused; });
    }
    gated.runFrame(core);
}

// Two GBAs joined by a link cable, for trading and link battles. The
// engine is the Android app's LinkedGbaSession: each console runs on its
// own thread at the real frame rate, and mGBA's lockstep protocol makes
// one wait whenever the other has to catch up mid-transfer. So there is
// nothing to drive from here -- runFrame is a no-op, and frame() collects
// whatever each thread finished last.
//
// One keyboard, two players: input and audio go to whichever console is
// active (setPlayer), and the other one keeps running on its own.
class GbaLink : public Napi::ObjectWrap<GbaLink> {
   public:
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "GbaLink",
                           {
                               InstanceMethod("runFrame", &GbaLink::runFrame),
                               InstanceMethod("frame", &GbaLink::frame),
                               InstanceMethod("setButton", &GbaLink::setButton),
                               InstanceMethod("readAudio", &GbaLink::readAudio),
                               InstanceMethod("setPlayer", &GbaLink::setPlayer),
                               InstanceMethod("setPaused", &GbaLink::setPaused),
                               InstanceMethod("close", &GbaLink::close),
                               InstanceAccessor("audioSampleRate", &GbaLink::audioSampleRate, nullptr),
                               InstanceAccessor("width", &GbaLink::width, nullptr),
                               InstanceAccessor("height", &GbaLink::height, nullptr),
                           });
    }

    // GbaLink(romA, savePathA, romB, savePathB). The two save paths must
    // differ: each core writes straight through to its own for as long as
    // it runs, and two writers on one file would corrupt it.
    explicit GbaLink(const Napi::CallbackInfo& info) : Napi::ObjectWrap<GbaLink>(info) {
        Napi::Env env = info.Env();
        if (info.Length() < 4 || !info[0].IsTypedArray() || !info[2].IsTypedArray() ||
            !info[1].IsString() || !info[3].IsString()) {
            Napi::TypeError::New(env, "GbaLink(romA, saveA, romB, saveB)").ThrowAsJavaScriptException();
            return;
        }
        mCore* cores[2] = {};
        for (int player = 0; player < 2; player++) {
            cores[player] = loadLinkedCore(info[player * 2].As<Napi::Uint8Array>(),
                                           info[player * 2 + 1].As<Napi::String>());
            if (!cores[player]) {
                if (cores[0]) {
                    mCoreConfigDeinit(&cores[0]->config);
                    cores[0]->deinit(cores[0]);
                }
                std::string message = "El juego del jugador " + std::to_string(player + 1) +
                                      " no es una ROM de GBA";
                Napi::Error::New(env, message).ThrowAsJavaScriptException();
                return;
            }
        }
        {
            std::lock_guard<std::mutex> lock(gatedCoresMutex);
            for (mCore* core : cores) {
                gatedCores[core] = {&gate_, core->runFrame};
                core->runFrame = gatedRunFrame;
                cores_.push_back(core);
            }
        }
        // Starts both run threads straight away, and owns the cores from
        // here on: its destructor joins the threads and deinits them.
        session_ = std::make_unique<LinkedGbaSession>(cores[0], cores[1]);
    }

    ~GbaLink() { release(); }

   private:
    void release() {
        if (!session_) return;
        // A paused console would sit at the gate forever and the join in
        // the session's destructor would never return.
        setGate(false);
        session_.reset();
        std::lock_guard<std::mutex> lock(gatedCoresMutex);
        for (mCore* core : cores_) gatedCores.erase(core);
        cores_.clear();
    }

    void setGate(bool paused) {
        {
            std::lock_guard<std::mutex> lock(gate_.mutex);
            gate_.paused = paused;
        }
        gate_.cv.notify_all();
    }

    bool ready(Napi::Env env) {
        if (session_) return true;
        Napi::Error::New(env, "this link cable failed to start").ThrowAsJavaScriptException();
        return false;
    }

    void close(const Napi::CallbackInfo&) { release(); }

    void runFrame(const Napi::CallbackInfo&) {}

    void setPaused(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        setGate(info[0].As<Napi::Boolean>().Value());
    }

    // Both screens in one frame, player 1 above player 2 -- the same shape
    // as the DS's two screens, so the renderer lays them out the same way.
    Napi::Value frame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();

        constexpr std::size_t kPixels = 240 * 160;
        std::vector<uint32_t> screen(kPixels);
        auto out = Napi::Uint8Array::New(info.Env(), kPixels * 2 * 4);
        uint8_t* pixels = out.Data();
        for (int player = 0; player < 2; player++) {
            // 0xFFRRGGBB, the way Android bitmaps want it.
            session_->getFramebuffer(player, screen.data());
            uint8_t* dest = pixels + player * kPixels * 4;
            for (std::size_t i = 0; i < kPixels; i++) {
                dest[i * 4 + 0] = (screen[i] >> 16) & 0xFF;
                dest[i * 4 + 1] = (screen[i] >> 8) & 0xFF;
                dest[i * 4 + 2] = screen[i] & 0xFF;
                dest[i * 4 + 3] = 0xFF;
            }
        }
        return out;
    }

    // Same button ordinals as Gba (enum GBAKey), for the active player.
    void setButton(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        int buttonId = info[0].As<Napi::Number>().Int32Value();
        if (buttonId < 0 || buttonId > 9) return;
        session_->setButtonPressed(player_, buttonId, info[1].As<Napi::Boolean>().Value());
    }

    // Lets go of everything on the console being left, or a button held
    // while switching would stay pressed on it indefinitely.
    void setPlayer(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        int player = info[0].As<Napi::Number>().Int32Value();
        if (player < 0 || player > 1) return;
        for (int buttonId = 0; buttonId <= 9; buttonId++) {
            session_->setButtonPressed(player_, buttonId, false);
        }
        player_ = player;
    }

    // Only the active console is heard: two copies of the same soundtrack
    // a few frames apart is noise. The other one's samples are dropped by
    // mGBA itself once its buffer is full (src/gba/audio.c only adds a
    // sample while there is room).
    Napi::Value readAudio(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        int capacity = info[0].As<Napi::Number>().Int32Value();
        if (capacity <= 0) return Napi::Int16Array::New(info.Env(), 0);
        std::vector<int16_t> samples(static_cast<std::size_t>(capacity) * 2);
        int frames = session_->readAudioSamples(player_, samples.data(), capacity);
        auto out = Napi::Int16Array::New(info.Env(), static_cast<std::size_t>(frames) * 2);
        std::copy(samples.begin(), samples.begin() + frames * 2, out.Data());
        return out;
    }

    Napi::Value audioSampleRate(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), kAudioSampleRateHz);
    }
    Napi::Value width(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), 240); }
    Napi::Value height(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), 320); }

    std::unique_ptr<LinkedGbaSession> session_;
    std::vector<mCore*> cores_;
    PauseGate gate_;
    int player_ = 0;
};

Napi::Object init(Napi::Env env, Napi::Object exports) {
    exports.Set("Gba", Gba::define(env));
    exports.Set("GbaLink", GbaLink::define(env));
    return exports;
}

}  // namespace

NODE_API_MODULE(gba_addon, init)
