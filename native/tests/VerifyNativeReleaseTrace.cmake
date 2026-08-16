if(NOT DEFINED ADDON_PATH OR NOT EXISTS "${ADDON_PATH}")
  message(FATAL_ERROR "Release addon was not available for trace inspection: ${ADDON_PATH}")
endif()

file(
  STRINGS "${ADDON_PATH}" ORACLE_TRACE_MARKERS
  REGEX "OracleNativeDrag|oracle-native-drag\\.log"
)
if(ORACLE_TRACE_MARKERS)
  message(FATAL_ERROR "Persistent native trace markers were compiled into the default Release addon")
endif()

if(NOT DEFINED DUMPBIN_PATH OR NOT EXISTS "${DUMPBIN_PATH}")
  message(FATAL_ERROR "dumpbin was unavailable for Release import inspection: ${DUMPBIN_PATH}")
endif()
execute_process(
  COMMAND "${DUMPBIN_PATH}" /imports "${ADDON_PATH}"
  RESULT_VARIABLE DUMPBIN_RESULT
  OUTPUT_VARIABLE ADDON_IMPORTS
  ERROR_VARIABLE DUMPBIN_ERROR
)
if(NOT DUMPBIN_RESULT EQUAL 0)
  message(FATAL_ERROR "dumpbin import inspection failed: ${DUMPBIN_ERROR}")
endif()
if(ADDON_IMPORTS MATCHES "OutputDebugString|GetTempPath")
  message(FATAL_ERROR "Default Release addon imports persistent/debug trace APIs")
endif()

message(STATUS "Default Release addon contains no trace markers or trace API imports")
