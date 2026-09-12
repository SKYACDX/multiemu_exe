// The parts of ds_platform.cpp that aren't in melonDS's own Platform.h.
// SetLocalDir must be called once at startup, before any NDS instance
// exists, with a directory that is writable and survives restarts.
#pragma once

#include <string>

namespace melonDS::Platform {

void SetLocalDir(const std::string& dir);

// Name of the firmware image inside that directory. WriteFirmware saves it;
// ds_addon.cpp reads it back when it builds a session.
extern const char* const kFirmwareFileName;

}  // namespace melonDS::Platform
