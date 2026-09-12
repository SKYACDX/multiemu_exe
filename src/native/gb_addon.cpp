// N-API bridge between the Electron process and gb::GameBoy. Deliberately
// thin, mirroring the Android JNI bridge it replaces
// (app/android/gbcore/src/main/cpp/gameboy_jni.cpp in the shared repo):
// all emulation logic stays in core/gb, this file only translates types at
// the boundary.
#include <napi.h>

#include <array>
#include <cstdint>
#include <memory>
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

    std::unique_ptr<gb::GameBoy> gameBoy_;
};

Napi::Object init(Napi::Env env, Napi::Object exports) {
    exports.Set("GameBoy", GameBoy::define(env));
    exports.Set("SCREEN_WIDTH", Napi::Number::New(env, gb::kScreenWidth));
    exports.Set("SCREEN_HEIGHT", Napi::Number::New(env, gb::kScreenHeight));
    return exports;
}

}  // namespace

NODE_API_MODULE(gb_addon, init)
