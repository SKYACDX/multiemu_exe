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

#include <cstdio>
#include <memory>
#include <optional>
#include <string>
#include <vector>

#include "Args.h"
#include "NDS.h"
#include "NDSCart.h"
#include "SPI_Firmware.h"
#include "ds_platform.h"

using namespace melonDS;

namespace {

constexpr int kScreenWidth = 256;
constexpr int kScreenHeight = 192;

// Both screens are returned stacked in one image, top over bottom, so the
// renderer draws a single canvas. Touch input maps back by subtracting the
// top screen's height.
constexpr int kStackedHeight = kScreenHeight * 2;

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

        std::vector<u8> rom = ReadWholeFile(romPath);
        if (rom.empty()) {
            Napi::Error::New(env, "could not read the ROM file").ThrowAsJavaScriptException();
            return;
        }

        // ParseROM wants the cart's initial SRAM up front, not lazily.
        NDSCart::NDSCartArgs cartArgs;
        std::vector<u8> save = ReadWholeFile(savePath_);
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
        auto cart = NDSCart::ParseROM(std::move(romData), static_cast<u32>(rom.size()),
                                      &savePath_, std::move(cartArgs));
        if (!cart) {
            Napi::Error::New(env, "not a Nintendo DS ROM melonDS recognises")
                .ThrowAsJavaScriptException();
            return;
        }

        // Defaults to FreeBIOS and a generated firmware, so no copyrighted
        // BIOS dump is required...
        NDSArgs args;
        // ...except that a firmware saved by a previous session is reused.
        // Nintendo WFC settings live in the firmware rather than in any
        // cartridge, so carrying one image across sessions is what makes
        // "set the connection up once and every game has it" work, exactly
        // as on a real console.
        if (auto firmware = LoadSavedFirmware()) {
            args.Firmware = std::move(*firmware);
        }

        nds_ = std::make_unique<NDS>(std::move(args), this);
        nds_->SetNDSCart(std::move(cart));
        nds_->Reset();
        if (nds_->NeedsDirectBoot()) {
            nds_->SetupDirectBoot(savePath_.empty() ? "rom.nds" : savePath_);
        }
        nds_->Start();
        loaded_ = true;
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
    // DS KeyInput is active-low -- a set bit means "not pressed".
    u32 keyMask_ = 0xFFF;
    bool loaded_ = false;
};

Napi::Object init(Napi::Env env, Napi::Object exports) {
    exports.Set("Ds", Ds::define(env));
    exports.Set("setLocalDir", Napi::Function::New(env, [](const Napi::CallbackInfo& info) {
                    Platform::SetLocalDir(info[0].As<Napi::String>());
                }));
    return exports;
}

}  // namespace

NODE_API_MODULE(ds_addon, init)
