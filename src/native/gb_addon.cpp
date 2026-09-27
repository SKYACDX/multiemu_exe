// N-API bridge between the Electron process and gb::GameBoy. Deliberately
// thin, mirroring the Android JNI bridge it replaces
// (app/android/gbcore/src/main/cpp/gameboy_jni.cpp in the shared repo):
// all emulation logic stays in core/gb, this file only translates types at
// the boundary.
#include <napi.h>

#include <algorithm>
#include <array>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

#include "gb/cartridge.h"
#include "gb/gameboy.h"

namespace {

// DMG shade (0=lightest..3=darkest) -> RGBA bytes, laid out so the result
// drops straight into a canvas ImageData with no further conversion. Same
// four-shades-of-gray palette as the Android bridge; a real DMG-green one
// can replace it here without touching core/gb.
constexpr uint8_t kPalette[4][4] = {
    {0xFF, 0xFF, 0xFF, 0xFF},
    {0xAA, 0xAA, 0xAA, 0xFF},
    {0x55, 0x55, 0x55, 0xFF},
    {0x00, 0x00, 0x00, 0xFF},
};

class GameBoy : public Napi::ObjectWrap<GameBoy> {
   public:
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "GameBoy",
                           {
                               InstanceMethod("runFrame", &GameBoy::runFrame),
                               InstanceMethod("frame", &GameBoy::frame),
                               InstanceMethod("setButton", &GameBoy::setButton),
                               InstanceMethod("hasBattery", &GameBoy::hasBattery),
                               InstanceMethod("getSave", &GameBoy::getSave),
                               InstanceMethod("loadSave", &GameBoy::loadSave),
                               InstanceMethod("readAudio", &GameBoy::readAudio),
                               InstanceAccessor("audioSampleRate", &GameBoy::audioSampleRate, nullptr),
                               InstanceMethod("close", &GameBoy::close),
                               InstanceAccessor("width", &GameBoy::width, nullptr),
                               InstanceAccessor("height", &GameBoy::height, nullptr),
                           });
    }

    explicit GameBoy(const Napi::CallbackInfo& info) : Napi::ObjectWrap<GameBoy>(info) {
        Napi::Env env = info.Env();
        if (info.Length() < 1 || !info[0].IsTypedArray()) {
            Napi::TypeError::New(env, "GameBoy(rom): rom must be a Uint8Array")
                .ThrowAsJavaScriptException();
            return;
        }

        auto bytes = info[0].As<Napi::Uint8Array>();
        std::vector<gb::u8> rom(bytes.Data(), bytes.Data() + bytes.ByteLength());

        auto cartridge = gb::loadCartridge(std::move(rom));
        if (!cartridge) {
            // gb::loadCartridge returns null both for a malformed header and
            // for a mapper core/gb hasn't implemented yet (MBC2/3/5) -- the
            // caller can't tell which apart, and doesn't need to.
            Napi::Error::New(env, "invalid ROM header, or a mapper the core doesn't support yet")
                .ThrowAsJavaScriptException();
            return;
        }
        gameBoy_ = std::make_unique<gb::GameBoy>(std::move(cartridge));
    }

    // Nothing here holds an OS handle, but every core answers close() so
    // the layer above doesn't have to know which ones do.
    void close(const Napi::CallbackInfo&) { gameBoy_.reset(); }

   private:
    void runFrame(const Napi::CallbackInfo&) { gameBoy_->runUntilFrame(); }

    // Returns a fresh RGBA Uint8Array (160*144*4 bytes) every call rather
    // than reusing one buffer: contextBridge copies whatever crosses into
    // the renderer anyway, so a reused buffer would save nothing.
    Napi::Value frame(const Napi::CallbackInfo& info) {
        const auto& framebuffer = gameBoy_->framebuffer();
        auto out = Napi::Uint8Array::New(info.Env(), framebuffer.size() * 4);

        uint8_t* pixels = out.Data();
        for (std::size_t i = 0; i < framebuffer.size(); i++) {
            const uint8_t* shade = kPalette[framebuffer[i] & 0x03];
            pixels[i * 4 + 0] = shade[0];
            pixels[i * 4 + 1] = shade[1];
            pixels[i * 4 + 2] = shade[2];
            pixels[i * 4 + 3] = shade[3];
        }
        return out;
    }

    // buttonId is the ordinal of gb::Button (joypad.h):
    // 0=Right 1=Left 2=Up 3=Down 4=A 5=B 6=Select 7=Start.
    void setButton(const Napi::CallbackInfo& info) {
        int buttonId = info[0].As<Napi::Number>().Int32Value();
        if (buttonId < 0 || buttonId > 7) {
            Napi::RangeError::New(info.Env(), "buttonId must be 0-7")
                .ThrowAsJavaScriptException();
            return;
        }
        gameBoy_->setButtonPressed(static_cast<gb::Button>(buttonId),
                                   info[1].As<Napi::Boolean>().Value());
    }

    Napi::Value hasBattery(const Napi::CallbackInfo& info) {
        return Napi::Boolean::New(info.Env(), gameBoy_->bus().cartridge().hasBattery());
    }

    // Empty for a cartridge with no external RAM. Only worth persisting
    // when hasBattery() is true -- without a battery, real hardware loses
    // it on power-off too.
    Napi::Value getSave(const Napi::CallbackInfo& info) {
        const auto& ram = gameBoy_->bus().cartridge().ram();
        auto out = Napi::Uint8Array::New(info.Env(), ram.size());
        std::copy(ram.begin(), ram.end(), out.Data());
        return out;
    }

    void loadSave(const Napi::CallbackInfo& info) {
        auto bytes = info[0].As<Napi::Uint8Array>();
        std::vector<gb::u8> ram(bytes.Data(), bytes.Data() + bytes.ByteLength());
        gameBoy_->bus().cartridge().loadRam(ram);
    }

    // Whatever the APU has synthesised since the last call, as interleaved
    // stereo at gb::Apu::kSampleRate -- the same shape and the same 48kHz
    // the mGBA and melonDS bridges produce, so one audio path serves all
    // three consoles.
    Napi::Value readAudio(const Napi::CallbackInfo& info) {
        int capacity = info[0].As<Napi::Number>().Int32Value();
        if (capacity <= 0) return Napi::Int16Array::New(info.Env(), 0);

        std::vector<gb::i16> buffer(static_cast<std::size_t>(capacity) * 2);
        const int frames = gameBoy_->readAudio(buffer.data(), capacity);
        if (frames <= 0) return Napi::Int16Array::New(info.Env(), 0);

        auto out = Napi::Int16Array::New(info.Env(), static_cast<size_t>(frames) * 2);
        std::copy(buffer.begin(), buffer.begin() + frames * 2, out.Data());
        return out;
    }

    Napi::Value audioSampleRate(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), gb::Apu::kSampleRate);
    }

    // Constant for the DMG, but exposed per-instance so every core in this
    // app answers the same question the same way (mGBA's dimensions are a
    // property of the loaded core, not a compile-time constant).
    Napi::Value width(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), gb::kScreenWidth);
    }
    Napi::Value height(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), gb::kScreenHeight);
    }

    std::unique_ptr<gb::GameBoy> gameBoy_;
};

