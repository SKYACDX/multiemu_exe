// N-API bridge over melonDS. The Platform:: layer melonDS requires lives
// next door in ds_platform.cpp; this file is the session: build an NDS,
// feed it a cart, run frames, hand pixels and input across.
//
// Ported from the Android JNI version in the shared repo
// (app/android/dscore/src/main/cpp/ds_jni.cpp), minus its EGL/GL renderer
// path -- this build uses melonDS's software renderer, which needs no
// graphics context of its own. That is also why the Android patch's
// compositor swizzle is harmless here: with ENABLE_OGLRENDERER=OFF none of
// those shaders are compiled. Turning the GL renderer on later means
// reverting that swizzle first (see the README).
#include <napi.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <cstdio>
#include <memory>
#include <mutex>
#include <optional>
#include <string>
#include <thread>
#include <vector>

#include "Args.h"
#include "LocalMP.h"
#include "NDS.h"
#include "NDSCart.h"
#include "SPI_Firmware.h"
#include "Savestate.h"
#include "ds_platform.h"

using namespace melonDS;

namespace {

constexpr int kScreenWidth = 256;
constexpr int kScreenHeight = 192;

// Both screens are returned stacked in one image, top over bottom, so the
// renderer draws a single canvas. Touch input maps back by subtracting the
// top screen's height.
constexpr int kStackedHeight = kScreenHeight * 2;

// Must match NDSArgs::OutputSampleRate, which this build leaves at its
// default (Args.h). Also what gba_addon.cpp resamples mGBA down to, so both
// cores feed the same audio graph.
constexpr double kAudioSampleRateHz = 48000.0;

std::vector<u8> ReadWholeFile(const std::string& path) {
    FILE* f = fopen(path.c_str(), "rb");
    if (!f) return {};
    _fseeki64(f, 0, SEEK_END);
    long long length = _ftelli64(f);
    _fseeki64(f, 0, SEEK_SET);
    if (length <= 0) {
        fclose(f);
        return {};
    }
    std::vector<u8> data(static_cast<size_t>(length));
    const size_t read = fread(data.data(), 1, data.size(), f);
    fclose(f);
    if (read != data.size()) return {};
    return data;
}

// Reads back whatever Platform::WriteFirmware last saved. Returns nullopt
// on the first run, or when the file is the wrong size for a firmware
// image, in which case NDSArgs' generated default stands.
std::optional<Firmware> LoadSavedFirmware() {
    const std::string path = Platform::GetLocalFilePath(Platform::kFirmwareFileName);
    std::vector<u8> buffer = ReadWholeFile(path);
    // DS firmware images are 128K/256K/512K; anything else is truncated or
    // corrupt and better ignored than handed to the emulator.
    if (buffer.size() != 128 * 1024 && buffer.size() != 256 * 1024 &&
        buffer.size() != 512 * 1024) {
        return std::nullopt;
    }
    return Firmware(buffer.data(), static_cast<u32>(buffer.size()));
}

// A second console on a wireless link needs a MAC address of its own, or
// the two cannot tell each other apart. Same offsets melonDS's own
// frontend uses for its extra windows (EmuInstance::customizeFirmware).
void GiveOwnMac(Firmware& firmware, int instance) {
    auto& header = firmware.GetHeader();
    MacAddress mac = header.MacAddr;
    mac[3] += instance;
    mac[4] += instance * 0x44;
    mac[5] += instance * 0x10;
    mac[0] &= 0xFC;  // never a broadcast address
    header.MacAddr = mac;
    header.UpdateChecksum();
    firmware.UpdateChecksums();
}

// A console with the cart in, booted and ready to run -- shared by the
// single console and the wireless link. Both pointers must outlive it:
// the cart writes the save through savePath's address, and context is the
// userdata every Platform call about this console gets back.
std::unique_ptr<NDS> BuildNds(const std::string& romPath, std::string* savePath,
                              Platform::InstanceContext* context, std::string& error) {
    std::vector<u8> rom = ReadWholeFile(romPath);
    if (rom.empty()) {
        error = "could not read the ROM file";
        return nullptr;
    }

    // ParseROM wants the cart's initial SRAM up front, not lazily.
    NDSCart::NDSCartArgs cartArgs;
    std::vector<u8> save = ReadWholeFile(*savePath);
    if (!save.empty()) {
        auto sram = std::make_unique<u8[]>(save.size());
        std::copy(save.begin(), save.end(), sram.get());
        cartArgs.SRAM = std::move(sram);
        cartArgs.SRAMLength = static_cast<u32>(save.size());
    }

    auto romData = std::make_unique<u8[]>(rom.size());
    std::copy(rom.begin(), rom.end(), romData.get());

    // The userdata here (not NDS's own, set below) is what
    // Platform::WriteNDSSave receives -- see NDSCart.cpp.
    auto cart = NDSCart::ParseROM(std::move(romData), static_cast<u32>(rom.size()), savePath,
                                  std::move(cartArgs));
    if (!cart) {
        error = "not a Nintendo DS ROM melonDS recognises";
        return nullptr;
    }

    // Defaults to FreeBIOS and a generated firmware, so no copyrighted
    // BIOS dump is required...
    NDSArgs args;
    // ...except that a firmware saved by a previous session is reused.
    // Nintendo WFC settings live in the firmware rather than in any
    // cartridge, so carrying one image across sessions is what makes
    // "set the connection up once and every game has it" work, exactly
    // as on a real console. Both consoles of a link start from it, so
    // both have the connection.
    if (auto firmware = LoadSavedFirmware()) {
        args.Firmware = std::move(*firmware);
    }
    if (context->instance > 0) GiveOwnMac(args.Firmware, context->instance);

    auto nds = std::make_unique<NDS>(std::move(args), context);
    nds->SetNDSCart(std::move(cart));
    nds->Reset();
    if (nds->NeedsDirectBoot()) {
        nds->SetupDirectBoot(savePath->empty() ? "rom.nds" : *savePath);
    }
    nds->Start();
    return nds;
}

class Ds : public Napi::ObjectWrap<Ds> {
   public:
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "Ds",
                           {
                               InstanceMethod("runFrame", &Ds::runFrame),
                               InstanceMethod("frame", &Ds::frame),
                               InstanceMethod("setButton", &Ds::setButton),
                               InstanceMethod("touch", &Ds::touch),
                               InstanceMethod("releaseTouch", &Ds::releaseTouch),
                               InstanceMethod("readAudio", &Ds::readAudio),
                               InstanceMethod("saveState", &Ds::saveState),
                               InstanceMethod("loadState", &Ds::loadState),
                               InstanceMethod("close", &Ds::close),
                               InstanceAccessor("audioSampleRate", &Ds::audioSampleRate, nullptr),
                               InstanceAccessor("width", &Ds::width, nullptr),
                               InstanceAccessor("height", &Ds::height, nullptr),
                           });
    }

    // Ds(romPath, savePath). The ROM is read here by path rather than
    // handed over as bytes: NDS images run to 512MB, and routing that
    // through a JS typed array would copy it at least twice for nothing.
    explicit Ds(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Ds>(info) {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsString()) {
            Napi::TypeError::New(env, "Ds(romPath, savePath): romPath must be a string")
                .ThrowAsJavaScriptException();
            return;
        }

        const std::string romPath = info[0].As<Napi::String>();
        if (info.Length() > 1 && info[1].IsString()) savePath_ = info[1].As<Napi::String>();

        std::string error;
        nds_ = BuildNds(romPath, &savePath_, &context_, error);
        if (!nds_) {
            Napi::Error::New(env, error).ThrowAsJavaScriptException();
            return;
        }
        loaded_ = true;
    }

    // Frees the console now rather than at the garbage collector's
    // convenience -- an NDS holds the ROM image, which runs to 512MB.
    void close(const Napi::CallbackInfo&) {
        nds_.reset();
        loaded_ = false;
    }

   private:
    void runFrame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        nds_->RunFrame();
    }

    // melonDS's software framebuffer is already packed as 0xAARRGGBB per
    // pixel, which in memory on a little-endian host reads B,G,R,A. Canvas
    // ImageData wants R,G,B,A, so red and blue swap places. Alpha is forced
    // opaque rather than trusted: the DS has no use for it and the 2D
    // compositor does not promise a value.
    Napi::Value frame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();

        auto out = Napi::Uint8Array::New(info.Env(),
                                         static_cast<size_t>(kScreenWidth) * kStackedHeight * 4);
        uint8_t* pixels = out.Data();

        for (int screen = 0; screen < 2; screen++) {
            const u32* source = nds_->GPU.Framebuffer[nds_->GPU.FrontBuffer][screen].get();
            if (!source) continue;
            uint8_t* target = pixels + static_cast<size_t>(screen) * kScreenWidth * kScreenHeight * 4;
            for (int i = 0; i < kScreenWidth * kScreenHeight; i++) {
                const u32 pixel = source[i];
                target[i * 4 + 0] = (pixel >> 16) & 0xFF;
                target[i * 4 + 1] = (pixel >> 8) & 0xFF;
                target[i * 4 + 2] = pixel & 0xFF;
                target[i * 4 + 3] = 0xFF;
            }
        }
        return out;
    }

    // buttonBit indexes the DS's own KeyInput order: 0=A 1=B 2=Select
    // 3=Start 4=Right 5=Left 6=Up 7=Down 8=R 9=L 10=X 11=Y. The register is
    // active-low, so a pressed button clears its bit.
    void setButton(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;

        int buttonBit = info[0].As<Napi::Number>().Int32Value();
        if (buttonBit < 0 || buttonBit > 11) {
            Napi::RangeError::New(info.Env(), "buttonBit must be 0-11")
                .ThrowAsJavaScriptException();
            return;
        }

        const u32 bit = 1u << buttonBit;
        if (info[1].As<Napi::Boolean>().Value()) {
            keyMask_ &= ~bit;
        } else {
            keyMask_ |= bit;
        }
        nds_->SetKeyMask(keyMask_);
    }

    // x/y are touch-screen pixels, 0..255 and 0..191 -- bottom screen only,
    // so the caller subtracts the top screen's height first.
    void touch(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        nds_->TouchScreen(static_cast<u16>(info[0].As<Napi::Number>().Int32Value()),
                          static_cast<u16>(info[1].As<Napi::Number>().Int32Value()));
    }

    void releaseTouch(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        nds_->ReleaseScreen();
    }

    // SPU::ReadOutput already produces interleaved stereo s16 at
    // NDSArgs::OutputSampleRate, so this is a straight passthrough --
    // unlike mGBA, whose two channels live in separate queues.
    Napi::Value readAudio(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();

        int capacity = info[0].As<Napi::Number>().Int32Value();
        int frames = nds_->SPU.GetOutputSize();
        if (frames > capacity) frames = capacity;
        if (frames <= 0) return Napi::Int16Array::New(info.Env(), 0);

        auto out = Napi::Int16Array::New(info.Env(), static_cast<size_t>(frames) * 2);
        const int read = nds_->SPU.ReadOutput(out.Data(), frames);
        if (read == frames) return out;
        // ReadOutput can come up short; hand back only what it filled.
        auto trimmed = Napi::Int16Array::New(info.Env(), static_cast<size_t>(read) * 2);
        if (read > 0) std::copy(out.Data(), out.Data() + read * 2, trimmed.Data());
        return trimmed;
    }

    Napi::Value audioSampleRate(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), static_cast<int>(kAudioSampleRateHz));
    }

    // Unlike mGBA, whose state size is known up front, melonDS's Savestate
    // owns and grows its own buffer -- so the length has to be read back
    // off the object after DoSavestate has run.
    Napi::Value saveState(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();

        Savestate state;
        if (state.Error || !nds_->DoSavestate(&state) || state.Error) {
            Napi::Error::New(info.Env(), "no se pudo guardar el estado").ThrowAsJavaScriptException();
            return info.Env().Undefined();
        }

        // Savestate::Buffer() hands back a void*, so it needs a type before
        // it can be walked.
        const auto* buffer = static_cast<const u8*>(state.Buffer());
        auto out = Napi::Uint8Array::New(info.Env(), state.Length());
        std::copy(buffer, buffer + state.Length(), out.Data());
        return out;
    }

    Napi::Value loadState(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();

        auto bytes = info[0].As<Napi::Uint8Array>();
        // The `false` says this Savestate reads rather than writes.
        Savestate state(bytes.Data(), static_cast<u32>(bytes.ByteLength()), false);
        if (state.Error) return Napi::Boolean::New(info.Env(), false);
        return Napi::Boolean::New(info.Env(), nds_->DoSavestate(&state) && !state.Error);
    }

    Napi::Value width(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), kScreenWidth);
    }
    Napi::Value height(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), kStackedHeight);
    }

    // The constructor reports failures by throwing, but N-API still hands
    // the half-built object back, so every method refuses to touch a
    // session that never finished loading.
    bool ready(Napi::Env env) {
        if (loaded_) return true;
        Napi::Error::New(env, "this DS instance failed to load").ThrowAsJavaScriptException();
        return false;
    }

    std::unique_ptr<NDS> nds_;
    // Kept alive for the session's whole life: its address is the userdata
    // Platform::WriteNDSSave gets handed back.
    std::string savePath_;
    // The NDS's own userdata: a console on its own, instance 0.
    Platform::InstanceContext context_;
    // DS KeyInput is active-low -- a set bit means "not pressed".
    u32 keyMask_ = 0xFFF;
    bool loaded_ = false;
};

