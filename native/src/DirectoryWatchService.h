#pragma once

#include <cstddef>
#include <cstdint>
#include <memory>
#include <string>
#include <vector>

namespace oracle::directory_watch {

enum class EventKind {
    Added,
    Removed,
    Modified,
    Renamed,
    Overflow,
    RootUnavailable,
};

const char* EventKindName(EventKind kind) noexcept;

struct WatchRootConfig {
    std::string rootId;
    std::wstring absolutePath;
    bool recursive = true;
};

struct WatchStartResult {
    bool ok = false;
    std::size_t rootCount = 0;
    unsigned long win32Error = 0;
    std::string errorCode;
    std::string errorMessage;
};

struct TrackFileResult {
    bool ok = false;
    std::string recordId;
    std::wstring normalizedPath;
    std::string identityKey;
    unsigned long win32Error = 0;
    std::string errorCode;
    std::string errorMessage;
};

struct DirectoryWatchEvent {
    std::uint64_t sequence = 0;
    EventKind kind = EventKind::Modified;
    std::string rootId;
    std::string recordId;
    std::wstring path;
    std::wstring oldPath;
    std::string identityKey;
    bool sameVolumeIdentityMatched = false;
    std::uint64_t observedAtMilliseconds = 0;
};

class DirectoryWatchService final {
  public:
    static constexpr std::size_t kMaximumRoots = 16;
    static constexpr std::size_t kMaximumQueuedEvents = 2048;

    DirectoryWatchService();
    ~DirectoryWatchService();

    DirectoryWatchService(const DirectoryWatchService&) = delete;
    DirectoryWatchService& operator=(const DirectoryWatchService&) = delete;

    WatchStartResult Start(std::vector<WatchRootConfig> roots);
    void Stop();
    bool IsRunning() const noexcept;
    std::vector<WatchRootConfig> ConfiguredRoots() const;

    TrackFileResult TrackKnownFile(
        const std::string& recordId,
        const std::wstring& absolutePath,
        const std::string& expectedIdentityKey = {});
    bool UntrackKnownFile(const std::string& recordId);

    std::vector<DirectoryWatchEvent> DrainEvents(std::size_t maximumEvents = 256);

  private:
    class Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace oracle::directory_watch
