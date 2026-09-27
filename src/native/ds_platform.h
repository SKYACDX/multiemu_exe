// The parts of ds_platform.cpp that aren't in melonDS's own Platform.h.
// SetLocalDir must be called once at startup, before any NDS instance
// exists, with a directory that is writable and survives restarts.
#pragma once

#include <string>

namespace melonDS {
class LocalMP;
}

namespace melonDS::Platform {

// What every NDS's userdata points at (see ds_addon.cpp). melonDS hands it
// back to each Platform call that concerns one console, which is how the
// wireless and firmware code below tell two linked consoles apart.
struct InstanceContext {
    // 0 for a console on its own; 0 and 1 for two on a wireless link.
    int instance = 0;
    // firmware.bin is shared by every game, so only one console may write
    // it. The second one of a link carries a different MAC address, which
    // must never end up in the file the next single-player session loads.
    bool persistFirmware = true;
};

// Non-null while two consoles are on a local wireless link: the queue
// their MP_* calls go through. Set before either console starts.
void SetLocalMP(LocalMP* mp);

void SetLocalDir(const std::string& dir);

// Name of the firmware image inside that directory. WriteFirmware saves it;
// ds_addon.cpp reads it back when it builds a session.
extern const char* const kFirmwareFileName;

}  // namespace melonDS::Platform
