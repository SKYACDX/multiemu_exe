// N-API bridge to Azahar, the Nintendo 3DS emulator, through its own
// libretro core (azahar_libretro.dll, built from third_party/azahar with
// ENABLE_LIBRETRO -- see `npm run build:azahar`). libretro is the interface
// Azahar ships for being embedded, so this file is a libretro frontend
// trimmed to what this app needs, rather than a second copy of Azahar's own
// glue: settings, the emulation window and input mapping all stay in the
// core, as upstream maintains them.
//
// The 3DS is the one console here drawn by the GPU, not in software, so
// each console gets an OpenGL 4.3 core context on a hidden window, hands
// the core a framebuffer to render into, and reads each finished frame back
// as RGBA -- the same shape the other cores' frame() returns, so the
// renderer draws it the same way.
//
// The core keeps its emulator in globals, so a console is one loaded copy of
// the DLL, loaded per game and freed again on close, which also resets them.
// Two consoles on local wireless (N3dsLink) are two copies under different
// file names: Windows loads each file as its own module, with its own
// globals -- and, the DLL being built with the static runtime, its own C++
// runtime too.
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

// Warnings and errors only, unless MULTIEMU_3DS_VERBOSE is set.
void Log(enum retro_log_level level, const char* format, ...) {
    static const bool verbose = std::getenv("MULTIEMU_3DS_VERBOSE") != nullptr;
    if (level < RETRO_LOG_WARN && !verbose) return;
    va_list args;
    va_start(args, format);
    std::fprintf(stderr, "[azahar] ");
    std::vfprintf(stderr, format, args);
    va_end(args);
}

// The first port Azahar's own rooms use, and how many after it to try when
// something else already has it.
constexpr unsigned kRoomPort = 24872;
constexpr unsigned kRoomPortTries = 10;

class Console;
// The consoles the libretro callbacks belong to, by slot. libretro callbacks
// carry no context, so each slot gets its own set (Callbacks<0>, <1>) and
// each copy of the DLL is handed the set of its slot.
Console* slots[2] = {nullptr, nullptr};

// One emulated 3DS: one loaded copy of the core, with its OpenGL context,
// framebuffer, input and audio.
class Console {
   public:
    explicit Console(int slot) : slot_(slot) {}
    ~Console() { stop(); }

    // Loads the core at corePath and the game at romPath. The console's NAND
    // and SD card -- and so every game's save -- live under dataDir/Azahar.
    // Empty on success, else what went wrong.
    std::string start(const std::string& corePath, const std::string& romPath, const std::string& dataDir);
    void stop();

    bool running() const { return loaded_; }
    void run() {
        makeCurrent();
        retroRun_();
    }
    void copyPicture(uint8_t* out) const;
    void setButton(int id, bool pressed) {
        if (id < 0 || id > 15) return;
        if (pressed) {
            keys_ |= 1u << id;
        } else {
            keys_ &= ~(1u << id);
        }
    }
    void releaseAll() { keys_ = 0; }
    // x/y in the bottom screen's cell of the picture: 0..width and
    // 0..height/2, the picture being the two screens stacked.
    void touch(int x, int y) {
        touchX_ = x;
        touchY_ = y + static_cast<int>(baseHeight_ / 2);
        touching_ = true;
    }
    void releaseTouch() { touching_ = false; }
    size_t readAudio(int16_t* out, size_t capacity);
    void dropAudio() { audio_.clear(); }
    std::vector<uint8_t> saveState();
    bool loadState(const uint8_t* data, size_t size) {
        makeCurrent();
        return retroUnserialize_(data, size);
    }

    // Local wireless, through the room calls patches/azahar/0003 adds.
    bool hostRoom(unsigned port) { return roomHost_ && roomHost_(port); }
    void joinRoom(const char* host, unsigned port, const char* nickname, const char* password) {
        if (roomJoin_) roomJoin_(host, port, nickname, password);
    }
    void leaveRoom() {
        if (roomLeave_) roomLeave_();
    }
    int roomState() const { return roomState_ ? roomState_() : -1; }
    int roomError() const { return roomError_ ? roomError_() : -1; }
    int roomMembers() const { return roomMembers_ ? roomMembers_() : 0; }