// ---- Local wireless -------------------------------------------------------

// 33513982 Hz / 560190 cycles per frame.
constexpr double kDsFps = 59.8261;

// Two consoles on local wireless, for trading, battles, Union Room and the
// like. Each runs on a thread of its own (see the MP_* functions in
// ds_platform.cpp for why it has to be), paced to the DS frame rate. The
// JS side never touches either NDS directly: input goes into atomics the
// console's own thread applies before each frame, and each finished frame
// is copied out under a lock -- melonDS itself is not safe to poke from
// two threads at once.
//
// One keyboard, two players, same as the GBA link: buttons and sound go to
// the active console (setPlayer). Touch goes to whichever bottom screen
// was clicked.
class DsLink : public Napi::ObjectWrap<DsLink> {
   public:
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "DsLink",
                           {
                               InstanceMethod("runFrame", &DsLink::runFrame),
                               InstanceMethod("frame", &DsLink::frame),
                               InstanceMethod("setButton", &DsLink::setButton),
                               InstanceMethod("touch", &DsLink::touch),
                               InstanceMethod("releaseTouch", &DsLink::releaseTouch),
                               InstanceMethod("readAudio", &DsLink::readAudio),
                               InstanceMethod("setPlayer", &DsLink::setPlayer),
                               InstanceMethod("setPaused", &DsLink::setPaused),
                               InstanceMethod("close", &DsLink::close),
                               InstanceAccessor("audioSampleRate", &DsLink::audioSampleRate, nullptr),
                               InstanceAccessor("width", &DsLink::width, nullptr),
                               InstanceAccessor("height", &DsLink::height, nullptr),
                           });
    }

    // DsLink(romA, saveA, romB, saveB). Paths, like Ds. The two save paths
    // must differ -- each cart writes through to its own.
    explicit DsLink(const Napi::CallbackInfo& info) : Napi::ObjectWrap<DsLink>(info) {
        Napi::Env env = info.Env();
        if (info.Length() < 4 || !info[0].IsString() || !info[1].IsString() ||
            !info[2].IsString() || !info[3].IsString()) {
            Napi::TypeError::New(env, "DsLink(romA, saveA, romB, saveB)").ThrowAsJavaScriptException();
            return;
        }
        // Up before either console exists, so both find it when they start.
        mp_ = std::make_unique<LocalMP>();
        Platform::SetLocalMP(mp_.get());

        for (int i = 0; i < 2; i++) {
            Player& p = players_[i];
            p.context.instance = i;
            p.context.persistFirmware = i == 0;
            p.savePath = info[i * 2 + 1].As<Napi::String>();
            std::string error;
            p.nds = BuildNds(info[i * 2].As<Napi::String>(), &p.savePath, &p.context, error);
            if (!p.nds) {
                release();
                Napi::Error::New(env, "Jugador " + std::to_string(i + 1) + ": " + error)
                    .ThrowAsJavaScriptException();
                return;
            }
        }
        running_ = true;
        for (int i = 0; i < 2; i++) players_[i].thread = std::thread([this, i] { runLoop(i); });
    }

    ~DsLink() { release(); }

   private:
    // A touch as one atomic word: bit 16 says the stylus is down, x and y
    // sit below it. 0 means released.
    static constexpr u32 kTouching = 1u << 16;

    struct Player {
        Platform::InstanceContext context;
        std::string savePath;
        std::unique_ptr<NDS> nds;
        std::thread thread;
        std::atomic<u32> keyMask{0xFFF};
        std::atomic<u32> touch{0};
        // Both screens, stacked, as melonDS packs them (0xAARRGGBB).
        std::vector<u32> screens = std::vector<u32>(256 * 384, 0);
        std::mutex screensMutex;
    };

    void runLoop(int id) {
        Player& p = players_[id];
        using clock = std::chrono::steady_clock;
        const std::chrono::duration<double> frameDuration(1.0 / kDsFps);
        auto next = clock::now();

        while (running_) {
            {
                std::unique_lock<std::mutex> lock(gateMutex_);
                if (paused_) {
                    gateCv_.wait(lock, [&] { return !paused_ || !running_; });
                    // The clock moved on while paused; don't race to catch up.
                    next = clock::now();
                }
            }
            if (!running_) break;

            NDS& nds = *p.nds;
            nds.SetKeyMask(p.keyMask.load());
            const u32 touch = p.touch.load();
            if (touch & kTouching) {
                nds.TouchScreen(touch & 0xFF, (touch >> 8) & 0xFF);
            } else {
                nds.ReleaseScreen();
            }
            nds.RunFrame();

            {
                std::lock_guard<std::mutex> lock(p.screensMutex);
                for (int screen = 0; screen < 2; screen++) {
                    const u32* source = nds.GPU.Framebuffer[nds.GPU.FrontBuffer][screen].get();
                    if (source) {
                        std::copy(source, source + 256 * 192, p.screens.begin() + screen * 256 * 192);
                    }
                }
            }

            // Receiving on the wireless link can block inside RunFrame for
            // a while, so a console that fell behind resumes from now
            // rather than bursting through frames to catch up.
            next += std::chrono::duration_cast<clock::duration>(frameDuration);
            const auto now = clock::now();
            if (next > now) {
                std::this_thread::sleep_until(next);
            } else {
                next = now;
            }
        }
    }

    // Stops both threads before anything they use goes away: the consoles,
    // then the queue they talk through. A console waiting on the link wakes
    // up on its own within LocalMP's receive timeout.
    void release() {
        {
            std::lock_guard<std::mutex> lock(gateMutex_);
            running_ = false;
            paused_ = false;
        }
        gateCv_.notify_all();
        for (Player& p : players_) {
            if (p.thread.joinable()) p.thread.join();
        }
        for (Player& p : players_) p.nds.reset();
        Platform::SetLocalMP(nullptr);
        mp_.reset();
        loaded_ = false;
    }

    bool ready(Napi::Env env) {
        if (running_) return true;
        Napi::Error::New(env, "this wireless link failed to start").ThrowAsJavaScriptException();
        return false;
    }

    void close(const Napi::CallbackInfo&) { release(); }
    void runFrame(const Napi::CallbackInfo&) {}

    void setPaused(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        {
            std::lock_guard<std::mutex> lock(gateMutex_);
            paused_ = info[0].As<Napi::Boolean>().Value();
        }
        gateCv_.notify_all();
    }

    // Both consoles in one frame: player 1's two screens, then player 2's.
    // The renderer puts those two halves side by side.
    Napi::Value frame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        constexpr size_t kPerConsole = 256 * 384;
        auto out = Napi::Uint8Array::New(info.Env(), kPerConsole * 2 * 4);
        uint8_t* pixels = out.Data();
        for (int i = 0; i < 2; i++) {
            std::lock_guard<std::mutex> lock(players_[i].screensMutex);
            const u32* source = players_[i].screens.data();
            uint8_t* target = pixels + i * kPerConsole * 4;
            for (size_t j = 0; j < kPerConsole; j++) {
                target[j * 4 + 0] = (source[j] >> 16) & 0xFF;
                target[j * 4 + 1] = (source[j] >> 8) & 0xFF;
                target[j * 4 + 2] = source[j] & 0xFF;
                target[j * 4 + 3] = 0xFF;
            }
        }
        return out;
    }

    // Same bit order as Ds::setButton, for the active console.
    void setButton(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        const int bit = info[0].As<Napi::Number>().Int32Value();
        if (bit < 0 || bit > 11) return;
        std::atomic<u32>& mask = players_[player_].keyMask;
        if (info[1].As<Napi::Boolean>().Value()) {
            mask &= ~(1u << bit);
        } else {
            mask |= 1u << bit;
        }
    }

    // touch(x, y, player): bottom-screen pixels, on the console clicked.
    void touch(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        const int player = info.Length() > 2 ? info[2].As<Napi::Number>().Int32Value() : player_;
        if (player < 0 || player > 1) return;
        const u32 x = static_cast<u32>(std::clamp(info[0].As<Napi::Number>().Int32Value(), 0, 255));
        const u32 y = static_cast<u32>(std::clamp(info[1].As<Napi::Number>().Int32Value(), 0, 191));
        players_[player].touch = kTouching | x | (y << 8);
    }

    void releaseTouch(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        for (Player& p : players_) p.touch = 0;
    }

    // Lets go of everything on the console being left behind.
    void setPlayer(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        const int player = info[0].As<Napi::Number>().Int32Value();
        if (player < 0 || player > 1) return;
        players_[player_].keyMask = 0xFFF;
        player_ = player;
    }

    // The active console only. SPU::ReadOutput takes melonDS's own audio
    // lock, so reading it from here while its thread keeps producing is
    // safe; the other console's buffer is a ring and just wraps.
    Napi::Value readAudio(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        NDS& nds = *players_[player_].nds;
        const int capacity = info[0].As<Napi::Number>().Int32Value();
        int frames = std::min(nds.SPU.GetOutputSize(), capacity);
        if (frames <= 0) return Napi::Int16Array::New(info.Env(), 0);
        std::vector<s16> samples(static_cast<size_t>(frames) * 2);
        const int read = nds.SPU.ReadOutput(samples.data(), frames);
        auto out = Napi::Int16Array::New(info.Env(), static_cast<size_t>(std::max(read, 0)) * 2);
        if (read > 0) std::copy(samples.begin(), samples.begin() + read * 2, out.Data());
        return out;
    }

    Napi::Value audioSampleRate(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), static_cast<int>(kAudioSampleRateHz));
    }
    Napi::Value width(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), 256); }
    Napi::Value height(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), 768); }

    Player players_[2];
    std::unique_ptr<LocalMP> mp_;
    std::mutex gateMutex_;
    std::condition_variable gateCv_;
    bool paused_ = false;
    std::atomic<bool> running_{false};
    int player_ = 0;
    bool loaded_ = false;
};

Napi::Object init(Napi::Env env, Napi::Object exports) {
    exports.Set("Ds", Ds::define(env));
    exports.Set("DsLink", DsLink::define(env));
    exports.Set("setLocalDir", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
                    Platform::SetLocalDir(info[0].As<Napi::String>());
                }));
    return exports;
}

}  // namespace

NODE_API_MODULE(ds_addon, init)
