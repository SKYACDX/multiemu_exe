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
# node-addon-api's, which is an ordinary npm package.
execute_process(
    COMMAND node -p "require('node-addon-api').include_dir"
    OUTPUT_VARIABLE NODE_ADDON_API_DIR
    OUTPUT_STRIP_TRAILING_WHITESPACE
)

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