    unsigned width() const { return baseWidth_; }
    unsigned height() const { return baseHeight_; }
    double sampleRate() const { return sampleRate_; }

   private:
    template <int Slot>
    struct Callbacks {
        static bool Environment(unsigned cmd, void* data) {
            return slots[Slot] && slots[Slot]->environment(cmd, data);
        }
        static void VideoRefresh(const void* data, unsigned width, unsigned height, size_t) {
            if (slots[Slot]) slots[Slot]->videoRefresh(data, width, height);
        }
        static void AudioSample(int16_t left, int16_t right) {
            if (!slots[Slot]) return;
            slots[Slot]->audio_.push_back(left);
            slots[Slot]->audio_.push_back(right);
        }
        static size_t AudioBatch(const int16_t* data, size_t frames) {
            if (slots[Slot]) slots[Slot]->audio_.insert(slots[Slot]->audio_.end(), data, data + frames * 2);
            return frames;
        }
        static void InputPoll() {}
        static int16_t InputState(unsigned port, unsigned device, unsigned index, unsigned id) {
            return slots[Slot] && port == 0 ? slots[Slot]->inputState(device, index, id) : 0;
        }
        static uintptr_t CurrentFramebuffer() { return slots[Slot] ? slots[Slot]->fbo_ : 0; }
    };

    template <int Slot>
    void connect();

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

    bool environment(unsigned cmd, void* data);
    void videoRefresh(const void* data, unsigned width, unsigned height);
    int16_t inputState(unsigned device, unsigned index, unsigned id);
    std::string createContext();
    std::string createFramebuffer(unsigned width, unsigned height);
    void makeCurrent() {
        if (context_ && wglGetCurrentContext() != context_) wglMakeCurrent(dc_, context_);
    }

    template <typename T>
    T symbol(const char* name) {
        return reinterpret_cast<T>(GetProcAddress(core_, name));
    }

