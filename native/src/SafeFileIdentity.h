#pragma once

#include <array>
#include <cstdint>
#include <string>

namespace oracle::file_identity {

struct StableFileIdentity {
    std::uint64_t volumeSerial = 0;
    std::array<unsigned char, 16> fileId{};

    bool operator==(const StableFileIdentity&) const = default;
    std::string ToKey() const;
};

struct FileInspectionResult {
    bool ok = false;
    StableFileIdentity identity;
    std::wstring normalizedPath;
    std::uint64_t fileSize = 0;
    unsigned long win32Error = 0;
    std::string errorCode;
    std::string errorMessage;
};

// Captures identity using a short-lived FILE_READ_ATTRIBUTES handle. Every
// handle opened here is closed before this function returns. The full path,
// including parent components, must be non-reparse and the file must be a
// regular file on a local fixed volume.
FileInspectionResult InspectSafeRegularFile(const std::wstring& absolutePath);

// Validates an existing file for read-only Shell drag. Unlike lifecycle
// operations, this permits normal UNC/remote-volume paths when the share is
// reachable. Device namespaces, traversal, alternate streams, reparse-point
// parents/finals, directories, and final-path aliases remain rejected.
FileInspectionResult InspectSafeDragSourceFile(const std::wstring& absolutePath);

// Validates an explicit directory root without enumerating it. Volume roots,
// relative paths, alternate data streams, and reparse points are rejected.
FileInspectionResult InspectSafeDirectoryRoot(const std::wstring& absolutePath);

// Validates a not-yet-created regular-file destination. The parent must pass
// the same fixed-volume/non-reparse checks and the exact target must not exist.
FileInspectionResult InspectSafeNewFileTarget(const std::wstring& absolutePath);

bool TryParseIdentityKey(const std::string& key, StableFileIdentity* identity);
std::wstring NormalizePathForComparison(const std::wstring& path);

}  // namespace oracle::file_identity
