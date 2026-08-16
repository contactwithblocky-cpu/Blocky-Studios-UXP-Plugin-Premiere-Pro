cmake_minimum_required(VERSION 3.21)

project(oracle_native_drag LANGUAGES CXX)

option(
  ORACLE_NATIVE_DEVELOPMENT_TRACE
  "Enable persistent native drag tracing for explicit development builds"
  OFF
)

set(
  ADOBE_UXP_HYBRID_SDK_ROOT
  "D:/Adobe SDKs/UXP Hybrid Plugin SDK/uxp-hybrid-plugin-sdk-main"
  CACHE PATH
  "Root of Adobe's UXP Hybrid Plugin SDK"
)

if(NOT EXISTS "${ADOBE_UXP_HYBRID_SDK_ROOT}/src/api/UxpAddonShared.h")
  message(FATAL_ERROR "ADOBE_UXP_HYBRID_SDK_ROOT does not point to the installed Hybrid SDK")
endif()

set(ORACLE_NATIVE_SOURCES
  src/AtomicFileService.cpp
  src/DirectoryWatchService.cpp
  src/FileOperationService.cpp
  src/NativeDragCore.cpp
  src/PackagedFontRegistrationService.cpp
  src/ReplayMediaService.cpp
  src/SafeFileIdentity.cpp
  src/module.cpp
  "${ADOBE_UXP_HYBRID_SDK_ROOT}/src/utilities/UxpAddon.cpp"
)

add_library(oracle-native-drag SHARED ${ORACLE_NATIVE_SOURCES})
target_compile_features(oracle-native-drag PRIVATE cxx_std_20)
target_compile_definitions(oracle-native-drag PRIVATE
  UNICODE
  _UNICODE
  WIN32_LEAN_AND_MEAN
  NOMINMAX
  _WINDOWS
  _USRDLL
)
if(ORACLE_NATIVE_DEVELOPMENT_TRACE)
  target_compile_definitions(oracle-native-drag PRIVATE ORACLE_NATIVE_DEVELOPMENT_TRACE=1)
endif()
target_include_directories(oracle-native-drag PRIVATE
  src
  "${ADOBE_UXP_HYBRID_SDK_ROOT}/src/api"
  "${ADOBE_UXP_HYBRID_SDK_ROOT}/src/utilities"
)
target_link_libraries(oracle-native-drag PRIVATE gdi32 ole32 shell32 uuid)
set_property(TARGET oracle-native-drag PROPERTY
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
)
set_target_properties(oracle-native-drag PROPERTIES
  PREFIX ""
  SUFFIX ".uxpaddon"
  OUTPUT_NAME "oracle-native-drag"
  RUNTIME_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/stage/win/x64"
  ARCHIVE_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/lib"
  PDB_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/symbols"
  COMPILE_PDB_OUTPUT_DIRECTORY_RELEASE "${CMAKE_BINARY_DIR}/symbols"
)