    const int slot_;
    std::string dataDir_;
    HMODULE core_ = nullptr;
    void (*retroDeinit_)() = nullptr;
    void (*retroRun_)() = nullptr;
    void (*retroUnload_)() = nullptr;
    size_t (*retroSerializeSize_)() = nullptr;
    bool (*retroSerialize_)(void*, size_t) = nullptr;
    bool (*retroUnserialize_)(const void*, size_t) = nullptr;
    bool (*roomHost_)(unsigned) = nullptr;
    void (*roomJoin_)(const char*, unsigned, const char*, const char*) = nullptr;
    void (*roomLeave_)() = nullptr;
    int (*roomState_)() = nullptr;
    int (*roomError_)() = nullptr;
    int (*roomMembers_)() = nullptr;
    bool initialized_ = false;
    bool loaded_ = false;
    bool noGame_ = false;
    std::string lastMessage_;

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

bool Console::environment(unsigned cmd, void* data) {
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
        hw->get_current_framebuffer =
            slot_ == 0 ? &Callbacks<0>::CurrentFramebuffer : &Callbacks<1>::CurrentFramebuffer;
        hw->get_proc_address = &GetGlProc;
        hwRender_ = hw;
        return true;
    }
    case RETRO_ENVIRONMENT_SET_PIXEL_FORMAT:
        return *static_cast<retro_pixel_format*>(data) == RETRO_PIXEL_FORMAT_XRGB8888;
    case RETRO_ENVIRONMENT_GET_LOG_INTERFACE:
        static_cast<retro_log_callback*>(data)->log = &Log;
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
        lastMessage_ = static_cast<retro_message*>(data)->msg;
        std::fprintf(stderr, "[azahar] %s\n", lastMessage_.c_str());
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

void Console::videoRefresh(const void* data, unsigned width, unsigned height) {
    // An empty 0x0 frame is what the core hands over when it has no game
    // running -- see start(), which uses it to notice a failed load.
    if (!data && width == 0) noGame_ = true;
    // A duplicate (nullptr) keeps the last picture; only a frame the core
    // actually rendered into our framebuffer is read back.
    if (data != RETRO_HW_FRAME_BUFFER_VALID) return;
    width = std::min(width, fboWidth_);
    height = std::min(height, fboHeight_);
    std::vector<uint8_t> flipped(static_cast<size_t>(width) * height * 4);
    bindFramebuffer_(kFramebuffer, fbo_);
    // With a pixel-pack buffer still bound -- the core uses them for its own
    // readbacks -- glReadPixels writes into that instead, and the picture
    // comes out blank.
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

int16_t Console::inputState(unsigned device, unsigned index, unsigned id) {
    if (device == RETRO_DEVICE_JOYPAD) return (keys_ >> id) & 1;
    // The Circle Pad, driven by the D-pad: plenty of 3DS games move only
    // with the stick, and a keyboard has nothing else to offer it. Libretro's
    // Y axis grows downwards.
    if (device == RETRO_DEVICE_ANALOG && index == RETRO_DEVICE_INDEX_ANALOG_LEFT) {
        const auto held = [this](unsigned button) { return static_cast<int>((keys_ >> button) & 1); };
        const int axis = id == RETRO_DEVICE_ID_ANALOG_X
                             ? held(RETRO_DEVICE_ID_JOYPAD_RIGHT) - held(RETRO_DEVICE_ID_JOYPAD_LEFT)
                             : held(RETRO_DEVICE_ID_JOYPAD_DOWN) - held(RETRO_DEVICE_ID_JOYPAD_UP);
        return static_cast<int16_t>(axis * 0x7FFF);
    }
    if (device != RETRO_DEVICE_POINTER) return 0;
    switch (id) {
    case RETRO_DEVICE_ID_POINTER_PRESSED:
        return touching_;
    // -0x7fff..0x7fff across the whole picture, the way the core's
    // MouseTracker maps it back. It ignores an exact (0, 0), the "no
    // pointer" value, so a touch dead in the centre is nudged.
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

// The window and context the core renders with: an OpenGL 4.3 core context,
// which is what Azahar's libretro core asks for. A hidden window is the
// plain way to get a pixel format on Windows.
std::string Console::createContext() {
    if (!openGl) openGl = LoadLibraryA("opengl32.dll");
    WNDCLASSA windowClass{};
    windowClass.lpfnWndProc = DefWindowProcA;
    windowClass.hInstance = GetModuleHandleA(nullptr);
    windowClass.lpszClassName = "multiemu-3ds-gl";
    RegisterClassA(&windowClass);  // fails harmlessly once it exists
    window_ = CreateWindowA("multiemu-3ds-gl", "", WS_OVERLAPPEDWINDOW, 0, 0, 1, 1, nullptr, nullptr,
                            windowClass.hInstance, nullptr);
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
    const int attributes[] = {kContextMajor, 4, kContextMinor, 3, kContextProfileMask, kContextCoreProfile, 0};
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
std::string Console::createFramebuffer(unsigned width, unsigned height) {
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
    Gl<FramebufferTexture2D>("glFramebufferTexture2D")(kFramebuffer, kColorAttachment0, GL_TEXTURE_2D, texture_, 0);
    Gl<FramebufferRenderbuffer>("glFramebufferRenderbuffer")(kFramebuffer, kDepthStencilAttachment, kRenderbuffer,
                                                             depth_);
    if (Gl<CheckFramebufferStatus>("glCheckFramebufferStatus")(kFramebuffer) != kFramebufferComplete) {
        return "no se pudo preparar el framebuffer de OpenGL";
    }
    return {};
}

template <int Slot>
void Console::connect() {
    symbol<void (*)(retro_environment_t)>("retro_set_environment")(&Callbacks<Slot>::Environment);
    symbol<void (*)(retro_video_refresh_t)>("retro_set_video_refresh")(&Callbacks<Slot>::VideoRefresh);
    symbol<void (*)(retro_audio_sample_t)>("retro_set_audio_sample")(&Callbacks<Slot>::AudioSample);
    symbol<void (*)(retro_audio_sample_batch_t)>("retro_set_audio_sample_batch")(&Callbacks<Slot>::AudioBatch);
    symbol<void (*)(retro_input_poll_t)>("retro_set_input_poll")(&Callbacks<Slot>::InputPoll);
    symbol<void (*)(retro_input_state_t)>("retro_set_input_state")(&Callbacks<Slot>::InputState);
}

std::string Console::start(const std::string& corePath, const std::string& romPath, const std::string& dataDir) {
    if (slots[slot_]) return "ya hay un juego de 3DS abierto";
    dataDir_ = dataDir;
    // The core makes only the last level of it (dataDir/Azahar) and, if
    // that fails because dataDir is missing too, quietly falls back to
    // Azahar's own folder in AppData -- someone else's data.
    std::error_code ignored;
    std::filesystem::create_directories(std::filesystem::u8path(dataDir_), ignored);

    core_ = LoadLibraryA(corePath.c_str());
    if (!core_) return "no se encontró el núcleo de 3DS (azahar_libretro.dll)";
    retroDeinit_ = symbol<void (*)()>("retro_deinit");
    retroRun_ = symbol<void (*)()>("retro_run");
    retroUnload_ = symbol<void (*)()>("retro_unload_game");
    retroSerializeSize_ = symbol<size_t (*)()>("retro_serialize_size");
    retroSerialize_ = symbol<bool (*)(void*, size_t)>("retro_serialize");
    retroUnserialize_ = symbol<bool (*)(const void*, size_t)>("retro_unserialize");
    roomHost_ = symbol<bool (*)(unsigned)>("multiemu_room_host");
    roomJoin_ = symbol<void (*)(const char*, unsigned, const char*, const char*)>("multiemu_room_join");
    roomLeave_ = symbol<void (*)()>("multiemu_room_leave");
    roomState_ = symbol<int (*)()>("multiemu_room_state");
    roomError_ = symbol<int (*)()>("multiemu_room_error");
    roomMembers_ = symbol<int (*)()>("multiemu_room_members");

    std::string error = createContext();
    if (!error.empty()) return error;

    slots[slot_] = this;
    if (slot_ == 0) {
        connect<0>();
    } else {
        connect<1>();
    }
    symbol<void (*)()>("retro_init")();
    initialized_ = true;

    retro_game_info game{};
    game.path = romPath.c_str();
    if (!symbol<bool (*)(const retro_game_info*)>("retro_load_game")(&game)) {
        return "el núcleo de 3DS no pudo cargar el juego" +
               (lastMessage_.empty() ? std::string() : " (" + lastMessage_ + ")");
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

    // The game itself is loaded here: Azahar's core waits for its OpenGL
    // context before it reads the ROM.
    hwRender_->context_reset();
    picture_.assign(static_cast<size_t>(baseWidth_) * baseHeight_ * 4, 0);
    pictureWidth_ = baseWidth_;
    pictureHeight_ = baseHeight_;

    // A game the core could not load -- an encrypted dump, a damaged file --
    // still comes back from context_reset without complaint; its first
    // frame is just empty, and the reason went out as a message. One frame
    // is enough to tell.
    retroRun_();
    if (noGame_) {
        return "el núcleo de 3DS no pudo arrancar el juego" +
               (lastMessage_.empty() ? std::string(". ¿Está cifrado?") : ": " + lastMessage_);
    }
    return {};
}

// Also tidies up after a start() that failed half way, before the console
// took its slot -- the DLL and the window are already there by then.
void Console::stop() {
    makeCurrent();
    if (slots[slot_] == this) {
        if (loaded_) {
            if (hwRender_ && hwRender_->context_destroy) hwRender_->context_destroy();
            retroUnload_();
        }
        if (initialized_) retroDeinit_();
        slots[slot_] = nullptr;
    }
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

// The last picture, at the base geometry whatever the core drew: the
// renderer laid its canvas out for that when the game opened.
void Console::copyPicture(uint8_t* out) const {
    const unsigned width = std::min(pictureWidth_, baseWidth_);
    const unsigned height = std::min(pictureHeight_, baseHeight_);
    for (unsigned y = 0; y < height; y++) {
        std::memcpy(out + static_cast<size_t>(y) * baseWidth_ * 4,
                    picture_.data() + static_cast<size_t>(y) * pictureWidth_ * 4, static_cast<size_t>(width) * 4);
    }
}

size_t Console::readAudio(int16_t* out, size_t capacity) {
    const size_t count = std::min(capacity, audio_.size()) & ~static_cast<size_t>(1);
    std::copy(audio_.begin(), audio_.begin() + count, out);
    audio_.erase(audio_.begin(), audio_.begin() + count);
    // A queue nobody drains (the game paused, the sound off) would grow for
    // ever; a second of it is plenty to keep.
    if (audio_.size() > static_cast<size_t>(sampleRate_) * 2) audio_.clear();
    return count;
}

std::vector<uint8_t> Console::saveState() {
    makeCurrent();
    std::vector<uint8_t> state(retroSerializeSize_());
    if (state.empty() || !retroSerialize_(state.data(), state.size())) state.clear();
    return state;
}

// ---- One console -------------------------------------------------------

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
                               InstanceMethod("joinRoom", &N3ds::joinRoom),
                               InstanceMethod("leaveRoom", &N3ds::leaveRoom),
                               InstanceMethod("roomStatus", &N3ds::roomStatus),
                               InstanceMethod("close", &N3ds::close),
                               InstanceAccessor("audioSampleRate", &N3ds::audioSampleRate, nullptr),
                               InstanceAccessor("width", &N3ds::width, nullptr),
                               InstanceAccessor("height", &N3ds::height, nullptr),
                           });
    }

    // N3ds(corePath, romPath, dataDir).
    explicit N3ds(const Napi::CallbackInfo& info) : Napi::ObjectWrap<N3ds>(info), console_(0) {
        std::string error = console_.start(info[0].As<Napi::String>(), info[1].As<Napi::String>(),
                                           info[2].As<Napi::String>());
        if (!error.empty()) {
            console_.stop();
            Napi::Error::New(info.Env(), error).ThrowAsJavaScriptException();
        }
    }

   private:
    bool ready(Napi::Env env) {
        if (console_.running()) return true;
        Napi::Error::New(env, "este juego de 3DS no está abierto").ThrowAsJavaScriptException();
        return false;
    }

    void close(const Napi::CallbackInfo&) { console_.stop(); }

    void runFrame(const Napi::CallbackInfo& info) {
        if (ready(info.Env())) console_.run();
    }

    Napi::Value frame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        auto out = Napi::Uint8Array::New(info.Env(), static_cast<size_t>(console_.width()) * console_.height() * 4);
        console_.copyPicture(out.Data());
        return out;
    }

    // buttonId is libretro's joypad numbering (RETRO_DEVICE_ID_JOYPAD_*),
    // which Azahar's core maps onto the 3DS's buttons itself.
    void setButton(const Napi::CallbackInfo& info) {
        console_.setButton(info[0].As<Napi::Number>().Int32Value(), info[1].As<Napi::Boolean>().Value());
    }

    void touch(const Napi::CallbackInfo& info) {
        console_.touch(info[0].As<Napi::Number>().Int32Value(), info[1].As<Napi::Number>().Int32Value());
    }

    void releaseTouch(const Napi::CallbackInfo&) { console_.releaseTouch(); }

    Napi::Value readAudio(const Napi::CallbackInfo& info) {
        std::vector<int16_t> buffer(static_cast<size_t>(info[0].As<Napi::Number>().Int32Value()) * 2);
        const size_t count = console_.readAudio(buffer.data(), buffer.size());
        auto out = Napi::Int16Array::New(info.Env(), count);
        std::copy(buffer.begin(), buffer.begin() + count, out.Data());
        return out;
    }

    Napi::Value saveState(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        std::vector<uint8_t> state = console_.saveState();
        if (state.empty()) {
            Napi::Error::New(info.Env(), "no se pudo guardar el estado").ThrowAsJavaScriptException();
            return info.Env().Undefined();
        }
        auto out = Napi::Uint8Array::New(info.Env(), state.size());
        std::copy(state.begin(), state.end(), out.Data());
        return out;
    }

    Napi::Value loadState(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        auto bytes = info[0].As<Napi::Uint8Array>();
        return Napi::Boolean::New(info.Env(), console_.loadState(bytes.Data(), bytes.ByteLength()));
    }

    // Local wireless with another PC or phone: joinRoom(host, port, nickname,
    // password) joins a room server, and the game's local wireless then sees
    // everyone in that room. Joining finishes on the room's own threads, so
    // roomStatus is polled: state is Network::RoomMember::State (3 joined,
    // 4 joined as moderator, 1 not in a room), error its Error (-1 none).
    void joinRoom(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        console_.joinRoom(info[0].As<Napi::String>().Utf8Value().c_str(), info[1].As<Napi::Number>().Uint32Value(),
                          info[2].As<Napi::String>().Utf8Value().c_str(),
                          info[3].As<Napi::String>().Utf8Value().c_str());
    }

    void leaveRoom(const Napi::CallbackInfo&) {
        if (console_.running()) console_.leaveRoom();
    }

    Napi::Value roomStatus(const Napi::CallbackInfo& info) {
        auto out = Napi::Object::New(info.Env());
        const bool on = console_.running();
        out.Set("state", on ? console_.roomState() : -1);
        out.Set("error", on ? console_.roomError() : -1);
        out.Set("members", on ? console_.roomMembers() : 0);
        return out;
    }

    Napi::Value audioSampleRate(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), console_.sampleRate());
    }
    Napi::Value width(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), console_.width()); }
    Napi::Value height(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), console_.height()); }

    Console console_;
};

