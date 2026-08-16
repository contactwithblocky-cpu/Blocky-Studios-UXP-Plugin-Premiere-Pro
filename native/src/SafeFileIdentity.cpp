#include "SafeFileIdentity.h"

#include <Windows.h>

#include <algorithm>
#include <cwctype>
#include <filesystem>
#include <iomanip>
#include <memory>
#include <sstream>
#include <string_view>

namespace oracle::file_identity {
namespace {

struct HandleCloser {
    void operator()(void* value) const noexcept {
        const HANDLE handle = static_cast<HANDLE>(value);
        if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    }
};

using UniqueHandle = std::unique_ptr<void, HandleCloser>;

FileInspectionResult Failure(
    std::string code,
    std::string message,
    DWORD win32Error = ERROR_SUCCESS) {
    FileInspectionResult result;
    result.win32Error = win32Error;
    result.errorCode = std::move(code);
    result.errorMessage = std::move(message);
    return result;
}

bool IsAbsoluteLocalDrivePath(const std::wstring& path) {
    return path.size() >= 3 && std::iswalpha(path[0]) && path[1] == L':' &&
        (path[2] == L'\\' || path[2] == L'/');
}

bool HasNamespacePrefix(const std::wstring& path) {
    return path.rfind(L"\\\\?\\", 0) == 0 || path.rfind(L"\\\\.\\", 0) == 0 ||
        path.rfind(L"\\??\\", 0) == 0;
}

bool IsAbsoluteUncPath(const std::wstring& path) {
    if (path.size() < 5 || HasNamespacePrefix(path)) return false;
    if (!((path[0] == L'\\' && path[1] == L'\\') ||
          (path[0] == L'/' && path[1] == L'/'))) {
        return false;
    }
    const std::size_t serverEnd = path.find_first_of(L"\\/", 2);
    if (serverEnd == std::wstring::npos || serverEnd == 2) return false;
    const std::size_t shareEnd = path.find_first_of(L"\\/", serverEnd + 1);
    return shareEnd != std::wstring::npos && shareEnd > serverEnd + 1 &&
        shareEnd + 1 < path.size();
}

bool HasAlternateStreamSyntax(const std::wstring& path) {
    const std::size_t scanStart = IsAbsoluteLocalDrivePath(path) ? 2 : 0;
    return path.find(L':', scanStart) != std::wstring::npos;
}

bool ContainsParentTraversal(const std::wstring& path) {
    for (const auto& component : std::filesystem::path(path)) {
        if (component == L"..") return true;
    }
    return false;
}

bool IsReservedDosDeviceName(std::wstring component) {
    while (!component.empty() && (component.back() == L'.' || component.back() == L' ')) {
        component.pop_back();
    }
    const std::size_t extension = component.find(L'.');
    if (extension != std::wstring::npos) component.resize(extension);
    std::transform(component.begin(), component.end(), component.begin(), [](wchar_t value) {
        return static_cast<wchar_t>(std::towupper(value));
    });
    if (component == L"CON" || component == L"PRN" || component == L"AUX" ||
        component == L"NUL" || component == L"CONIN$" || component == L"CONOUT$" ||
        component == L"CLOCK$") {
        return true;
    }
    if (component.size() == 4 && component[3] >= L'1' && component[3] <= L'9') {
        return component.rfind(L"COM", 0) == 0 || component.rfind(L"LPT", 0) == 0;
    }
    return false;
}

bool ContainsReservedDosDeviceComponent(const std::filesystem::path& path) {
    for (const auto& component : path.relative_path()) {
        if (component.empty() || component == L"." || component == L"..") continue;
        if (IsReservedDosDeviceName(component.wstring())) return true;
    }
    return false;
}

std::wstring VolumeRootForPath(const std::wstring& normalizedPath) {
    if (IsAbsoluteLocalDrivePath(normalizedPath)) return normalizedPath.substr(0, 3);
    if (!IsAbsoluteUncPath(normalizedPath)) return {};
    const std::size_t serverEnd = normalizedPath.find_first_of(L"\\/", 2);
    const std::size_t shareEnd = normalizedPath.find_first_of(L"\\/", serverEnd + 1);
    return normalizedPath.substr(0, shareEnd + 1);
}

std::wstring StripExtendedPrefix(std::wstring path) {
    if (path.rfind(L"\\\\?\\UNC\\", 0) == 0) {
        return L"\\\\" + path.substr(8);
    }
    if (path.rfind(L"\\\\?\\", 0) == 0) return path.substr(4);
    return path;
}

bool ContainsReparseComponent(const std::filesystem::path& path, DWORD* error) {
    std::filesystem::path current = path.root_path();
    for (const auto& component : path.relative_path()) {
        if (component == L"." || component.empty()) continue;
        if (component == L"..") {
            if (error) *error = ERROR_INVALID_NAME;
            return true;
        }
        current /= component;
        const DWORD attributes = GetFileAttributesW(current.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES) {
            if (error) *error = GetLastError();
            return false;
        }
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
            if (error) *error = ERROR_REPARSE_TAG_INVALID;
            return true;
        }
    }
    return false;
}

std::wstring GetNormalizedAbsolutePath(const std::wstring& input, DWORD* error) {
    const DWORD required = GetFullPathNameW(input.c_str(), 0, nullptr, nullptr);
    if (required == 0) {
        if (error) *error = GetLastError();
        return {};
    }
    std::wstring buffer(required, L'\0');
    const DWORD written = GetFullPathNameW(input.c_str(), required, buffer.data(), nullptr);
    if (written == 0 || written >= required) {
        if (error) *error = written == 0 ? GetLastError() : ERROR_INSUFFICIENT_BUFFER;
        return {};
    }
    buffer.resize(written);
    return std::filesystem::path(buffer).lexically_normal().wstring();
}

std::wstring FinalPathFromHandle(HANDLE handle, DWORD* error) {
    const DWORD required = GetFinalPathNameByHandleW(
        handle, nullptr, 0, FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (required == 0) {
        if (error) *error = GetLastError();
        return {};
    }
    std::wstring buffer(required + 1, L'\0');
    const DWORD written = GetFinalPathNameByHandleW(
        handle,
        buffer.data(),
        static_cast<DWORD>(buffer.size()),
        FILE_NAME_NORMALIZED | VOLUME_NAME_DOS);
    if (written == 0 || written >= buffer.size()) {
        if (error) *error = written == 0 ? GetLastError() : ERROR_INSUFFICIENT_BUFFER;
        return {};
    }
    buffer.resize(written);
    return StripExtendedPrefix(buffer);
}

FileInspectionResult ValidateCommonPath(
    const std::wstring& absolutePath,
    bool requireDirectory,
    bool allowRemoteVolume = false) {
    if (absolutePath.empty() || absolutePath.find(L'\0') != std::wstring::npos) {
        return Failure(
            "INVALID_ABSOLUTE_PATH",
            "The path must be a non-empty absolute Windows path.");
    }
    if (HasNamespacePrefix(absolutePath)) {
        return Failure("DEVICE_PATH_NOT_ALLOWED", "Windows device and extended namespaces are not allowed.");
    }
    const bool localDrivePath = IsAbsoluteLocalDrivePath(absolutePath);
    const bool uncPath = allowRemoteVolume && IsAbsoluteUncPath(absolutePath);
    if (!localDrivePath && !uncPath) {
        return Failure(
            "INVALID_ABSOLUTE_PATH",
            allowRemoteVolume
                ? "The path must be an absolute drive or UNC file path."
                : "The path must be an absolute local-drive path.");
    }
    if (ContainsParentTraversal(absolutePath)) {
        return Failure("PATH_TRAVERSAL_NOT_ALLOWED", "Parent-directory traversal is not allowed.");
    }
    if (HasAlternateStreamSyntax(absolutePath)) {
        return Failure("ALTERNATE_DATA_STREAM_NOT_ALLOWED", "Alternate data streams are not allowed.");
    }
    if (ContainsReservedDosDeviceComponent(std::filesystem::path(absolutePath))) {
        return Failure("DEVICE_PATH_NOT_ALLOWED", "Reserved Windows device names are not allowed.");
    }

    DWORD normalizeError = ERROR_SUCCESS;
    const std::wstring normalized = GetNormalizedAbsolutePath(absolutePath, &normalizeError);
    if (normalized.empty()) {
        return Failure("PATH_NORMALIZATION_FAILED", "The path could not be normalized.", normalizeError);
    }
    const std::filesystem::path normalizedPath(normalized);
    if (normalizedPath == normalizedPath.root_path()) {
        return Failure("VOLUME_ROOT_NOT_ALLOWED", "An entire volume cannot be used as a Blocky Studios target.");
    }

    const std::wstring volumeRoot = VolumeRootForPath(normalized);
    const UINT driveType = volumeRoot.empty() ? DRIVE_UNKNOWN : GetDriveTypeW(volumeRoot.c_str());
    const bool volumeAllowed = driveType == DRIVE_FIXED ||
        (allowRemoteVolume && driveType == DRIVE_REMOTE);
    if (!volumeAllowed) {
        if (allowRemoteVolume && uncPath &&
            (driveType == DRIVE_UNKNOWN || driveType == DRIVE_NO_ROOT_DIR)) {
            return Failure("PATH_NOT_FOUND", "The remote path is not reachable.", ERROR_BAD_NETPATH);
        }
        return Failure(
            "UNSUPPORTED_VOLUME",
            allowRemoteVolume
                ? "Blocky Studios native drag requires a fixed or reachable remote volume."
                : "Blocky Studios file lifecycle operations require a local fixed volume.");
    }

    DWORD reparseError = ERROR_SUCCESS;
    if (ContainsReparseComponent(normalizedPath, &reparseError)) {
        return Failure(
            "REPARSE_POINT_NOT_ALLOWED",
            "The path contains a reparse-point component.",
            reparseError);
    }
    if (reparseError != ERROR_SUCCESS) {
        return Failure("PATH_NOT_FOUND", "The path does not exist.", reparseError);
    }

    const DWORD attributes = GetFileAttributesW(normalized.c_str());
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        return Failure("PATH_NOT_FOUND", "The path does not exist.", GetLastError());
    }
    const bool isDirectory = (attributes & FILE_ATTRIBUTE_DIRECTORY) != 0;
    if (isDirectory != requireDirectory || (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
        return Failure(
            requireDirectory ? "WATCH_ROOT_NOT_DIRECTORY" : "NOT_A_REGULAR_FILE",
            requireDirectory ? "The watch root must be a normal directory."
                             : "The target must be a normal regular file.");
    }

    FileInspectionResult result;
    result.ok = true;
    result.normalizedPath = normalized;
    return result;
}

int HexNibble(char value) {
    if (value >= '0' && value <= '9') return value - '0';
    if (value >= 'a' && value <= 'f') return value - 'a' + 10;
    if (value >= 'A' && value <= 'F') return value - 'A' + 10;
    return -1;
}

}  // namespace

std::string StableFileIdentity::ToKey() const {
    std::ostringstream stream;
    stream << std::hex << std::uppercase << std::setfill('0') << std::setw(16)
           << volumeSerial << ':';
    for (const unsigned char byte : fileId) {
        stream << std::setw(2) << static_cast<unsigned int>(byte);
    }
    return stream.str();
}

std::wstring NormalizePathForComparison(const std::wstring& path) {
    DWORD error = ERROR_SUCCESS;
    std::wstring normalized = GetNormalizedAbsolutePath(StripExtendedPrefix(path), &error);
    std::transform(normalized.begin(), normalized.end(), normalized.begin(), [](wchar_t character) {
        return static_cast<wchar_t>(std::towlower(character));
    });
    return normalized;
}

static FileInspectionResult InspectExistingRegularFile(
    const std::wstring& absolutePath,
    bool allowRemoteVolume,
    bool requireStableIdentity) {
    FileInspectionResult result = ValidateCommonPath(absolutePath, false, allowRemoteVolume);
    if (!result.ok) return result;

    UniqueHandle handle(CreateFileW(
        result.normalizedPath.c_str(),
        FILE_READ_ATTRIBUTES,
        FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT,
        nullptr));
    if (handle.get() == INVALID_HANDLE_VALUE) {
        return Failure("FILE_OPEN_FAILED", "The file could not be opened for identity validation.", GetLastError());
    }

    FILE_ATTRIBUTE_TAG_INFO tagInfo{};
    if (!GetFileInformationByHandleEx(
            handle.get(), FileAttributeTagInfo, &tagInfo, sizeof(tagInfo))) {
        return Failure("FILE_ATTRIBUTES_FAILED", "File attributes could not be verified.", GetLastError());
    }
    if ((tagInfo.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
        tagInfo.ReparseTag != 0) {
        return Failure("NOT_A_REGULAR_FILE", "The target is a directory or reparse point.");
    }

    LARGE_INTEGER fileSize{};
    if (!GetFileSizeEx(handle.get(), &fileSize) || fileSize.QuadPart < 0) {
        return Failure("FILE_SIZE_FAILED", "The file size could not be verified.", GetLastError());
    }
    DWORD finalPathError = ERROR_SUCCESS;
    const std::wstring finalPath = FinalPathFromHandle(handle.get(), &finalPathError);
    if (finalPath.empty()) {
        return Failure("FINAL_PATH_FAILED", "The final file path could not be verified.", finalPathError);
    }
    if (NormalizePathForComparison(finalPath) != NormalizePathForComparison(result.normalizedPath)) {
        return Failure("PATH_RESOLVED_ELSEWHERE", "The file path resolved through an unexpected alias.");
    }

    FILE_ID_INFO fileIdInfo{};
    if (GetFileInformationByHandleEx(handle.get(), FileIdInfo, &fileIdInfo, sizeof(fileIdInfo))) {
        result.identity.volumeSerial = fileIdInfo.VolumeSerialNumber;
        std::copy(
            std::begin(fileIdInfo.FileId.Identifier),
            std::end(fileIdInfo.FileId.Identifier),
            result.identity.fileId.begin());
    } else if (requireStableIdentity) {
        return Failure("FILE_IDENTITY_FAILED", "Stable file identity is unavailable.", GetLastError());
    }
    result.fileSize = static_cast<std::uint64_t>(fileSize.QuadPart);
    return result;
}

FileInspectionResult InspectSafeRegularFile(const std::wstring& absolutePath) {
    return InspectExistingRegularFile(absolutePath, false, true);
}

FileInspectionResult InspectSafeDragSourceFile(const std::wstring& absolutePath) {
    return InspectExistingRegularFile(absolutePath, true, false);
}

FileInspectionResult InspectSafeDirectoryRoot(const std::wstring& absolutePath) {
    return ValidateCommonPath(absolutePath, true);
}

FileInspectionResult InspectSafeNewFileTarget(const std::wstring& absolutePath) {
    if (absolutePath.empty() || absolutePath.find(L'\0') != std::wstring::npos ||
        !IsAbsoluteLocalDrivePath(absolutePath) || HasAlternateStreamSyntax(absolutePath)) {
        return Failure(
            "INVALID_ABSOLUTE_PATH",
            "The target must be an absolute local-drive path without alternate streams.");
    }
    DWORD normalizeError = ERROR_SUCCESS;
    const std::wstring normalized = GetNormalizedAbsolutePath(absolutePath, &normalizeError);
    if (normalized.empty()) {
        return Failure("PATH_NORMALIZATION_FAILED", "The target path could not be normalized.", normalizeError);
    }
    const std::filesystem::path target(normalized);
    if (target == target.root_path() || target.filename().empty() ||
        target.filename() == L"." || target.filename() == L"..") {
        return Failure("INVALID_RENAME_TARGET", "The target file name is invalid.");
    }
    const auto parent = InspectSafeDirectoryRoot(target.parent_path().wstring());
    if (!parent.ok) return parent;

    const DWORD attributes = GetFileAttributesW(normalized.c_str());
    if (attributes != INVALID_FILE_ATTRIBUTES) {
        if ((attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0) {
            return Failure("REPARSE_POINT_NOT_ALLOWED", "The target is an existing reparse point.");
        }
        return Failure("RENAME_TARGET_EXISTS", "The target path already exists.", ERROR_FILE_EXISTS);
    }
    const DWORD targetError = GetLastError();
    if (targetError != ERROR_FILE_NOT_FOUND && targetError != ERROR_PATH_NOT_FOUND) {
        return Failure("RENAME_TARGET_CHECK_FAILED", "The target path could not be verified.", targetError);
    }
    FileInspectionResult result;
    result.ok = true;
    result.normalizedPath = normalized;
    return result;
}

bool TryParseIdentityKey(const std::string& key, StableFileIdentity* identity) {
    if (!identity || key.size() != 49 || key[16] != ':') return false;
    StableFileIdentity parsed;
    for (std::size_t index = 0; index < 16; ++index) {
        const int nibble = HexNibble(key[index]);
        if (nibble < 0) return false;
        parsed.volumeSerial = (parsed.volumeSerial << 4) | static_cast<std::uint64_t>(nibble);
    }
    for (std::size_t index = 0; index < parsed.fileId.size(); ++index) {
        const int high = HexNibble(key[17 + index * 2]);
        const int low = HexNibble(key[18 + index * 2]);
        if (high < 0 || low < 0) return false;
        parsed.fileId[index] = static_cast<unsigned char>((high << 4) | low);
    }
    *identity = parsed;
    return true;
}

}  // namespace oracle::file_identity
