cmake_minimum_required(VERSION 3.22.1)
project(crmtaranom)

# libnode headers + shared library come from the nodejs-mobile-android AAR,
# extracted by the build.gradle copyNodeLibs task into this layout:
#   app/libnode/include/node/   (headers)
#   app/libnode/bin/<abi>/libnode.so
set(LIBNODE_DIR ${CMAKE_SOURCE_DIR}/../../../libnode)

add_library(native-lib SHARED native-lib.cpp)

include_directories(${LIBNODE_DIR}/include/node)

add_library(node SHARED IMPORTED)
set_target_properties(node PROPERTIES IMPORTED_LOCATION
        ${LIBNODE_DIR}/bin/${ANDROID_ABI}/libnode.so)

target_link_libraries(native-lib node android log)