// ---- Two consoles on local wireless ------------------------------------
//
// For trades, battles and anything else a 3DS game does over local
// wireless: two consoles in this process, each its own copy of the core and
// its own NAND and SD card (so its own saves and console ID), joined
// through a multiplayer room on the loopback that the first one hosts.
//
// One keyboard, two players, like the other links: buttons and sound go to
// the active console (setPlayer), touch to whichever screen was clicked.
// Both run on this thread, one frame each per runFrame.
class N3dsLink : public Napi::ObjectWrap<N3dsLink> {
   public:
    static Napi::Function define(Napi::Env env) {
        return DefineClass(env, "N3dsLink",
                           {
                               InstanceMethod("runFrame", &N3dsLink::runFrame),
                               InstanceMethod("frame", &N3dsLink::frame),
                               InstanceMethod("setButton", &N3dsLink::setButton),
                               InstanceMethod("setPlayer", &N3dsLink::setPlayer),
                               InstanceMethod("touch", &N3dsLink::touch),
                               InstanceMethod("releaseTouch", &N3dsLink::releaseTouch),
                               InstanceMethod("readAudio", &N3dsLink::readAudio),
                               InstanceMethod("roomMembers", &N3dsLink::roomMembers),
                               InstanceMethod("close", &N3dsLink::close),
                               InstanceAccessor("audioSampleRate", &N3dsLink::audioSampleRate, nullptr),
                               InstanceAccessor("width", &N3dsLink::width, nullptr),
                               InstanceAccessor("height", &N3dsLink::height, nullptr),
                           });
    }

