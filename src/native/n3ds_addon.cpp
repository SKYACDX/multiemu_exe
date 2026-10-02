// N-API bridge to Azahar, the Nintendo 3DS emulator, through its own
// libretro core (azahar_libretro.dll, built from third_party/azahar with
// ENABLE_LIBRETRO -- see `npm run build:azahar`). libretro is the interface
// Azahar ships for being embedded, so this file is a libretro frontend
// trimmed to what one console in this app needs, rather than a second copy
// of Azahar's own glue: settings, the emulation window and input mapping
// all stay in the core, as upstream maintains them.
//
// The 3DS is the one console here drawn by the GPU, not in software, so
// this frontend owns an OpenGL 4.3 core context on a hidden window, hands
// the core a framebuffer to render into, and reads each finished frame back
// as RGBA -- the same shape the other cores' frame() returns, so the
// renderer draws it the same way.
//
// One console at a time: the core keeps its emulator in globals, so the DLL
// is loaded per game and freed again on close, which also resets them.
#include <napi.h>

#include <windows.h>

#include <GL/gl.h>

#include <algorithm>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <map>
#include <string>
#include <vector>

#include "libretro.h"

namespace {

// The handful of OpenGL 3 entry points this file uses itself; opengl32.dll
// only exports 1.1, the rest come from the driver through wglGetProcAddress.
constexpr GLenum kFramebuffer = 0x8D40;          // GL_FRAMEBUFFER
constexpr GLenum kRenderbuffer = 0x8D41;         // GL_RENDERBUFFER
constexpr GLenum kColorAttachment0 = 0x8CE0;     // GL_COLOR_ATTACHMENT0
constexpr GLenum kDepthStencilAttachment = 0x821A;  // GL_DEPTH_STENCIL_ATTACHMENT
constexpr GLenum kDepth24Stencil8 = 0x88F0;      // GL_DEPTH24_STENCIL8
constexpr GLenum kFramebufferComplete = 0x8CD5;  // GL_FRAMEBUFFER_COMPLETE
constexpr GLenum kRgba8 = 0x8058;                // GL_RGBA8
constexpr GLenum kPixelPackBuffer = 0x88EB;      // GL_PIXEL_PACK_BUFFER

using BindBuffer = void(APIENTRY*)(GLenum, GLuint);
using GenFramebuffers = void(APIENTRY*)(GLsizei, GLuint*);
using BindFramebuffer = void(APIENTRY*)(GLenum, GLuint);
using FramebufferTexture2D = void(APIENTRY*)(GLenum, GLenum, GLenum, GLuint, GLint);
using GenRenderbuffers = void(APIENTRY*)(GLsizei, GLuint*);
using BindRenderbuffer = void(APIENTRY*)(GLenum, GLuint);
using RenderbufferStorage = void(APIENTRY*)(GLenum, GLenum, GLsizei, GLsizei);
using FramebufferRenderbuffer = void(APIENTRY*)(GLenum, GLenum, GLenum, GLuint);
using CheckFramebufferStatus = GLenum(APIENTRY*)(GLenum);
using DeleteFramebuffers = void(APIENTRY*)(GLsizei, const GLuint*);
using DeleteRenderbuffers = void(APIENTRY*)(GLsizei, const GLuint*);

// wglCreateContextAttribsARB and its attribute names (WGL_ARB_create_context).
using CreateContextAttribs = HGLRC(WINAPI*)(HDC, HGLRC, const int*);
constexpr int kContextMajor = 0x2091;
constexpr int kContextMinor = 0x2092;
constexpr int kContextProfileMask = 0x9126;
constexpr int kContextCoreProfile = 0x0001;

HMODULE openGl = nullptr;

// What the core is given to load OpenGL with: driver entry points first,
// then the 1.1 ones only opengl32.dll exports.
retro_proc_address_t GetGlProc(const char* name) {
    auto proc = reinterpret_cast<retro_proc_address_t>(wglGetProcAddress(name));
    // wglGetProcAddress signals failure with 0, 1, 2, 3 or -1.
    const auto value = reinterpret_cast<intptr_t>(proc);
    if (value >= -1 && value <= 3) {
        proc = reinterpret_cast<retro_proc_address_t>(GetProcAddress(openGl, name));
    }
    return proc;
}

template <typename T>
T Gl(const char* name) {
    return reinterpret_cast<T>(GetGlProc(name));
}

class N3ds;
N3ds* current = nullptr;  // the console the libretro callbacks belong to

class N3ds : public Napi::ObjectWrap<N3ds> {
   public:
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "N3ds",
                           {
                               InstanceMethod("runFrame", &N3ds::runFrame),
                               InstanceMethod("frame", &N3ds::frame),
                               InstanceMethod("setButton", &N3ds::setButton),
                               InstanceMethod("touch", &N3ds::touch),
                               InstanceMethod("releaseTouch", &N3ds::releaseTouch),
                               InstanceMethod("readAudio", &N3ds::readAudio),
                               InstanceMethod("saveState", &N3ds::saveState),
                               InstanceMethod("loadState", &N3ds::loadState),
                               InstanceMethod("close", &N3ds::close),
                               InstanceAccessor("audioSampleRate", &N3ds::audioSampleRate, nullptr),
                               InstanceAccessor("width", &N3ds::width, nullptr),
                               InstanceAccessor("height", &N3ds::height, nullptr),
                           });
    }

    // N3ds(corePath, romPath, dataDir). The core keeps the console's NAND and
    // SD card -- and so every game's save -- under dataDir/Azahar.
    explicit N3ds(const Napi::CallbackInfo& info) : Napi::ObjectWrap<N3ds>(info) {
        Napi::Env env = info.Env();
        if (current) {
            Napi::Error::New(env, "ya hay un juego de 3DS abierto").ThrowAsJavaScriptException();
            return;
        }
        const std::string corePath = info[0].As<Napi::String>();
        const std::string romPath = info[1].As<Napi::String>();
        dataDir_ = info[2].As<Napi::String>();
        // The core makes only the last level of it (dataDir/Azahar) and, if
        // that fails because dataDir is missing too, quietly falls back to
        // Azahar's own folder in AppData -- someone else's data.
        std::error_code ignored;
        std::filesystem::create_directories(std::filesystem::u8path(dataDir_), ignored);

        std::string error = start(corePath, romPath);
        if (!error.empty()) {
            stop();
            Napi::Error::New(env, error).ThrowAsJavaScriptException();
        }
    }

    ~N3ds() override { stop(); }

   private:
    // ---- libretro callbacks, routed to the open console ------------------

    static bool Environment(unsigned cmd, void* data) { return current && current->environment(cmd, data); }
    static void VideoRefresh(const void* data, unsigned width, unsigned height, size_t) {
        if (current) current->videoRefresh(data, width, height);
    }
    static void AudioSample(int16_t left, int16_t right) {
        if (!current) return;
        current->audio_.push_back(left);
        current->audio_.push_back(right);
    }
    static size_t AudioBatch(const int16_t* data, size_t frames) {
        if (current) current->audio_.insert(current->audio_.end(), data, data + frames * 2);
        return frames;
    }
    static void InputPoll() {}
    static int16_t InputState(unsigned port, unsigned device, unsigned, unsigned id) {
        return current && port == 0 ? current->inputState(device, id) : 0;
    }
    static uintptr_t CurrentFramebuffer() { return current ? current->fbo_ : 0; }
    // Warnings and errors only, unless MULTIEMU_3DS_VERBOSE is set.
    static void Log(enum retro_log_level level, const char* format, ...) {
        static const bool verbose = std::getenv("MULTIEMU_3DS_VERBOSE") != nullptr;
        if (level < RETRO_LOG_WARN && !verbose) return;
        va_list args;
        va_start(args, format);
        std::fprintf(stderr, "[azahar] ");
        std::vfprintf(stderr, format, args);
        va_end(args);
    }

    // The options this app sets; anything else is left to the core's own
    // default, which is what it does whenever an option goes unanswered.
    // The console runs in Spanish, the language of this app.
    const char* option(const char* key) {
        static const std::map<std::string, const char*> options = {
            {"citra_language_value", "Spanish"},
        };
        auto found = options.find(key);
        return found == options.end() ? nullptr : found->second;
    }

    bool environment(unsigned cmd, void* data) {
        switch (cmd) {
        case RETRO_ENVIRONMENT_GET_PREFERRED_HW_RENDER:
            *static_cast<unsigned*>(data) = RETRO_HW_CONTEXT_OPENGL_CORE;
            return true;
        case RETRO_ENVIRONMENT_SET_HW_RENDER: {
            auto* hw = static_cast<retro_hw_render_callback*>(data);
            if (hw->context_type != RETRO_HW_CONTEXT_OPENGL_CORE &&
                hw->context_type != RETRO_HW_CONTEXT_OPENGL) {
                return false;
            }
            hw->get_current_framebuffer = &N3ds::CurrentFramebuffer;
            hw->get_proc_address = &GetGlProc;
            hwRender_ = hw;
            return true;
        }
        case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
            return *static_cast<retro_pixel_format*>(data) == RETRO_PIXEL_FORMAT_XRGB8888;
        case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
            static_cast<retro_log_callback*>(data)->log = &N3ds::Log;
            return true;
        case RETRO_ENVIRONMENT_GET_SAVE_DIRECTORY:
        case RETRO_ENVIRONMENT_GET_SYSTEM_DIRECTORY:
            *static_cast<const char**>(data) = dataDir_.c_str();
            return true;
        case RETRO_ENVIRONMENT_GET_VARIABLE: {
            auto* variable = static_cast<retro_variable*>(data);
            variable->value = option(variable->key);
            return variable->value != nullptr;
        }
        case RETRO_ENVIRONMENT_GET_VARIABLE_UPDATE:
            *static_cast<bool*>(data) = false;
            return true;
        case RETRO_ENVIRONMENT_GET_CAN_DUPE:
            *static_cast<bool*>(data) = true;
            return true;
        case RETRO_ENVIRONMENT_SET_MESSAGE:
            std::fprintf(stderr, "[azahar] %s\n", static_cast<retro_message*>(data)->msg);
            return true;
        // Told, and nothing to do about it.
        case RETRO_ENVIRONMENT_SET_VARIABLES:
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS:
        case RETRO_ENVIRONMENT_SET_CORE_OPTIONS_V2:
        case RETRO_ENVIRONMENT_SET_INPUT_DESCRIPTORS:
        case RETRO_ENVIRONMENT_SET_CONTROLLER_INFO:
        case RETRO_ENVIRONMENT_SET_MEMORY_MAPS:
        case RETRO_ENVIRONMENT_SET_SERIALIZATION_QUIRKS:
        case RETRO_ENVIRONMENT_SET_HW_SHARED_CONTEXT:
        case RETRO_ENVIRONMENT_SET_GEOMETRY:
            return true;
        default:
            return false;
        }
    }

    void videoRefresh(const void* data, unsigned width, unsigned height) {
        // A duplicate (nullptr) keeps the last picture; only a frame the
        // core actually rendered into our framebuffer is read back.
        if (data != RETRO_HW_FRAME_BUFFER_VALID) return;
        width = std::min(width, fboWidth_);
        height = std::min(height, fboHeight_);
        std::vector<uint8_t> flipped(static_cast<size_t>(width) * height * 4);
        bindFramebuffer_(kFramebuffer, fbo_);
        // With a pixel-pack buffer still bound -- the core uses them for its
        // own readbacks -- glReadPixels writes into that instead, and the
        // picture comes out blank.
        bindBuffer_(kPixelPackBuffer, 0);
        glReadBuffer(kColorAttachment0);
        glPixelStorei(GL_PACK_ALIGNMENT, 1);
        glReadPixels(0, 0, width, height, GL_RGBA, GL_UNSIGNED_BYTE, flipped.data());
        // OpenGL's rows run bottom to top; a canvas's run top to bottom.
        picture_.resize(flipped.size());
        const size_t row = static_cast<size_t>(width) * 4;
        for (unsigned y = 0; y < height; y++) {
            std::memcpy(picture_.data() + y * row, flipped.data() + (height - 1 - y) * row, row);
        }
        for (size_t i = 3; i < picture_.size(); i += 4) picture_[i] = 0xFF;
        pictureWidth_ = width;
        pictureHeight_ = height;
    }

    int16_t inputState(unsigned device, unsigned id) {
        if (device == RETRO_DEVICE_JOYPAD) return (keys_ >> id) & 1;
        if (device != RETRO_DEVICE_POINTER) return 0;
        switch (id) {
        case RETRO_DEVICE_ID_POINTER_PRESSED:
            return touching_;
        // -0x7fff..0x7fff across the whole picture, the way the core's
        // MouseTracker maps it back. It ignores an exact (0, 0), the
        // "no pointer" value, so a touch dead in the centre is nudged.
        case RETRO_DEVICE_ID_POINTER_X: {
            const int x = touchX_ * 0xFFFE / static_cast<int>(std::max(1u, baseWidth_)) - 0x7FFF;
            return static_cast<int16_t>(x == 0 ? 1 : x);
        }
        case RETRO_DEVICE_ID_POINTER_Y:
            return static_cast<int16_t>(touchY_ * 0xFFFE / static_cast<int>(std::max(1u, baseHeight_)) - 0x7FFF);
        default:
            return 0;
        }
    }

    // ---- Lifetime ---------------------------------------------------------

    // The window and context the core renders with: an OpenGL 4.3 core
    // context, which is what Azahar's libretro core asks for. A hidden
    // window is the plain way to get a pixel format on Windows.
    std::string createContext() {
        openGl = LoadLibraryA("opengl32.dll");
        WNDCLASSA windowClass{};
        windowClass.lpfnWndProc = DefWindowProcA;
        windowClass.hInstance = GetModuleHandleA(nullptr);
        windowClass.lpszClassName = "multiemu-3ds-gl";
        RegisterClassA(&windowClass);
        window_ = CreateWindowA("multiemu-3ds-gl", "", WS_OVERLAPPEDWINDOW, 0, 0, 1, 1, nullptr,
                                nullptr, windowClass.hInstance, nullptr);
        if (!window_) return "no se pudo crear la ventana para OpenGL";
        dc_ = GetDC(window_);

        PIXELFORMATDESCRIPTOR format{};
        format.nSize = sizeof(format);
        format.nVersion = 1;
        format.dwFlags = PFD_DRAW_TO_WINDOW | PFD_SUPPORT_OPENGL | PFD_DOUBLEBUFFER;
        format.iPixelType = PFD_TYPE_RGBA;
        format.cColorBits = 32;
        format.cDepthBits = 24;
        format.cStencilBits = 8;
        SetPixelFormat(dc_, ChoosePixelFormat(dc_, &format), &format);

        // A legacy context first, only to reach wglCreateContextAttribsARB.
        HGLRC legacy = wglCreateContext(dc_);
        wglMakeCurrent(dc_, legacy);
        auto createAttribs = Gl<CreateContextAttribs>("wglCreateContextAttribsARB");
        const int attributes[] = {kContextMajor, 4, kContextMinor, 3, kContextProfileMask,
                                  kContextCoreProfile, 0};
        context_ = createAttribs ? createAttribs(dc_, nullptr, attributes) : nullptr;
        wglMakeCurrent(nullptr, nullptr);
        wglDeleteContext(legacy);
        if (!context_) return "esta tarjeta gráfica no ofrece OpenGL 4.3, que el 3DS necesita";
        wglMakeCurrent(dc_, context_);

        bindFramebuffer_ = Gl<BindFramebuffer>("glBindFramebuffer");
        bindBuffer_ = Gl<BindBuffer>("glBindBuffer");
        return {};
    }

    // The framebuffer the core renders into, as large as it says a frame can
    // get, with the depth and stencil the 3DS GPU emulation needs.
    std::string createFramebuffer(unsigned width, unsigned height) {
        fboWidth_ = width;
        fboHeight_ = height;
        glGenTextures(1, &texture_);
        glBindTexture(GL_TEXTURE_2D, texture_);
        glTexImage2D(GL_TEXTURE_2D, 0, kRgba8, width, height, 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr);
        Gl<GenRenderbuffers>("glGenRenderbuffers")(1, &depth_);
        Gl<BindRenderbuffer>("glBindRenderbuffer")(kRenderbuffer, depth_);
        Gl<RenderbufferStorage>("glRenderbufferStorage")(kRenderbuffer, kDepth24Stencil8, width, height);
        Gl<GenFramebuffers>("glGenFramebuffers")(1, &fbo_);
        bindFramebuffer_(kFramebuffer, fbo_);
        Gl<FramebufferTexture2D>("glFramebufferTexture2D")(kFramebuffer, kColorAttachment0, GL_TEXTURE_2D,
                                                           texture_, 0);
        Gl<FramebufferRenderbuffer>("glFramebufferRenderbuffer")(kFramebuffer, kDepthStencilAttachment,
                                                                 kRenderbuffer, depth_);
        if (Gl<CheckFramebufferStatus>("glCheckFramebufferStatus")(kFramebuffer) != kFramebufferComplete) {
            return "no se pudo preparar el framebuffer de OpenGL";
        }
        return {};
    }

    template <typename T>
    T symbol(const char* name) {
        return reinterpret_cast<T>(GetProcAddress(core_, name));
    }

    std::string start(const std::string& corePath, const std::string& romPath) {
        core_ = LoadLibraryA(corePath.c_str());
        if (!core_) return "no se encontró el núcleo de 3DS (azahar_libretro.dll)";
        retroDeinit_ = symbol<void (*)()>("retro_deinit");
        retroRun_ = symbol<void (*)()>("retro_run");
        retroUnload_ = symbol<void (*)()>("retro_unload_game");
        retroSerializeSize_ = symbol<size_t (*)()>("retro_serialize_size");
        retroSerialize_ = symbol<bool (*)(void*, size_t)>("retro_serialize");
        retroUnserialize_ = symbol<bool (*)(const void*, size_t)>("retro_unserialize");

        std::string error = createContext();
        if (!error.empty()) return error;

        current = this;
        symbol<void (*)(retro_environment_t)>("retro_set_environment")(&N3ds::Environment);
        symbol<void (*)(retro_video_refresh_t)>("retro_set_video_refresh")(&N3ds::VideoRefresh);
        symbol<void (*)(retro_audio_sample_t)>("retro_set_audio_sample")(&N3ds::AudioSample);
        symbol<void (*)(retro_audio_sample_batch_t)>("retro_set_audio_sample_batch")(&N3ds::AudioBatch);
        symbol<void (*)(retro_input_poll_t)>("retro_set_input_poll")(&N3ds::InputPoll);
        symbol<void (*)(retro_input_state_t)>("retro_set_input_state")(&N3ds::InputState);
        symbol<void (*)()>("retro_init")();
        initialized_ = true;

        retro_game_info game{};
        game.path = romPath.c_str();
        if (!symbol<bool (*)(const retro_game_info*)>("retro_load_game")(&game)) {
            return "el núcleo de 3DS no pudo cargar el juego";
        }
        loaded_ = true;
        if (!hwRender_) return "el núcleo de 3DS no pidió OpenGL";

        retro_system_av_info av{};
        symbol<void (*)(retro_system_av_info*)>("retro_get_system_av_info")(&av);
        baseWidth_ = av.geometry.base_width;
        baseHeight_ = av.geometry.base_height;
        sampleRate_ = av.timing.sample_rate;
        error = createFramebuffer(std::max(av.geometry.max_width, baseWidth_),
                                  std::max(av.geometry.max_height, baseHeight_));
        if (!error.empty()) return error;

        // The game itself is loaded here: Azahar's core waits for its
        // OpenGL context before it reads the ROM.
        hwRender_->context_reset();
        picture_.assign(static_cast<size_t>(baseWidth_) * baseHeight_ * 4, 0);
        pictureWidth_ = baseWidth_;
        pictureHeight_ = baseHeight_;
        return {};
    }

    void stop() {
        if (current != this) return;
        if (loaded_) {
            if (hwRender_ && hwRender_->context_destroy) hwRender_->context_destroy();
            retroUnload_();
        }
        if (initialized_) retroDeinit_();
        current = nullptr;
        if (fbo_) Gl<DeleteFramebuffers>("glDeleteFramebuffers")(1, &fbo_);
        if (depth_) Gl<DeleteRenderbuffers>("glDeleteRenderbuffers")(1, &depth_);
        if (texture_) glDeleteTextures(1, &texture_);
        if (context_) {
            wglMakeCurrent(nullptr, nullptr);
            wglDeleteContext(context_);
        }
        if (window_) {
            ReleaseDC(window_, dc_);
            DestroyWindow(window_);
        }
        if (core_) FreeLibrary(core_);
        core_ = nullptr;
        loaded_ = initialized_ = false;
        fbo_ = depth_ = texture_ = 0;
        context_ = nullptr;
        window_ = nullptr;
        hwRender_ = nullptr;
    }

    bool ready(Napi::Env env) {
        if (current == this && loaded_) return true;
        Napi::Error::New(env, "este juego de 3DS no está abierto").ThrowAsJavaScriptException();
        return false;
    }

    // ---- What the app calls ---------------------------------------------

    void close(const Napi::CallbackInfo&) { stop(); }

    void runFrame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        retroRun_();
    }

    Napi::Value frame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        auto out = Napi::Uint8Array::New(info.Env(), static_cast<size_t>(baseWidth_) * baseHeight_ * 4);
        // Same size every time, whatever the core drew: the renderer laid
        // its canvas out for the base geometry when the game opened.
        const unsigned width = std::min(pictureWidth_, baseWidth_);
        const unsigned height = std::min(pictureHeight_, baseHeight_);
        for (unsigned y = 0; y < height; y++) {
            std::memcpy(out.Data() + static_cast<size_t>(y) * baseWidth_ * 4,
                        picture_.data() + static_cast<size_t>(y) * pictureWidth_ * 4,
                        static_cast<size_t>(width) * 4);
        }
        return out;
    }

    // buttonId is libretro's joypad numbering (RETRO_DEVICE_ID_JOYPAD_*),
    // which Azahar's core maps onto the 3DS's buttons itself.
    void setButton(const Napi::CallbackInfo& info) {
        const int id = info[0].As<Napi::Number>().Int32Value();
        if (id < 0 || id > 15) return;
        if (info[1].As<Napi::Boolean>().Value()) {
            keys_ |= 1u << id;
        } else {
            keys_ &= ~(1u << id);
        }
    }

    // x/y in the bottom screen's cell of the picture: 0..width and
    // 0..height/2, the picture being the two screens stacked.
    void touch(const Napi::CallbackInfo& info) {
        touchX_ = info[0].As<Napi::Number>().Int32Value();
        touchY_ = info[1].As<Napi::Number>().Int32Value() + static_cast<int>(baseHeight_ / 2);
        touching_ = true;
    }

    void releaseTouch(const Napi::CallbackInfo&) { touching_ = false; }

    Napi::Value readAudio(const Napi::CallbackInfo& info) {
        const size_t capacity = static_cast<size_t>(info[0].As<Napi::Number>().Int32Value()) * 2;
        const size_t count = std::min(capacity, audio_.size()) & ~static_cast<size_t>(1);
        auto out = Napi::Int16Array::New(info.Env(), count);
        std::copy(audio_.begin(), audio_.begin() + count, out.Data());
        audio_.erase(audio_.begin(), audio_.begin() + count);
        // A queue nobody drains (the game paused, the sound off) would grow
        // for ever; a second of it is plenty to keep.
        if (audio_.size() > static_cast<size_t>(sampleRate_) * 2) audio_.clear();
        return out;
    }

    Napi::Value saveState(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        const size_t size = retroSerializeSize_();
        auto out = Napi::Uint8Array::New(info.Env(), size);
        if (!size || !retroSerialize_(out.Data(), size)) {
            Napi::Error::New(info.Env(), "no se pudo guardar el estado").ThrowAsJavaScriptException();
            return info.Env().Undefined();
        }
        return out;
    }

    Napi::Value loadState(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        auto bytes = info[0].As<Napi::Uint8Array>();
        return Napi::Boolean::New(info.Env(), retroUnserialize_(bytes.Data(), bytes.ByteLength()));
    }

    Napi::Value audioSampleRate(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), sampleRate_);
    }
    Napi::Value width(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), baseWidth_); }
    Napi::Value height(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), baseHeight_); }

    std::string dataDir_;
    HMODULE core_ = nullptr;
    void (*retroDeinit_)() = nullptr;
    void (*retroRun_)() = nullptr;
    void (*retroUnload_)() = nullptr;
    size_t (*retroSerializeSize_)() = nullptr;
    bool (*retroSerialize_)(void*, size_t) = nullptr;
    bool (*retroUnserialize_)(const void*, size_t) = nullptr;
    bool initialized_ = false;
    bool loaded_ = false;

    HWND window_ = nullptr;
    HDC dc_ = nullptr;
    HGLRC context_ = nullptr;
    retro_hw_render_callback* hwRender_ = nullptr;
    BindFramebuffer bindFramebuffer_ = nullptr;
    BindBuffer bindBuffer_ = nullptr;
    GLuint fbo_ = 0, texture_ = 0, depth_ = 0;
    unsigned fboWidth_ = 0, fboHeight_ = 0;

    unsigned baseWidth_ = 0, baseHeight_ = 0;
    double sampleRate_ = 0;
    std::vector<uint8_t> picture_;
    unsigned pictureWidth_ = 0, pictureHeight_ = 0;
    std::vector<int16_t> audio_;

    uint32_t keys_ = 0;
    bool touching_ = false;
    int touchX_ = 0, touchY_ = 0;
};

Napi::Object init(Napi::Env env, Napi::Object exports) {
    exports.Set("N3ds", N3ds::define(env));
    return exports;
}

}  // namespace

NODE_API_MODULE(n3ds_addon, init)
