cmake_minimum_required(VERSION 3.16)
project(multiemu_exe CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

# The GB/GBC core is shared verbatim with the Android app -- it lives in
# that repo (vendored here as a submodule) rather than being copied, so
# there is one source of truth for it. Its own CMakeLists.txt skips its
# tests and dev tools when it isn't the top-level project.
add_subdirectory(vendor/multiemu/core/gb)

# cmake-js supplies CMAKE_JS_INC (Node's own headers) but not
# node-addon-api's, which is an ordinary npm package. Asking node for the
# path is the documented way, but it answers with a path relative to the
# working directory -- and MSBuild re-runs CMake from somewhere else, so
# the include silently vanished on the second build. It's a direct
# dependency, so npm always puts it here.
set(NODE_ADDON_API_DIR ${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-addon-api)

add_library(gb_addon SHARED src/native/gb_addon.cpp ${CMAKE_JS_SRC})
set_target_properties(gb_addon PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(gb_addon PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})
target_link_libraries(gb_addon PRIVATE gbcore ${CMAKE_JS_LIB})
target_compile_definitions(gb_addon PRIVATE NAPI_DISABLE_CPP_EXCEPTIONS NAPI_VERSION=8)

# Generates the node.lib import library MSVC needs to link against the
# host process's N-API symbols.
if(MSVC AND CMAKE_JS_NODELIB_DEF AND CMAKE_JS_NODELIB_TARGET)
    execute_process(COMMAND ${CMAKE_AR} /def:${CMAKE_JS_NODELIB_DEF} /out:${CMAKE_JS_NODELIB_TARGET} ${CMAKE_STATIC_LINKER_FLAGS})
endif()

# mGBA is vendored under third_party/ (gitignored) and prebuilt out of band
# rather than added as a subdirectory: it's a large CMake project with its
# own flag set, and this mirrors how the Android build imports it. See the
# `build:mgba` script in package.json.
set(MGBA_LIB ${CMAKE_CURRENT_SOURCE_DIR}/third_party/mgba/build-win/Release/mgba.lib)
if(NOT EXISTS ${MGBA_LIB})
    message(FATAL_ERROR "libmgba not built: run `npm run build:mgba` first")
endif()

add_library(mgba STATIC IMPORTED)
set_target_properties(mgba PROPERTIES IMPORTED_LOCATION ${MGBA_LIB})
target_include_directories(mgba INTERFACE ${CMAKE_CURRENT_SOURCE_DIR}/third_party/mgba/include)

# The link cable (two GBAs in one process) is the Android app's own
# implementation, compiled from the submodule like core/gb. Its only Android
# dependency, debug logging, is stubbed by src/native/shim.
set(GBA_LINK_DIR ${CMAKE_CURRENT_SOURCE_DIR}/vendor/multiemu/app/android/gbacore/src/main/cpp)

add_library(gba_addon SHARED src/native/gba_addon.cpp ${GBA_LINK_DIR}/gba_link.cpp ${CMAKE_JS_SRC})
set_target_properties(gba_addon PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(gba_addon PRIVATE
    ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR} ${GBA_LINK_DIR} ${CMAKE_CURRENT_SOURCE_DIR}/src/native/shim)
# shlwapi: mGBA's mCoreConfigPortablePath calls PathRemoveFileSpecW.
target_link_libraries(gba_addon PRIVATE mgba shlwapi ${CMAKE_JS_LIB})
# NDEBUG is not about optimisation here, it is about memory layout.
# struct mLockstep grows a transferId field when NDEBUG is NOT defined
# (mgba/core/lockstep.h), and the link code allocates that struct while
# mgba.lib -- built with /DNDEBUG -- reads it. Built any other way, every
# field after it would sit at a different offset on each side: the same
# silent heap corruption as defining JIT_ENABLED for melonDS. Release
# builds already define it; this keeps a Debug build from breaking it.
target_compile_definitions(gba_addon PRIVATE NAPI_DISABLE_CPP_EXCEPTIONS NAPI_VERSION=8 NDEBUG)

# melonDS, same deal as mGBA: vendored under third_party/ and prebuilt out
# of band. See the `build:melonds` script.
set(MELONDS_BUILD ${CMAKE_CURRENT_SOURCE_DIR}/third_party/melonds/build-win)
if(NOT EXISTS ${MELONDS_BUILD}/src/Release/core.lib)
    message(FATAL_ERROR "melonDS not built: run `npm run build:melonds` first")
endif()

add_library(melonds_core STATIC IMPORTED)
set_target_properties(melonds_core PROPERTIES IMPORTED_LOCATION ${MELONDS_BUILD}/src/Release/core.lib)

# teakra (the DSi's DSP) is vendored inside melonDS's own tree and builds as
# a separate lib that core links against; core.lib alone is not enough.
add_library(melonds_teakra STATIC IMPORTED)
set_target_properties(melonds_teakra PROPERTIES
    IMPORTED_LOCATION ${MELONDS_BUILD}/src/teakra/src/Release/teakra.lib)

# melonDS's src/net, but only the files this app uses: the three behind
# internet play, and LocalMP, the in-process queue behind two consoles on
# local wireless. Its own `net-utils` target is not used on purpose: that
# one also drags in Net_PCap (libpcap) and LAN/Netplay (ENet), neither of
# which this app has any use for.
set(MELONDS_NET ${CMAKE_CURRENT_SOURCE_DIR}/third_party/melonds/src/net)

add_library(ds_addon SHARED
    src/native/ds_addon.cpp
    src/native/ds_platform.cpp
    ${MELONDS_NET}/Net.cpp
    ${MELONDS_NET}/Net_Slirp.cpp
    ${MELONDS_NET}/PacketDispatcher.cpp
    ${MELONDS_NET}/LocalMP.cpp
    ${CMAKE_JS_SRC})
set_target_properties(ds_addon PROPERTIES PREFIX "" SUFFIX ".node" CXX_STANDARD 20)
target_include_directories(ds_addon PRIVATE
    ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR}
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/melonds/src
    ${MELONDS_NET}
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/melonds/src/net/libslirp/src
    # libslirp-version.h is generated at configure time into libslirp's own
    # build directory, not shipped in its source tree.
    ${CMAKE_CURRENT_SOURCE_DIR}/third_party/melonds/build-slirp)
# ole32/comctl32/wsock32/ws2_32 are what melonDS's own CMake links on
# Windows; core.lib is imported as a prebuilt, so none of that propagates.
set(SLIRP_LIB ${CMAKE_CURRENT_SOURCE_DIR}/third_party/melonds/build-slirp/Release/slirp.lib)
if(NOT EXISTS ${SLIRP_LIB})
    message(FATAL_ERROR "libslirp not built: run `npm run build:slirp` first")
endif()

add_library(slirp STATIC IMPORTED)
set_target_properties(slirp PROPERTIES IMPORTED_LOCATION ${SLIRP_LIB})

# iphlpapi: libslirp reads the host's DNS configuration through it on
# Windows. The rest is what melonDS's own CMake links; core.lib is imported
# as a prebuilt, so none of that propagates.
target_link_libraries(ds_addon PRIVATE
    melonds_core melonds_teakra slirp
    ole32 comctl32 wsock32 ws2_32 iphlpapi ${CMAKE_JS_LIB})
# No JIT_ENABLED here, and that is deliberate rather than an omission.
# melonDS decides whether it can build its JIT by probing for __x86_64__,
# which MSVC does not define, so its cmake_dependent_option quietly forces
# ENABLE_JIT off no matter what is passed on the command line -- core.lib
# genuinely has no JIT in it. Defining JIT_ENABLED on this side anyway
# would be the sizeof(NDS) mismatch from
# docs/desktop-port-handoff.md section 2, just in the opposite direction:
# NDS.h keeps a data member behind that #ifdef, so this translation unit
# would allocate a larger NDS than the core was compiled against.
#
# Getting the JIT back means building melonDS with clang-cl, which defines
# the GCC-style arch macros and accepts the __attribute__((packed)) in
# TinyVector.h, while staying ABI-compatible with the MSVC-built addons.
# NOMINMAX: napi.h pulls in windows.h, whose max/min macros break the
# std::max calls in melonDS's ARM.h.
#
# LIBSLIRP_STATIC_BUILD is the same story in miniature: libslirp declares it
# PUBLIC on its own target, but this build imports the prebuilt .lib, so
# nothing propagates. Without it libslirp.h marks every function
# __declspec(dllimport) and the link fails on __imp_slirp_*.
target_compile_definitions(ds_addon PRIVATE
    NAPI_DISABLE_CPP_EXCEPTIONS NAPI_VERSION=8 NOMINMAX LIBSLIRP_STATIC_BUILD)

# The 3DS: Azahar's own libretro core (azahar_libretro.dll), built out of
# band by `npm run build:azahar` and loaded at run time rather than linked
# -- see src/native/n3ds_addon.cpp. So this needs only libretro.h, plus the
# DLL copied next to the addon, where the preload looks for it.
set(AZAHAR ${CMAKE_CURRENT_SOURCE_DIR}/third_party/azahar)
set(AZAHAR_CORE ${AZAHAR}/build-win/bin/Release/azahar_libretro.dll)
if(NOT EXISTS ${AZAHAR_CORE})
    message(FATAL_ERROR "Azahar's libretro core not built: run `npm run build:azahar` first")
endif()

add_library(n3ds_addon SHARED src/native/n3ds_addon.cpp ${CMAKE_JS_SRC})
set_target_properties(n3ds_addon PROPERTIES PREFIX "" SUFFIX ".node" CXX_STANDARD 20)
target_include_directories(n3ds_addon PRIVATE
    ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR}
    ${AZAHAR}/externals/libretro-common/libretro-common/include)
target_link_libraries(n3ds_addon PRIVATE opengl32 user32 gdi32 ${CMAKE_JS_LIB})
target_compile_definitions(n3ds_addon PRIVATE NAPI_DISABLE_CPP_EXCEPTIONS NAPI_VERSION=8 NOMINMAX)
add_custom_command(TARGET n3ds_addon POST_BUILD
    COMMAND ${CMAKE_COMMAND} -E copy_if_different ${AZAHAR_CORE} $<TARGET_FILE_DIR:n3ds_addon>)