    // N3dsLink(corePathA, romA, dataDirA, corePathB, romB, dataDirB). The two
    // core paths must be different files, or Windows hands back the same
    // module and the two consoles would be one.
    explicit N3dsLink(const Napi::CallbackInfo& info)
        : Napi::ObjectWrap<N3dsLink>(info), consoles_{Console(0), Console(1)} {
        Napi::Env env = info.Env();
        for (int i = 0; i < 2; i++) {
            std::string error = consoles_[i].start(info[i * 3].As<Napi::String>(), info[i * 3 + 1].As<Napi::String>(),
                                                   info[i * 3 + 2].As<Napi::String>());
            if (!error.empty()) {
                release();
                Napi::Error::New(env, "Jugador " + std::to_string(i + 1) + ": " + error).ThrowAsJavaScriptException();
                return;
            }
        }
        // The first console's room, on the first free port of a few.
        unsigned port = 0;
        for (unsigned p = kRoomPort; p < kRoomPort + kRoomPortTries && !port; p++) {
            if (consoles_[0].hostRoom(p)) port = p;
        }
        if (!port) {
            release();
            Napi::Error::New(env, "no se pudo abrir la sala de la conexión local").ThrowAsJavaScriptException();
            return;
        }
        // Joining takes a moment on the room's own threads; roomMembers
        // reports when both are in.
        consoles_[0].joinRoom("127.0.0.1", port, "Jugador 1", "");
        consoles_[1].joinRoom("127.0.0.1", port, "Jugador 2", "");
    }

