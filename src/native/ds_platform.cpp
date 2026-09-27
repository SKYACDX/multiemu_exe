// Implements melonDS's Platform:: interface (third_party/melonds/src/Platform.h)
// for Windows. Unlike mGBA, which ships a complete frontend-agnostic C API,
// melonDS's core declares a whole namespace it expects the frontend to
// provide: file I/O, threading primitives, logging, and save/firmware
// persistence.
//
// This is a port of the Android version in the shared repo
// (app/android/dscore/src/main/cpp/ds_platform.cpp) -- which is already
// Qt-free, unlike melonDS's own reference implementation -- with the four
// things that were genuinely Android-specific swapped out: logging, POSIX
// semaphores, dlopen, and the local directory.
//
// Internet play goes through libslirp (Net_*), local wireless between two
// consoles through melonDS's own LocalMP (MP_*). The DSi-only peripherals
// are stubbed as safe no-ops.
#include "Platform.h"
#include "SPI_Firmware.h"

#include "LocalMP.h"
#include "Net.h"
#include "Net_Slirp.h"
#include "ds_platform.h"

#include <windows.h>

#include <chrono>
#include <cstdarg>
#include <cstdio>
#include <cstring>
#include <memory>
#include <mutex>
#include <semaphore>
#include <string>
#include <thread>
#include <vector>