include(CTest)
if(BUILD_TESTING)
  add_executable(oracle-native-drag-tests
    tests/NativeDragTests.cpp
    src/NativeDragCore.cpp
    src/SafeFileIdentity.cpp
  )
  target_compile_features(oracle-native-drag-tests PRIVATE cxx_std_20)
  target_compile_definitions(oracle-native-drag-tests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    ORACLE_NATIVE_DRAG_TESTS
  )
  if(ORACLE_NATIVE_DEVELOPMENT_TRACE)
    target_compile_definitions(oracle-native-drag-tests PRIVATE ORACLE_NATIVE_DEVELOPMENT_TRACE=1)
  endif()
  target_include_directories(oracle-native-drag-tests PRIVATE src)
  target_link_libraries(oracle-native-drag-tests PRIVATE ole32 shell32 uuid)
  set_property(TARGET oracle-native-drag-tests PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
  add_test(NAME oracle-native-drag-tests COMMAND oracle-native-drag-tests)

  if(NOT ORACLE_NATIVE_DEVELOPMENT_TRACE)
    get_filename_component(ORACLE_MSVC_TOOL_DIRECTORY "${CMAKE_LINKER}" DIRECTORY)
    add_test(
      NAME oracle-native-release-trace-guard
      COMMAND "${CMAKE_COMMAND}"
        "-DADDON_PATH=$<TARGET_FILE:oracle-native-drag>"
        "-DDUMPBIN_PATH=${ORACLE_MSVC_TOOL_DIRECTORY}/dumpbin.exe"
        -P "${CMAKE_CURRENT_SOURCE_DIR}/tests/VerifyNativeReleaseTrace.cmake"
    )
  endif()

  add_executable(oracle-atomic-file-tests
    tests/AtomicFileServiceTests.cpp
    src/AtomicFileService.cpp
  )
  target_compile_features(oracle-atomic-file-tests PRIVATE cxx_std_20)
  target_compile_definitions(oracle-atomic-file-tests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
  )
  target_include_directories(oracle-atomic-file-tests PRIVATE src)
  set_property(TARGET oracle-atomic-file-tests PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
  add_test(NAME oracle-atomic-file-tests COMMAND oracle-atomic-file-tests)

  add_executable(oracle-file-operation-tests
    tests/FileOperationServiceTests.cpp
    src/FileOperationService.cpp
    src/SafeFileIdentity.cpp
  )
  target_compile_features(oracle-file-operation-tests PRIVATE cxx_std_20)
  target_compile_definitions(oracle-file-operation-tests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
    ORACLE_FILE_OPERATION_TESTS
  )
  target_include_directories(oracle-file-operation-tests PRIVATE src)
  target_link_libraries(oracle-file-operation-tests PRIVATE ole32 shell32 uuid)
  set_property(TARGET oracle-file-operation-tests PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
  add_test(NAME oracle-file-operation-tests COMMAND oracle-file-operation-tests)

  add_executable(oracle-directory-watch-tests
    tests/DirectoryWatchServiceTests.cpp
    src/DirectoryWatchService.cpp
    src/SafeFileIdentity.cpp
  )
  target_compile_features(oracle-directory-watch-tests PRIVATE cxx_std_20)
  target_compile_definitions(oracle-directory-watch-tests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
  )
  target_include_directories(oracle-directory-watch-tests PRIVATE src)
  set_property(TARGET oracle-directory-watch-tests PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
  add_test(NAME oracle-directory-watch-tests COMMAND oracle-directory-watch-tests)

  add_executable(oracle-packaged-font-registration-tests
    tests/PackagedFontRegistrationServiceTests.cpp
    src/PackagedFontRegistrationService.cpp
    src/SafeFileIdentity.cpp
  )
  target_compile_features(oracle-packaged-font-registration-tests PRIVATE cxx_std_20)
  target_compile_definitions(oracle-packaged-font-registration-tests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
  )
  target_include_directories(oracle-packaged-font-registration-tests PRIVATE src)
  target_link_libraries(oracle-packaged-font-registration-tests PRIVATE gdi32)
  set_property(TARGET oracle-packaged-font-registration-tests PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
  add_test(
    NAME oracle-packaged-font-registration-tests
    COMMAND oracle-packaged-font-registration-tests "${CMAKE_CURRENT_SOURCE_DIR}/.."
  )

  add_executable(oracle-replay-media-tests
    tests/ReplayMediaServiceTests.cpp
    src/ReplayMediaService.cpp
  )
  target_compile_features(oracle-replay-media-tests PRIVATE cxx_std_20)
  target_compile_definitions(oracle-replay-media-tests PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
  )
  target_include_directories(oracle-replay-media-tests PRIVATE src)
  set_property(TARGET oracle-replay-media-tests PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
  add_test(
    NAME oracle-replay-media-tests
    COMMAND oracle-replay-media-tests
      "${CMAKE_CURRENT_SOURCE_DIR}/third_party/ffmpeg/windows-x86_64"
  )

  add_executable(oracle-native-drag-harness WIN32
    tests/NativeDragHarness.cpp
    src/NativeDragCore.cpp
    src/SafeFileIdentity.cpp
  )
  target_compile_features(oracle-native-drag-harness PRIVATE cxx_std_20)
  target_compile_definitions(oracle-native-drag-harness PRIVATE
    UNICODE
    _UNICODE
    WIN32_LEAN_AND_MEAN
    NOMINMAX
  )
  if(ORACLE_NATIVE_DEVELOPMENT_TRACE)
    target_compile_definitions(oracle-native-drag-harness PRIVATE ORACLE_NATIVE_DEVELOPMENT_TRACE=1)
  endif()
  target_include_directories(oracle-native-drag-harness PRIVATE src)
  target_link_libraries(oracle-native-drag-harness PRIVATE ole32 shell32 uuid)
  set_property(TARGET oracle-native-drag-harness PROPERTY
    MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  )
endif()
