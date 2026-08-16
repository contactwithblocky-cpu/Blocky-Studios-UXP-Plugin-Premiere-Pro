#pragma once

#include <cstddef>
#include <string>

namespace oracle::atomic_file {

struct AtomicWriteResult {
    bool ok = false;
    bool backupCreated = false;
    std::size_t bytesWritten = 0;
    unsigned long win32Error = 0;
    std::string errorCode;
    std::string errorMessage;
};

AtomicWriteResult WriteOracleStateAtomically(
    const std::wstring& primaryPath,
    const std::wstring& temporaryPath,
    const std::wstring& backupPath,
    const std::string& utf8Text);

}  // namespace oracle::atomic_file