namespace melonDS::Platform {

// Set once at startup from the addon, to somewhere writable that survives
// restarts (Electron's userData directory). The firmware image lives here.
static std::string g_localDir;

void SetLocalDir(const std::string& dir) { g_localDir = dir; }

// extern, because a namespace-scope `const` has internal linkage by default
// and ds_addon.cpp links against this.
extern const char* const kFirmwareFileName = "firmware.bin";

std::string GetLocalFilePath(const std::string& filename) { return g_localDir + "/" + filename; }

// ---- File I/O -- FileHandle is just a FILE* in a trench coat. ----

struct FileHandle {
    FILE* f;
};

static const char* ModeString(FileMode mode) {
    bool read = mode & Read, write = mode & Write, append = mode & Append;
    bool preserveExisting = (mode & Preserve) && (mode & NoCreate);
    if (append) return (mode & Text) ? "a" : "ab";
    if (read && write) return preserveExisting ? "r+b" : "w+b";
    if (write) return (mode & Text) ? "w" : "wb";
    return (mode & Text) ? "r" : "rb";
}

FileHandle* OpenFile(const std::string& path, FileMode mode) {
    if (!(mode & Read) && !(mode & Write)) return nullptr;
    if ((mode & Write) && (mode & Preserve) && (mode & NoCreate)) {
        // ReadWriteExisting-style: don't create, don't truncate.
        FILE* probe = fopen(path.c_str(), "rb");
        if (!probe) return nullptr;
        fclose(probe);
    }
    FILE* f = fopen(path.c_str(), ModeString(mode));
    if (!f) return nullptr;
    return new FileHandle{f};
}

FileHandle* OpenLocalFile(const std::string& path, FileMode mode) {
    return OpenFile(GetLocalFilePath(path), mode);
}

bool FileExists(const std::string& name) {
    FILE* f = fopen(name.c_str(), "rb");
    if (!f) return false;
    fclose(f);
    return true;
}

bool LocalFileExists(const std::string& name) { return FileExists(GetLocalFilePath(name)); }

bool CheckFileWritable(const std::string& filepath) {
    FILE* f = fopen(filepath.c_str(), "ab");
    if (!f) return false;
    fclose(f);
    return true;
}

bool CheckLocalFileWritable(const std::string& filepath) {
    return CheckFileWritable(GetLocalFilePath(filepath));
}

bool CloseFile(FileHandle* file) {
    if (!file) return false;
    bool ok = fclose(file->f) == 0;
    delete file;
    return ok;
}

bool IsEndOfFile(FileHandle* file) { return feof(file->f) != 0; }

bool FileReadLine(char* str, int count, FileHandle* file) {
    return fgets(str, count, file->f) != nullptr;
}

u64 FilePosition(FileHandle* file) { return static_cast<u64>(_ftelli64(file->f)); }

bool FileSeek(FileHandle* file, s64 offset, FileSeekOrigin origin) {
    int whence = origin == FileSeekOrigin::Start     ? SEEK_SET
                 : origin == FileSeekOrigin::Current ? SEEK_CUR
                                                     : SEEK_END;
    // _fseeki64, not fseek: NDS ROM images run to 512MB, past what MSVC's
    // 32-bit long offset can address.
    return _fseeki64(file->f, offset, whence) == 0;
}

void FileRewind(FileHandle* file) { rewind(file->f); }

u64 FileRead(void* data, u64 size, u64 count, FileHandle* file) {
    return fread(data, size, count, file->f);
}

bool FileFlush(FileHandle* file) { return fflush(file->f) == 0; }

u64 FileWrite(const void* data, u64 size, u64 count, FileHandle* file) {
    return fwrite(data, size, count, file->f);
}

u64 FileWriteFormatted(FileHandle* file, const char* fmt, ...) {
    va_list args;
    va_start(args, fmt);
    int n = vfprintf(file->f, fmt, args);
    va_end(args);
    return n < 0 ? 0 : static_cast<u64>(n);
}

u64 FileLength(FileHandle* file) {
    long long pos = _ftelli64(file->f);
    _fseeki64(file->f, 0, SEEK_END);
    long long len = _ftelli64(file->f);
    _fseeki64(file->f, pos, SEEK_SET);
    return static_cast<u64>(len);
}

// ---- Logging ----

void Log(LogLevel level, const char* fmt, ...) {
    const char* tag = level == LogLevel::Debug  ? "debug"
                      : level == LogLevel::Info ? "info"
                      : level == LogLevel::Warn ? "warn"
                                                : "error";
    fprintf(stderr, "[melonDS %s] ", tag);
    va_list args;
    va_start(args, fmt);
    vfprintf(stderr, fmt, args);
    va_end(args);
}

// ---- Threading ----

struct Thread {
    std::thread t;
};

Thread* Thread_Create(std::function<void()> func) { return new Thread{std::thread(std::move(func))}; }

void Thread_Free(Thread* thread) {
    if (thread->t.joinable()) thread->t.detach();
    delete thread;
}

void Thread_Wait(Thread* thread) {
    if (thread->t.joinable()) thread->t.join();
}

// std::counting_semaphore rather than the Android version's POSIX sem_t,
// which MSVC has no equivalent for. try_acquire_for covers the timed wait
// that needed sem_timedwait and a hand-built timespec there.
struct Semaphore {
    std::counting_semaphore<> sem{0};
};

Semaphore* Semaphore_Create() { return new Semaphore(); }
void Semaphore_Free(Semaphore* sema) { delete sema; }

void Semaphore_Reset(Semaphore* sema) {
    while (sema->sem.try_acquire()) {
    }
}

void Semaphore_Wait(Semaphore* sema) { sema->sem.acquire(); }

bool Semaphore_TryWait(Semaphore* sema, int timeout_ms) {
    if (timeout_ms <= 0) return sema->sem.try_acquire();
    return sema->sem.try_acquire_for(std::chrono::milliseconds(timeout_ms));
}

void Semaphore_Post(Semaphore* sema, int count) { sema->sem.release(count); }

struct Mutex {
    std::mutex m;
};

Mutex* Mutex_Create() { return new Mutex(); }
void Mutex_Free(Mutex* mutex) { delete mutex; }
void Mutex_Lock(Mutex* mutex) { mutex->m.lock(); }
void Mutex_Unlock(Mutex* mutex) { mutex->m.unlock(); }
bool Mutex_TryLock(Mutex* mutex) { return mutex->m.try_lock(); }

void Sleep(u64 usecs) { std::this_thread::sleep_for(std::chrono::microseconds(usecs)); }

u64 GetMSCount() {
    using namespace std::chrono;
    return duration_cast<milliseconds>(steady_clock::now().time_since_epoch()).count();
}

u64 GetUSCount() {
    using namespace std::chrono;
    return duration_cast<microseconds>(steady_clock::now().time_since_epoch()).count();
}

// ---- Save/firmware persistence ----
//
// userdata is whatever was passed to NDS's constructor -- see ds_addon.cpp,
// which sets it to the session's save file path. NDS/GBA save memory is
// always written back in full (savedata/savelen cover the whole buffer;
// writeoffset/writelen just say what changed), so rewriting the whole file
// is the simplest correct thing, and these calls are not on the hot path.

void SignalStop(StopReason reason, void* userdata) {
    Log(LogLevel::Info, "SignalStop reason=%d\n", static_cast<int>(reason));
}

static void WriteWholeFile(const std::string* path, const u8* data, u32 length) {
    if (!path || path->empty()) return;
    FILE* f = fopen(path->c_str(), "wb");
    if (!f) return;
    fwrite(data, 1, length, f);
    fclose(f);
}

void WriteNDSSave(const u8* savedata, u32 savelen, u32 writeoffset, u32 writelen, void* userdata) {
    WriteWholeFile(static_cast<const std::string*>(userdata), savedata, savelen);
}

void WriteGBASave(const u8* savedata, u32 savelen, u32 writeoffset, u32 writelen, void* userdata) {
    WriteWholeFile(static_cast<const std::string*>(userdata), savedata, savelen);
}

// Called whenever the emulated console writes to its own firmware -- which
// is exactly what a game's "Nintendo WFC settings" screen does. Those
// settings live in the firmware, not in any cartridge, so persisting the
// image here is what makes the setup a once-per-device job instead of a
// once-per-ROM one: every game reads the same firmware back.
//
// Writes the whole image rather than just [writeoffset, writelen): it is a
// couple of hundred KB, this only happens when a game deliberately saves
// settings, and a partial write that landed wrong would leave an image no
// game can read.
void WriteFirmware(const Firmware& firmware, u32 writeoffset, u32 writelen, void* userdata) {
    const auto* context = static_cast<const InstanceContext*>(userdata);
    if (context && !context->persistFirmware) return;

    // melonDS calls this on every firmware SPI write, which comes in bursts
    // -- six identical ones during a single boot, measured on Android. Only
    // real changes are worth a 128K file write, so compare first.
    static std::vector<u8> lastWritten;
    const u8* buffer = firmware.Buffer();
    const u32 length = firmware.Length();
    if (lastWritten.size() == length && memcmp(lastWritten.data(), buffer, length) == 0) return;
    lastWritten.assign(buffer, buffer + length);

    const std::string path = GetLocalFilePath(kFirmwareFileName);
    FILE* f = fopen(path.c_str(), "wb");
    if (!f) {
        Log(LogLevel::Error, "firmware: could not open %s for writing\n", path.c_str());
        return;
    }
    const size_t written = fwrite(buffer, 1, length, f);
    fclose(f);
    Log(LogLevel::Info, "firmware: saved %zu/%u bytes\n", written, length);
}

// TODO: persist the emulated RTC's date/time if a game changes it.
void WriteDateTime(int year, int month, int day, int hour, int minute, int second, void* userdata) {}

// ---- Local wireless ----
//
// Two consoles in this one process, talking through melonDS's LocalMP: a
// shared packet queue where each console is addressed by its instance
// number. Receiving blocks, with a timeout, until the other console has
// sent -- which is why a link runs each console on a thread of its own
// (DsLink in ds_addon.cpp): taking turns on one thread, every exchange
// would wait out the timeout for a console that is not running.
//
// With no link up these all do nothing, and a game searching for others
// simply finds nobody, the same as a lone real DS.
static LocalMP* g_localMP = nullptr;

void SetLocalMP(LocalMP* mp) { g_localMP = mp; }

static int Instance(void* userdata) {
    const auto* context = static_cast<const InstanceContext*>(userdata);
    return context ? context->instance : 0;
}

void MP_Begin(void* userdata) {
    if (g_localMP) g_localMP->Begin(Instance(userdata));
}
void MP_End(void* userdata) {
    if (g_localMP) g_localMP->End(Instance(userdata));
}
int MP_SendPacket(u8* data, int len, u64 timestamp, void* userdata) {
    return g_localMP ? g_localMP->SendPacket(Instance(userdata), data, len, timestamp) : 0;
}
int MP_RecvPacket(u8* data, u64* timestamp, void* userdata) {
    return g_localMP ? g_localMP->RecvPacket(Instance(userdata), data, timestamp) : 0;
}
int MP_SendCmd(u8* data, int len, u64 timestamp, void* userdata) {
    return g_localMP ? g_localMP->SendCmd(Instance(userdata), data, len, timestamp) : 0;
}
int MP_SendReply(u8* data, int len, u64 timestamp, u16 aid, void* userdata) {
    return g_localMP ? g_localMP->SendReply(Instance(userdata), data, len, timestamp, aid) : 0;
}
int MP_SendAck(u8* data, int len, u64 timestamp, void* userdata) {
    return g_localMP ? g_localMP->SendAck(Instance(userdata), data, len, timestamp) : 0;
}
int MP_RecvHostPacket(u8* data, u64* timestamp, void* userdata) {
    return g_localMP ? g_localMP->RecvHostPacket(Instance(userdata), data, timestamp) : 0;
}
u16 MP_RecvReplies(u8* data, u64 timestamp, u16 aidmask, void* userdata) {
    return g_localMP ? g_localMP->RecvReplies(Instance(userdata), data, timestamp, aidmask) : 0;
}

// ---- Internet play ----
//
// Slirp ("indirect" mode): melonDS acts as a virtual router doing NAT over
// ordinary host sockets. Net_PCap would also work on a desktop (unlike on
// Android, where raw adapter access made it a non-starter), but it needs
// libpcap installed and an adapter picked by hand, so slirp is the one that
// works with no setup.
//
// The DS does not need a real access point either: melonDS emulates one
// (WifiAP.cpp, "melonAP"), and it is that AP which calls these two to push
// packets out and pull them back in. So a game's Nintendo WFC connection
// setup is talking to an access point that only exists inside the emulator.
//
// Built lazily, on the first packet a game actually sends: most sessions
// never touch wifi and there is no reason to stand up a network stack for
// them.
//
// Locked, because two linked consoles run on two threads and either may go
// online. Each registers under its own instance number, so replies reach
// the console that asked -- melonDS's Net keeps a receive queue per
// instance for exactly that.
static Net g_net;
static bool g_netStarted = false;
static unsigned g_netInstances = 0;
static std::mutex g_netMutex;

static Net& EnsureNet(int instance) {
    if (!g_netStarted) {
        g_netStarted = true;
        g_net.SetDriver(std::make_unique<Net_Slirp>(
            [](const u8* data, int len) { g_net.RXEnqueue(data, len); }));
        Log(LogLevel::Info, "Net: slirp driver up\n");
    }
    if (!(g_netInstances & (1u << instance))) {
        g_netInstances |= 1u << instance;
        g_net.RegisterInstance(instance);
    }
    return g_net;
}

int Net_SendPacket(u8* data, int len, void* userdata) {
    std::lock_guard<std::mutex> lock(g_netMutex);
    const int instance = Instance(userdata);
    EnsureNet(instance).SendPacket(data, len, instance);
    return 0;
}

int Net_RecvPacket(u8* data, void* userdata) {
    std::lock_guard<std::mutex> lock(g_netMutex);
    // Net::RecvPacket pumps the driver itself (Driver->RecvCheck), so there
    // is nothing else to tick on a timer.
    const int instance = Instance(userdata);
    return EnsureNet(instance).RecvPacket(data, instance);
}

// ---- DSi-only peripherals -- not implemented yet. ----

void Camera_Start(int num, void* userdata) {}
void Camera_Stop(int num, void* userdata) {}
void Camera_CaptureFrame(int num, u32* frame, int width, int height, bool yuv, void* userdata) {}

void Mic_Start(void* userdata) {}
void Mic_Stop(void* userdata) {}
int Mic_ReadInput(s16* data, int maxlength, void* userdata) { return 0; }

AACDecoder* AAC_Init() { return nullptr; }
void AAC_DeInit(AACDecoder* dec) {}
bool AAC_Configure(AACDecoder* dec, int frequency, int channels) { return false; }
bool AAC_DecodeFrame(AACDecoder* dec, const void* input, int inputlen, void* output, int outputlen) {
    return false;
}

// ---- Addon peripherals (Guitar Grip, Rumble Pak, Motion Pak) -- not implemented yet. ----

bool Addon_KeyDown(KeyType type, void* userdata) { return false; }
void Addon_RumbleStart(u32 len, void* userdata) {}
void Addon_RumbleStop(void* userdata) {}
float Addon_MotionQuery(MotionQueryType type, void* userdata) { return 0.0f; }

// ---- Dynamic library loading ----
//
// Not a plugin system: ARMJIT_Memory.cpp uses this to probe for platform
// APIs at runtime. Stubbing it out is what made the JIT crash instantly on
// Android, so it gets a real implementation here from the start.

DynamicLibrary* DynamicLibrary_Load(const char* lib) {
    return reinterpret_cast<DynamicLibrary*>(LoadLibraryA(lib));
}

void DynamicLibrary_Unload(DynamicLibrary* lib) {
    FreeLibrary(reinterpret_cast<HMODULE>(lib));
}

void* DynamicLibrary_LoadFunction(DynamicLibrary* lib, const char* name) {
    return reinterpret_cast<void*>(GetProcAddress(reinterpret_cast<HMODULE>(lib), name));
}

}  // namespace melonDS::Platform
