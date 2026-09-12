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

add_library(gba_addon SHARED src/native/gba_addon.cpp ${CMAKE_JS_SRC})
set_target_properties(gba_addon PROPERTIES PREFIX "" SUFFIX ".node")
target_include_directories(gba_addon PRIVATE ${CMAKE_JS_INC} ${NODE_ADDON_API_DIR})
# shlwapi: mGBA's mCoreConfigPortablePath calls PathRemoveFileSpecW.
target_link_libraries(gba_addon PRIVATE mgba shlwapi ${CMAKE_JS_LIB})
target_compile_definitions(gba_addon PRIVATE NAPI_DISABLE_CPP_EXCEPTIONS NAPI_VERSION=8)
