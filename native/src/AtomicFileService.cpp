#include "AtomicFileService.h"

#include <Windows.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <limits>
#include <memory>
#include <string_view>

namespace oracle::atomic_file {
namespace {

constexpr std::size_t kMaximumStateBytes = 64u * 1024u * 1024u;
constexpr std::wstring_view kPrimaryName = L"oracle-state.v3.json";
constexpr std::wstring_view kTemporaryName = L"oracle-state.v3.tmp.json";
constexpr std::wstring_view kBackupName = L"oracle-state.v3.backup.json";

struct HandleCloser {
    void operator()(void* value) const noexcept {
        const HANDLE handle = static_cast<HANDLE>(value);
        if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    }
};

using UniqueHandle = std::unique_ptr<void, HandleCloser>;

AtomicWriteResult Failure(
    std::string code,
    std::string message,
    DWORD win32Error = ERROR_SUCCESS) {
    AtomicWriteResult result;
    result.win32Error = win32Error;
    result.errorCode = std::move(code);
    result.errorMessage = std::move(message);
    return result;
}

bool HasAlternateStreamSyntax(const std::wstring& path) {
    const std::size_t start = path.rfind(L'\\') + 1;
    return path.find(L':', start) != std::wstring::npos;
}

bool HasReparsePoint(const std::filesystem::path& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    return attributes != INVALID_FILE_ATTRIBUTES &&
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
}

bool IsRegularFileIfPresent(const std::filesystem::path& path) {
    const DWORD attributes = GetFileAttributesW(path.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) return GetLastError() == ERROR_FILE_NOT_FOUND;
    return (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) == 0;
}

AtomicWriteResult ValidateRequest(
    const std::filesystem::path& primary,
    const std::filesystem::path& temporary,
    const std::filesystem::path& backup,
    const std::string& text) {
    if (text.empty() || text.size() > kMaximumStateBytes || text.find('\0') != std::string::npos) {
        return Failure("INVALID_STATE_TEXT", "State text is empty, contains NUL, or exceeds 64 MB.");
    }
    if (!primary.is_absolute() || !temporary.is_absolute() || !backup.is_absolute()) {
        return Failure("INVALID_STATE_PATH", "Atomic state paths must be absolute.");
    }
    if (primary.filename().wstring() != kPrimaryName ||
        temporary.filename().wstring() != kTemporaryName ||
        backup.filename().wstring() != kBackupName) {
        return Failure("INVALID_STATE_PATH", "Atomic state paths use unexpected file names.");
    }
    const auto parent = primary.parent_path().lexically_normal();
    if (temporary.parent_path().lexically_normal() != parent ||
        backup.parent_path().lexically_normal() != parent ||
        parent.empty()) {
        return Failure("INVALID_STATE_PATH", "Atomic state files must share one directory.");
    }
    if (HasAlternateStreamSyntax(primary.wstring()) || HasAlternateStreamSyntax(temporary.wstring()) ||
        HasAlternateStreamSyntax(backup.wstring())) {
        return Failure("INVALID_STATE_PATH", "Alternate data stream paths are not allowed.");
    }
    const DWORD directoryAttributes = GetFileAttributesW(parent.c_str());
    if (directoryAttributes == INVALID_FILE_ATTRIBUTES ||
        (directoryAttributes & FILE_ATTRIBUTE_DIRECTORY) == 0 ||
        (directoryAttributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        return Failure("INVALID_STATE_DIRECTORY", "State directory is missing or is a reparse point.");
    }
    if (!IsRegularFileIfPresent(primary) || !IsRegularFileIfPresent(temporary) ||
        !IsRegularFileIfPresent(backup) || HasReparsePoint(primary) || HasReparsePoint(temporary) ||
        HasReparsePoint(backup)) {
        return Failure("UNSAFE_STATE_TARGET", "State targets must be regular non-reparse files.");
    }
    return AtomicWriteResult{.ok = true};
}

bool WriteAll(HANDLE handle, const std::string& text, DWORD* error) {
    std::size_t offset = 0;
    while (offset < text.size()) {
        const DWORD requested = static_cast<DWORD>(std::min<std::size_t>(
            text.size() - offset,
            std::numeric_limits<DWORD>::max()));
        DWORD written = 0;
        if (!WriteFile(handle, text.data() + offset, requested, &written, nullptr) || written == 0) {
            if (error) *error = GetLastError();
            return false;
        }
        offset += written;
    }
    return true;
}

bool FlushExistingFile(const std::filesystem::path& path) {
    UniqueHandle handle(CreateFileW(
        path.c_str(),
        GENERIC_READ | GENERIC_WRITE,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
        nullptr));
    return handle.get() != INVALID_HANDLE_VALUE && FlushFileBuffers(handle.get());
}

}  // namespace

AtomicWriteResult WriteOracleStateAtomically(
    const std::wstring& primaryPath,
    const std::wstring& temporaryPath,
    const std::wstring& backupPath,
    const std::string& utf8Text) {
    const std::filesystem::path primary(primaryPath);
    const std::filesystem::path temporary(temporaryPath);
    const std::filesystem::path backup(backupPath);
    AtomicWriteResult validation = ValidateRequest(primary, temporary, backup, utf8Text);
    if (!validation.ok) return validation;

    DeleteFileW(temporary.c_str());
    UniqueHandle temporaryHandle(CreateFileW(
        temporary.c_str(),
        GENERIC_WRITE | GENERIC_READ,
        0,
        nullptr,
        CREATE_NEW,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_WRITE_THROUGH,
        nullptr));
    if (temporaryHandle.get() == INVALID_HANDLE_VALUE) {
        return Failure("STATE_TEMP_CREATE_FAILED", "Could not create the staged state file.", GetLastError());
    }

    DWORD writeError = ERROR_SUCCESS;
    if (!WriteAll(temporaryHandle.get(), utf8Text, &writeError) || !FlushFileBuffers(temporaryHandle.get())) {
        if (writeError == ERROR_SUCCESS) writeError = GetLastError();
        temporaryHandle.reset();
        DeleteFileW(temporary.c_str());
        return Failure("STATE_TEMP_FLUSH_FAILED", "Could not durably flush the staged state file.", writeError);
    }
    LARGE_INTEGER stagedSize{};
    if (!GetFileSizeEx(temporaryHandle.get(), &stagedSize) ||
        stagedSize.QuadPart != static_cast<LONGLONG>(utf8Text.size())) {
        const DWORD sizeError = GetLastError();
        temporaryHandle.reset();
        DeleteFileW(temporary.c_str());
        return Failure("STATE_TEMP_VERIFY_FAILED", "Staged state length verification failed.", sizeError);
    }
    temporaryHandle.reset();

    const DWORD primaryAttributes = GetFileAttributesW(primary.c_str());
    bool backupCreated = false;
    if (primaryAttributes == INVALID_FILE_ATTRIBUTES) {
        if (!MoveFileExW(
                temporary.c_str(),
                primary.c_str(),
                MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
            const DWORD error = GetLastError();
            DeleteFileW(temporary.c_str());
            return Failure("STATE_COMMIT_FAILED", "Could not commit the first state file.", error);
        }
    } else {
        // The current primary remains the recovery source if deletion of an old
        // backup or ReplaceFile itself fails. ReplaceFile creates the new LKG
        // backup and switches the primary in one filesystem operation.
        if (!DeleteFileW(backup.c_str()) && GetLastError() != ERROR_FILE_NOT_FOUND) {
            const DWORD error = GetLastError();
            DeleteFileW(temporary.c_str());
            return Failure("STATE_BACKUP_ROTATE_FAILED", "Could not rotate the previous state backup.", error);
        }
        if (!ReplaceFileW(primary.c_str(), temporary.c_str(), backup.c_str(), 0, nullptr, nullptr)) {
            const DWORD error = GetLastError();
            if (GetFileAttributesW(primary.c_str()) == INVALID_FILE_ATTRIBUTES &&
                GetFileAttributesW(backup.c_str()) != INVALID_FILE_ATTRIBUTES) {
                MoveFileExW(backup.c_str(), primary.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH);
            }
            DeleteFileW(temporary.c_str());
            return Failure("STATE_COMMIT_FAILED", "Atomic state replacement failed; the prior primary was retained.", error);
        }
        backupCreated = true;
    }

    if (!FlushExistingFile(primary)) {
        return Failure("STATE_PRIMARY_FLUSH_FAILED", "Committed state could not be reopened and flushed.", GetLastError());
    }
    AtomicWriteResult result;
    result.ok = true;
    result.backupCreated = backupCreated;
    result.bytesWritten = utf8Text.size();
    return result;
}

}  // namespace oracle::atomic_file
