// Stand-in for the NDK's <android/log.h>.
//
// gba_link.cpp (the GBA link cable) is compiled straight out of the Android
// repo rather than copied, and debug logging is its only Android
// dependency. Here the logging simply compiles away: it fires on every
// lockstep handshake, so it would have to be silenced anyway.
#pragma once

#define ANDROID_LOG_DEBUG 3
#define __android_log_print(...) ((void)0)