   private:
    void release() {
        consoles_[0].stop();
        consoles_[1].stop();
    }

    bool ready(Napi::Env env) {
        if (consoles_[0].running() && consoles_[1].running()) return true;
        Napi::Error::New(env, "la conexión de 3DS no está abierta").ThrowAsJavaScriptException();
        return false;
    }

    void close(const Napi::CallbackInfo&) { release(); }

    void runFrame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return;
        consoles_[0].run();
        consoles_[1].run();
    }

    // Both consoles, each its two screens stacked, player 1's then player
    // 2's -- the renderer puts them side by side.
    Napi::Value frame(const Napi::CallbackInfo& info) {
        if (!ready(info.Env())) return info.Env().Undefined();
        const size_t one = static_cast<size_t>(consoles_[0].width()) * consoles_[0].height() * 4;
        auto out = Napi::Uint8Array::New(info.Env(), one * 2);
        consoles_[0].copyPicture(out.Data());
        consoles_[1].copyPicture(out.Data() + one);
        return out;
    }

    void setButton(const Napi::CallbackInfo& info) {
        consoles_[player_].setButton(info[0].As<Napi::Number>().Int32Value(), info[1].As<Napi::Boolean>().Value());
    }

    // Lets go of everything on the console being left behind.
    void setPlayer(const Napi::CallbackInfo& info) {
        const int player = info[0].As<Napi::Number>().Int32Value();
        if (player < 0 || player > 1) return;
        consoles_[player_].releaseAll();
        player_ = player;
    }

    // touch(x, y, player): the bottom screen of whichever console was clicked.
    void touch(const Napi::CallbackInfo& info) {
        const int player = info.Length() > 2 ? info[2].As<Napi::Number>().Int32Value() : player_;
        if (player < 0 || player > 1) return;
        consoles_[1 - player].releaseTouch();
        consoles_[player].touch(info[0].As<Napi::Number>().Int32Value(), info[1].As<Napi::Number>().Int32Value());
    }

    void releaseTouch(const Napi::CallbackInfo&) {
        consoles_[0].releaseTouch();
        consoles_[1].releaseTouch();
    }

    // The active console's sound; the other's is dropped.
    Napi::Value readAudio(const Napi::CallbackInfo& info) {
        std::vector<int16_t> buffer(static_cast<size_t>(info[0].As<Napi::Number>().Int32Value()) * 2);
        const size_t count = consoles_[player_].readAudio(buffer.data(), buffer.size());
        consoles_[1 - player_].dropAudio();
        auto out = Napi::Int16Array::New(info.Env(), count);
        std::copy(buffer.begin(), buffer.begin() + count, out.Data());
        return out;
    }

    // How many consoles are in the room as the first one sees it: 2 once
    // both have joined.
    Napi::Value roomMembers(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), consoles_[0].roomMembers());
    }

    Napi::Value audioSampleRate(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), consoles_[0].sampleRate());
    }
    Napi::Value width(const Napi::CallbackInfo& info) { return Napi::Number::New(info.Env(), consoles_[0].width()); }
    // Both consoles' pictures, one under the other.
    Napi::Value height(const Napi::CallbackInfo& info) {
        return Napi::Number::New(info.Env(), consoles_[0].height() * 2);
    }

    Console consoles_[2];
    int player_ = 0;
};

Napi::Object init(Napi::Env env, Napi::Object exports) {
    exports.Set("N3ds", N3ds::define(env));
    exports.Set("N3dsLink", N3dsLink::define(env));
    return exports;
}

}  // namespace

NODE_API_MODULE(n3ds_addon, init)