// Two Game Boys on a link cable, for trading and link battles.
//
// Unlike the GBA and DS links there are no threads here, on purpose. A DMG
// is cheap enough to run two on this thread, and running them on one
// thread is what makes the cable exact: whichever console is behind in
// cycles takes the next instruction, so the two are never more than one
// instruction apart when a byte crosses (gb::Serial swaps whole bytes at a
// single moment and relies on exactly that).
//
// One keyboard, two players, like the other links: buttons and sound go to
// the active console (setPlayer).
class GbLink : public Napi::ObjectWrap<GbLink> {
   public:
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "GbLink",
                           {
                               InstanceMethod("runFrame", &GbLink::runFrame),
                               InstanceMethod("frame", &GbLink::frame),
                               InstanceMethod("setButton", &GbLink::setButton),
                               InstanceMethod("readAudio", &GbLink::readAudio),
                               InstanceMethod("setPlayer", &GbLink::setPlayer),
                               InstanceMethod("hasBattery", &GbLink::hasBattery),
                               InstanceMethod("getSave", &GbLink::getSave),
                               InstanceMethod("loadSave", &GbLink::loadSave),
                               InstanceMethod("close", &GbLink::close),
                               InstanceAccessor("audioSampleRate", &GbLink::audioSampleRate, nullptr),
                               InstanceAccessor("width", &GbLink::width, nullptr),
                               InstanceAccessor("height", &GbLink::height, nullptr),
                           });
    }

    // GbLink(romA, romB). Saves are the preload's job, as for a single
    // Game Boy: getSave/loadSave take the player first.
    explicit GbLink(const Napi::CallbackInfo& info) : Napi::ObjectWrap<GbLink>(info) {
        Napi::Env env = info.Env();
        if (info.Length() < 2 || !info[0].IsTypedArray() || !info[1].IsTypedArray()) {
            Napi::TypeError::New(env, "GbLink(romA, romB)").ThrowAsJavaScriptException();
            return;
        }
        for (int i = 0; i < 2; i++) {
            auto bytes = info[i].As<Napi::Uint8Array>();
            auto cartridge =
                gb::loadCartridge(std::vector<gb::u8>(bytes.Data(), bytes.Data() + bytes.ByteLength()));
            if (!cartridge) {
                consoles_[0].reset();
                Napi::Error::New(env, "Jugador " + std::to_string(i + 1) +
                                          ": ROM no válida, o de un mapper que el núcleo aún no soporta")
                    .ThrowAsJavaScriptException();
                return;
            }
            consoles_[i] = std::make_unique<gb::GameBoy>(std::move(cartridge));
        }
        consoles_[0]->bus().serial().connect(&consoles_[1]->bus().serial());
    }

   private:
    bool ready(Napi::Env env) {
        if (consoles_[0] && consoles_[1]) return true;
        Napi::Error::New(env, "this link cable failed to start").ThrowAsJavaScriptException();
        return false;
    }

    void close(const Napi::CallbackInfo&) {
        consoles_[0].reset();
        consoles_[1].reset();
    }

    // Until both consoles have finished a frame. A console that gets there
    // first keeps going only as long as it is the one behind, so it may
    // start its next frame by an instruction or two; its finished picture
    // is kept aside the moment it completes, not read back later.
    void runFrame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        bool done[2] = {false, false};
        while (!done[0] || !done[1]) {
            const int i = cycles_[0] <= cycles_[1] ? 0 : 1;
            cycles_[i] += consoles_[i]->step() * 4;
            if (consoles_[i]->frameReady()) {
                pictures_[i] = consoles_[i]->framebuffer();
                done[i] = true;
            }
        }
    }

    // Both screens, player 1's then player 2's, which the renderer puts
    // side by side.
    Napi::Value frame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        const std::size_t pixelsPerScreen = pictures_[0].size();
        auto out = Napi::Uint8Array::New(info.Env(), pixelsPerScreen * 2 * 4);
        uint8_t* pixels = out.Data();
        for (int i = 0; i < 2; i++) {
            for (std::size_t j = 0; j < pixelsPerScreen; j++) {
                const uint8_t* shade = kPalette[pictures_[i][j] & 0x03];
                std::copy(shade, shade + 4, pixels + (i * pixelsPerScreen + j) * 4);
            }
        }
        return out;
    }

    void setButton(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        const int buttonId = info[0].As<Napi::Number>().Int32Value();
        if (buttonId < 0 || buttonId > 7) return;
        consoles_[player_]->setButtonPressed(static_cast<gb::Button>(buttonId),
                                             info[1].As<Napi::Boolean>().Value());
    }

    // Lets go of everything on the console being left behind.
    void setPlayer(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        const int player = info[0].As<Napi::Number>().Int32Value();
        if (player < 0 || player > 1) return;
        for (int buttonId = 0; buttonId <= 7; buttonId++) {
            consoles_[player_]->setButtonPressed(static_cast<gb::Button>(buttonId), false);
        }
        player_ = player;
    }

    // The active console only; the other one's queue fills up and drops.
    Napi::Value readAudio(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        const int capacity = info[0].As<Napi::Number>().Int32Value();
        if (capacity <= 0) return Napi::Int16Array::New(info.Env(), 0);
        std::vector<gb::i16> buffer(static_cast<std::size_t>(capacity) * 2);
        const int frames = consoles_[player_]->readAudio(buffer.data(), capacity);
        auto out = Napi::Int16Array::New(info.Env(), static_cast<size_t>(std::max(frames, 0)) * 2);
        if (frames > 0) std::copy(buffer.begin(), buffer.begin() + frames * 2, out.Data());
        return out;
    }

    gb::GameBoy* console(const Napi::CallbackInfo& info) {
        const int player = info[0].As<Napi::Number>().Int32Value();
        return (player == 0 || player == 1) ? consoles_[player].get() : nullptr;
    }

    Napi::Value hasBattery(const Napi::CallbackInfo& info) {
        gb::GameBoy* gameBoy = console(info);
        return Napi::Boolean::New(info.Env(), gameBoy && gameBoy->bus().cartridge().hasBattery());
    }

    Napi::Value getSave(const Napi::CallbackInfo& info) {
        gb::GameBoy* gameBoy = console(info);
        if (!gameBoy) return Napi::Uint8Array::New(info.Env(), 0);
        const auto& ram = gameBoy->bus().cartridge().ram();
        auto out = Napi::Uint8Array::New(info.Env(), ram.size());
        std::copy(ram.begin(), ram.end(), out.Data());
        return out;
    }

    void loadSave(const Napi::CallbackInfo& info) {
        gb::GameBoy* gameBoy = console(info);
        if (!gameBoy) return;
        auto bytes = info[1].As<Napi::Uint8Array>();
        gameBoy->bus().cartridge().loadRam(std::vector<gb::u8>(bytes.Data(), bytes.Data() + bytes.ByteLength()));
    }

    Napi::Value audioSampleRate(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), gb::Apu::kSampleRate);
    }
    Napi::Value width(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), gb::kScreenWidth);
    }
    Napi::Value height(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), gb::kScreenHeight * 2);
    }

    std::unique_ptr<gb::GameBoy> consoles_[2];
    // T-cycles each console has run, which decides who steps next.
    long long cycles_[2] = {0, 0};
    gb::Ppu::Framebuffer pictures_[2] = {};
    int player_ = 0;
};

Napi::Object init(Napi::Env env, Napi::Object exports) {
    exports.Set("GameBoy", GameBoy::define(env));
    exports.Set("GbLink", GbLink::define(env));
    return exports;
}

}  // namespace

NODE_API_MODULE(gb_addon, init)
