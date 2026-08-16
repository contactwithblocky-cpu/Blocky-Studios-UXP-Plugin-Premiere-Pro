#include "DirectoryWatchService.h"

#include "SafeFileIdentity.h"

#include <Windows.h>

#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <condition_variable>
#include <deque>
#include <filesystem>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <set>
#include <thread>
#include <unordered_map>
#include <utility>

namespace oracle::directory_watch {
namespace {

using Clock = std::chrono::steady_clock;
constexpr auto kCoalesceDelay = std::chrono::milliseconds(90);
constexpr auto kMissingVerificationDelay = std::chrono::milliseconds(275);
constexpr auto kRenamePairDelay = std::chrono::milliseconds(175);
constexpr auto kReconciledDepartureDelay = std::chrono::milliseconds(750);
constexpr std::size_t kMaximumReconciledDepartures = 2048;
constexpr DWORD kNotifyFilter = FILE_NOTIFY_CHANGE_FILE_NAME | FILE_NOTIFY_CHANGE_DIR_NAME |
    FILE_NOTIFY_CHANGE_SIZE | FILE_NOTIFY_CHANGE_LAST_WRITE | FILE_NOTIFY_CHANGE_CREATION;

struct HandleCloser {
    void operator()(void* value) const noexcept {
        const HANDLE handle = static_cast<HANDLE>(value);
        if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    }
};

using UniqueHandle = std::unique_ptr<void, HandleCloser>;

std::uint64_t MonotonicMilliseconds() {
    return static_cast<std::uint64_t>(
        std::chrono::duration_cast<std::chrono::milliseconds>(Clock::now().time_since_epoch()).count());
}

std::wstring CoalesceKey(const DirectoryWatchEvent& event) {
    std::wstring key;
    key.reserve(event.path.size() + event.oldPath.size() + event.identityKey.size() + 64);
    key.append(event.rootId.begin(), event.rootId.end());
    key.push_back(L'|');
    key.append(std::to_wstring(static_cast<int>(event.kind)));
    key.push_back(L'|');
    if (!event.identityKey.empty()) {
        key.append(event.identityKey.begin(), event.identityKey.end());
    } else {
        key.append(file_identity::NormalizePathForComparison(event.oldPath));
        key.push_back(L'>');
        key.append(file_identity::NormalizePathForComparison(event.path));
    }
    return key;
}

bool IsPathWithinRoot(const std::wstring& path, const std::wstring& root) {
    const std::wstring normalizedPath = file_identity::NormalizePathForComparison(path);
    std::wstring normalizedRoot = file_identity::NormalizePathForComparison(root);
    if (normalizedRoot.empty() || normalizedPath.size() <= normalizedRoot.size()) return false;
    if (normalizedRoot.back() != L'\\') normalizedRoot.push_back(L'\\');
    return normalizedPath.rfind(normalizedRoot, 0) == 0;
}

}  // namespace

const char* EventKindName(EventKind kind) noexcept {
    switch (kind) {
        case EventKind::Added: return "added";
        case EventKind::Removed: return "removed";
        case EventKind::Modified: return "modified";
        case EventKind::Renamed: return "renamed";
        case EventKind::Overflow: return "overflow";
        case EventKind::RootUnavailable: return "rootUnavailable";
    }
    return "modified";
}

class DirectoryWatchService::Impl final {
  public:
    ~Impl() { Stop(); }

    struct KnownFile {
        std::string recordId;
        std::wstring path;
        file_identity::StableFileIdentity identity;
    };

    struct RootState {
        WatchRootConfig config;
        std::wstring normalizedPath;
        UniqueHandle directory;
        UniqueHandle event;
        OVERLAPPED overlapped{};
        std::array<unsigned char, 64 * 1024> buffer{};
        bool requestPending = false;
    };

    struct PendingEvent {
        DirectoryWatchEvent event;
        Clock::time_point due;
    };

    struct PendingRename {
        std::wstring oldPath;
        std::string recordId;
        std::string identityKey;
        Clock::time_point due;
    };

    struct PendingRemoval {
        DirectoryWatchEvent event;
        Clock::time_point due;
    };

    WatchStartResult Start(std::vector<WatchRootConfig> requestedRoots) {
        Stop();
        {
            std::lock_guard lock(eventMutex_);
            events_.clear();
        }
        WatchStartResult result;
        if (requestedRoots.empty() || requestedRoots.size() > DirectoryWatchService::kMaximumRoots) {
            result.errorCode = "INVALID_WATCH_ROOT_COUNT";
            result.errorMessage = "Directory watching requires between 1 and 16 explicit roots.";
            return result;
        }

        std::set<std::string> ids;
        std::vector<std::unique_ptr<RootState>> prepared;
        prepared.reserve(requestedRoots.size());
        for (auto& config : requestedRoots) {
            if (config.rootId.empty() || config.rootId.size() > 128 || !ids.insert(config.rootId).second) {
                result.errorCode = "INVALID_WATCH_ROOT_ID";
                result.errorMessage = "Watch root IDs must be unique non-empty strings.";
                return result;
            }
            const auto inspection = file_identity::InspectSafeDirectoryRoot(config.absolutePath);
            if (!inspection.ok) {
                result.win32Error = inspection.win32Error;
                result.errorCode = inspection.errorCode;
                result.errorMessage = inspection.errorMessage;
                return result;
            }
            const std::wstring comparison = file_identity::NormalizePathForComparison(inspection.normalizedPath);
            for (const auto& existing : prepared) {
                const std::wstring existingComparison =
                    file_identity::NormalizePathForComparison(existing->normalizedPath);
                const bool equalRoot = comparison == existingComparison;
                const bool coveredByExisting =
                    existing->config.recursive && IsPathWithinRoot(comparison, existingComparison);
                const bool existingCoveredByRequested =
                    config.recursive && IsPathWithinRoot(existingComparison, comparison);
                if (equalRoot || coveredByExisting || existingCoveredByRequested) {
                    result.errorCode = "OVERLAPPING_WATCH_ROOTS";
                    result.errorMessage =
                        "Equal watch roots and nested roots already covered by a recursive watcher are not allowed.";
                    return result;
                }
            }

            auto root = std::make_unique<RootState>();
            root->config = std::move(config);
            root->normalizedPath = inspection.normalizedPath;
            root->directory.reset(CreateFileW(
                root->normalizedPath.c_str(),
                FILE_LIST_DIRECTORY,
                FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                nullptr,
                OPEN_EXISTING,
                FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OVERLAPPED | FILE_FLAG_OPEN_REPARSE_POINT,
                nullptr));
            if (root->directory.get() == INVALID_HANDLE_VALUE) {
                result.win32Error = GetLastError();
                result.errorCode = "WATCH_ROOT_OPEN_FAILED";
                result.errorMessage = "A watch root could not be opened.";
                return result;
            }
            root->event.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
            if (!root->event) {
                result.win32Error = GetLastError();
                result.errorCode = "WATCH_EVENT_CREATE_FAILED";
                result.errorMessage = "A watcher cancellation event could not be created.";
                return result;
            }
            root->overlapped.hEvent = root->event.get();
            prepared.push_back(std::move(root));
        }

        {
            std::lock_guard lock(knownMutex_);
            for (const auto& [recordId, known] : knownByRecord_) {
                const bool covered = std::any_of(prepared.begin(), prepared.end(), [&](const auto& root) {
                    return IsPathWithinRoot(known.path, root->normalizedPath);
                });
                if (!covered) {
                    result.errorCode = "KNOWN_FILE_OUTSIDE_WATCH_ROOTS";
                    result.errorMessage =
                        "Every tracked replay must remain inside an explicit watch root.";
                    return result;
                }
            }
        }

        stopEvent_.reset(CreateEventW(nullptr, TRUE, FALSE, nullptr));
        if (!stopEvent_) {
            result.win32Error = GetLastError();
            result.errorCode = "WATCH_STOP_EVENT_FAILED";
            result.errorMessage = "The watcher stop event could not be created.";
            return result;
        }
        roots_ = std::move(prepared);
        stopping_.store(false);
        for (auto& root : roots_) {
            if (!Arm(*root)) {
                result.win32Error = GetLastError();
                result.errorCode = "WATCH_REQUEST_FAILED";
                result.errorMessage = "ReadDirectoryChangesW could not be started.";
                StopPreparedRoots();
                return result;
            }
        }
        running_.store(true);
        worker_ = std::thread(&Impl::ThreadMain, this);
        result.ok = true;
        result.rootCount = roots_.size();
        return result;
    }

    void Stop() {
        if (!running_.exchange(false)) {
            StopPreparedRoots();
            return;
        }
        stopping_.store(true);
        if (stopEvent_) SetEvent(stopEvent_.get());
        for (auto& root : roots_) {
            if (root->directory) CancelIoEx(root->directory.get(), &root->overlapped);
        }
        if (worker_.joinable()) worker_.join();
        StopPreparedRoots();
        stopping_.store(false);
    }

    bool IsRunning() const noexcept { return running_.load(); }

    std::vector<WatchRootConfig> ConfiguredRoots() const {
        std::vector<WatchRootConfig> output;
        output.reserve(roots_.size());
        for (const auto& root : roots_) output.push_back(root->config);
        return output;
    }

    TrackFileResult TrackKnownFile(
        const std::string& recordId,
        const std::wstring& absolutePath,
        const std::string& expectedIdentityKey) {
        TrackFileResult result;
        result.recordId = recordId;
        if (recordId.empty() || recordId.size() > 256) {
            result.errorCode = "INVALID_RECORD_ID";
            result.errorMessage = "Tracked replay record IDs must be non-empty bounded strings.";
            return result;
        }
        const auto inspection = file_identity::InspectSafeRegularFile(absolutePath);
        if (!inspection.ok) {
            result.win32Error = inspection.win32Error;
            result.errorCode = inspection.errorCode;
            result.errorMessage = inspection.errorMessage;
            return result;
        }
        if (running_.load()) {
            const bool covered = std::any_of(roots_.begin(), roots_.end(), [&](const auto& root) {
                return IsPathWithinRoot(inspection.normalizedPath, root->normalizedPath);
            });
            if (!covered) {
                result.errorCode = "PATH_OUTSIDE_WATCH_ROOTS";
                result.errorMessage =
                    "Tracked media must be inside an explicitly configured watch root.";
                return result;
            }
        }
        if (!expectedIdentityKey.empty()) {
            file_identity::StableFileIdentity expected;
            if (!file_identity::TryParseIdentityKey(expectedIdentityKey, &expected)) {
                result.errorCode = "INVALID_IDENTITY_KEY";
                result.errorMessage = "The expected file identity key is malformed.";
                return result;
            }
            if (expected != inspection.identity) {
                result.errorCode = "FILE_IDENTITY_CHANGED";
                result.errorMessage = "The tracked path no longer has the expected identity.";
                return result;
            }
        }
        {
            std::lock_guard lock(knownMutex_);
            if (knownByRecord_.size() >= 10000 && !knownByRecord_.contains(recordId)) {
                result.errorCode = "TRACKED_FILE_LIMIT_REACHED";
                result.errorMessage = "The watcher known-file registry is full.";
                return result;
            }
            const auto previous = knownByRecord_.find(recordId);
            if (previous != knownByRecord_.end()) {
                recordByPath_.erase(file_identity::NormalizePathForComparison(previous->second.path));
                RemoveIdentityIndexEntry(previous->second.identity.ToKey(), recordId);
            }
            KnownFile file{recordId, inspection.normalizedPath, inspection.identity};
            knownByRecord_[recordId] = file;
            recordByPath_[file_identity::NormalizePathForComparison(file.path)] = recordId;
            recordsByIdentity_[file.identity.ToKey()].insert(recordId);
        }
        result.ok = true;
        result.normalizedPath = inspection.normalizedPath;
        result.identityKey = inspection.identity.ToKey();
        return result;
    }

    bool UntrackKnownFile(const std::string& recordId) {
        std::lock_guard lock(knownMutex_);
        const auto found = knownByRecord_.find(recordId);
        if (found == knownByRecord_.end()) return false;
        recordByPath_.erase(file_identity::NormalizePathForComparison(found->second.path));
        RemoveIdentityIndexEntry(found->second.identity.ToKey(), recordId);
        knownByRecord_.erase(found);
        return true;
    }

    std::vector<DirectoryWatchEvent> DrainEvents(std::size_t maximumEvents) {
        maximumEvents = std::clamp<std::size_t>(maximumEvents, 1, 1024);
        std::vector<DirectoryWatchEvent> output;
        std::lock_guard lock(eventMutex_);
        const std::size_t count = std::min(maximumEvents, events_.size());
        output.reserve(count);
        for (std::size_t index = 0; index < count; ++index) {
            output.push_back(std::move(events_.front()));
            events_.pop_front();
        }
        return output;
    }

  private:
    bool Arm(RootState& root) {
        ResetEvent(root.event.get());
        root.overlapped.Internal = 0;
        root.overlapped.InternalHigh = 0;
        root.overlapped.Offset = 0;
        root.overlapped.OffsetHigh = 0;
        DWORD ignored = 0;
        const BOOL started = ReadDirectoryChangesW(
            root.directory.get(),
            root.buffer.data(),
            static_cast<DWORD>(root.buffer.size()),
            root.config.recursive,
            kNotifyFilter,
            &ignored,
            &root.overlapped,
            nullptr);
        root.requestPending = started != FALSE;
        return started != FALSE;
    }

    void ThreadMain() {
        std::vector<HANDLE> handles;
        handles.reserve(roots_.size() + 1);
        handles.push_back(stopEvent_.get());
        for (const auto& root : roots_) handles.push_back(root->event.get());

        while (!stopping_.load()) {
            const DWORD waitResult = WaitForMultipleObjects(
                static_cast<DWORD>(handles.size()), handles.data(), FALSE, 50);
            if (waitResult == WAIT_OBJECT_0) break;
            if (waitResult >= WAIT_OBJECT_0 + 1 &&
                waitResult < WAIT_OBJECT_0 + handles.size()) {
                const std::size_t rootIndex = waitResult - WAIT_OBJECT_0 - 1;
                ProcessCompletedRoot(*roots_[rootIndex]);
            } else if (waitResult == WAIT_FAILED) {
                QueueImmediate(DirectoryWatchEvent{
                    .kind = EventKind::RootUnavailable,
                    .observedAtMilliseconds = MonotonicMilliseconds(),
                });
                break;
            }
            FlushDueEvents();
        }
        for (auto& root : roots_) {
            if (root->directory && root->requestPending) {
                CancelIoEx(root->directory.get(), &root->overlapped);
                DWORD ignored = 0;
                GetOverlappedResult(root->directory.get(), &root->overlapped, &ignored, TRUE);
                root->requestPending = false;
            }
        }
        FlushDueEvents(true);
    }

    void ProcessCompletedRoot(RootState& root) {
        DWORD bytes = 0;
        const BOOL completed = GetOverlappedResult(root.directory.get(), &root.overlapped, &bytes, FALSE);
        root.requestPending = false;
        if (!completed) {
            const DWORD error = GetLastError();
            if (error != ERROR_OPERATION_ABORTED && !stopping_.load()) {
                QueueImmediate(DirectoryWatchEvent{
                    .kind = EventKind::RootUnavailable,
                    .rootId = root.config.rootId,
                    .path = root.normalizedPath,
                    .observedAtMilliseconds = MonotonicMilliseconds(),
                });
            }
        } else if (bytes == 0) {
            QueueImmediate(DirectoryWatchEvent{
                .kind = EventKind::Overflow,
                .rootId = root.config.rootId,
                .path = root.normalizedPath,
                .observedAtMilliseconds = MonotonicMilliseconds(),
            });
        } else {
            ParseBuffer(root, bytes);
        }
        if (!stopping_.load() && !Arm(root)) {
            QueueImmediate(DirectoryWatchEvent{
                .kind = EventKind::RootUnavailable,
                .rootId = root.config.rootId,
                .path = root.normalizedPath,
                .observedAtMilliseconds = MonotonicMilliseconds(),
            });
        }
    }

    void ParseBuffer(RootState& root, DWORD bytes) {
        std::size_t offset = 0;
        while (offset + sizeof(FILE_NOTIFY_INFORMATION) <= bytes) {
            const auto* notification = reinterpret_cast<const FILE_NOTIFY_INFORMATION*>(
                root.buffer.data() + offset);
            const std::size_t characterCount = notification->FileNameLength / sizeof(wchar_t);
            std::wstring relative(notification->FileName, characterCount);
            const std::filesystem::path absolute =
                (std::filesystem::path(root.normalizedPath) / relative).lexically_normal();
            if (IsPathWithinRoot(absolute.wstring(), root.normalizedPath)) {
                ProcessNotification(root, notification->Action, absolute.wstring());
            }
            if (notification->NextEntryOffset == 0) break;
            if (notification->NextEntryOffset < sizeof(FILE_NOTIFY_INFORMATION) ||
                offset + notification->NextEntryOffset > bytes) {
                QueueImmediate(DirectoryWatchEvent{
                    .kind = EventKind::Overflow,
                    .rootId = root.config.rootId,
                    .path = root.normalizedPath,
                    .observedAtMilliseconds = MonotonicMilliseconds(),
                });
                break;
            }
            offset += notification->NextEntryOffset;
        }
    }

    std::optional<KnownFile> FindKnownByPath(const std::wstring& path) {
        std::lock_guard lock(knownMutex_);
        const auto foundRecord = recordByPath_.find(file_identity::NormalizePathForComparison(path));
        if (foundRecord == recordByPath_.end()) return std::nullopt;
        const auto found = knownByRecord_.find(foundRecord->second);
        return found == knownByRecord_.end() ? std::nullopt : std::optional<KnownFile>(found->second);
    }

    void RemoveIdentityIndexEntry(const std::string& identityKey, const std::string& recordId) {
        const auto indexed = recordsByIdentity_.find(identityKey);
        if (indexed == recordsByIdentity_.end()) return;
        indexed->second.erase(recordId);
        if (indexed->second.empty()) recordsByIdentity_.erase(indexed);
    }

    bool TryScheduleKnownIdentityMove(
        RootState& destinationRoot,
        const std::wstring& newPath,
        const file_identity::FileInspectionResult& inspection) {
        if (!inspection.ok) return false;
        const std::wstring normalizedNewPath =
            file_identity::NormalizePathForComparison(inspection.normalizedPath);
        const std::string identityKey = inspection.identity.ToKey();
        std::optional<KnownFile> selected;
        {
            std::lock_guard lock(knownMutex_);
            const auto indexed = recordsByIdentity_.find(identityKey);
            if (indexed == recordsByIdentity_.end()) return false;
            for (const auto& recordId : indexed->second) {
                const auto known = knownByRecord_.find(recordId);
                if (known == knownByRecord_.end() ||
                    file_identity::NormalizePathForComparison(known->second.path) == normalizedNewPath) {
                    continue;
                }
                const DWORD attributes = GetFileAttributesW(known->second.path.c_str());
                if (attributes != INVALID_FILE_ATTRIBUTES) continue;
                const DWORD error = GetLastError();
                if (error != ERROR_FILE_NOT_FOUND && error != ERROR_PATH_NOT_FOUND) continue;
                if (selected) {
                    // Two missing known records with the same stable identity
                    // are ambiguous (for example, tracked hard links). Emit
                    // honest add/remove events instead of guessing ownership.
                    return false;
                }
                selected = known->second;
            }
            if (!selected) return false;

            const auto tracked = knownByRecord_.find(selected->recordId);
            if (tracked == knownByRecord_.end() || tracked->second.identity != inspection.identity) {
                return false;
            }
            recordByPath_.erase(file_identity::NormalizePathForComparison(tracked->second.path));
            tracked->second.path = inspection.normalizedPath;
            tracked->second.identity = inspection.identity;
            recordByPath_[normalizedNewPath] = tracked->first;
        }

        CancelPendingDeparture(*selected);
        RememberReconciledDeparture(selected->path, inspection.normalizedPath);
        DirectoryWatchEvent event;
        event.kind = EventKind::Renamed;
        event.rootId = destinationRoot.config.rootId;
        event.recordId = selected->recordId;
        event.oldPath = selected->path;
        event.path = inspection.normalizedPath;
        event.identityKey = identityKey;
        event.sameVolumeIdentityMatched = true;
        event.observedAtMilliseconds = MonotonicMilliseconds();
        ScheduleCoalesced(std::move(event));
        return true;
    }

    void CancelPendingDeparture(const KnownFile& known) {
        const std::wstring oldPathKey = file_identity::NormalizePathForComparison(known.path);
        pendingRemovals_.erase(oldPathKey);
        for (auto iterator = pendingRenames_.begin(); iterator != pendingRenames_.end();) {
            auto& queue = iterator->second;
            std::erase_if(queue, [&](const PendingRename& pending) {
                return pending.recordId == known.recordId ||
                    file_identity::NormalizePathForComparison(pending.oldPath) == oldPathKey;
            });
            if (queue.empty()) {
                iterator = pendingRenames_.erase(iterator);
            } else {
                ++iterator;
            }
        }
        for (auto iterator = pendingEvents_.begin(); iterator != pendingEvents_.end();) {
            const auto& event = iterator->second.event;
            if (event.kind == EventKind::Removed &&
                (event.recordId == known.recordId ||
                 file_identity::NormalizePathForComparison(event.path) == oldPathKey)) {
                iterator = pendingEvents_.erase(iterator);
            } else {
                ++iterator;
            }
        }
        std::lock_guard eventLock(eventMutex_);
        std::erase_if(events_, [&](const DirectoryWatchEvent& event) {
            return event.kind == EventKind::Removed &&
                (event.recordId == known.recordId ||
                 file_identity::NormalizePathForComparison(event.path) == oldPathKey);
        });
    }

    void RememberReconciledDeparture(const std::wstring& oldPath, const std::wstring& newPath) {
        const auto now = Clock::now();
        const std::wstring oldKey = file_identity::NormalizePathForComparison(oldPath);
        const std::wstring newKey = file_identity::NormalizePathForComparison(newPath);
        recentlyReconciledDepartures_.erase(newKey);
        for (auto iterator = recentlyReconciledDepartures_.begin();
             iterator != recentlyReconciledDepartures_.end();) {
            if (iterator->second <= now) {
                iterator = recentlyReconciledDepartures_.erase(iterator);
            } else {
                ++iterator;
            }
        }
        if (recentlyReconciledDepartures_.size() >= kMaximumReconciledDepartures) {
            const auto oldest = std::min_element(
                recentlyReconciledDepartures_.begin(),
                recentlyReconciledDepartures_.end(),
                [](const auto& left, const auto& right) { return left.second < right.second; });
            if (oldest != recentlyReconciledDepartures_.end()) {
                recentlyReconciledDepartures_.erase(oldest);
            }
        }
        recentlyReconciledDepartures_[oldKey] = now + kReconciledDepartureDelay;
    }

    bool ConsumeReconciledDeparture(const std::wstring& path) {
        const auto found = recentlyReconciledDepartures_.find(
            file_identity::NormalizePathForComparison(path));
        if (found == recentlyReconciledDepartures_.end()) return false;
        const bool current = found->second > Clock::now();
        recentlyReconciledDepartures_.erase(found);
        return current;
    }

    void ProcessNotification(RootState& root, DWORD action, const std::wstring& path) {
        const auto now = Clock::now();
        if ((action == FILE_ACTION_RENAMED_OLD_NAME || action == FILE_ACTION_REMOVED) &&
            ConsumeReconciledDeparture(path)) {
            return;
        }
        const auto known = FindKnownByPath(path);
        switch (action) {
            case FILE_ACTION_RENAMED_OLD_NAME: {
                pendingRenames_[root.config.rootId].push_back(PendingRename{
                    path,
                    known ? known->recordId : std::string{},
                    known ? known->identity.ToKey() : std::string{},
                    now + kRenamePairDelay,
                });
                break;
            }
            case FILE_ACTION_RENAMED_NEW_NAME: {
                const auto inspection = file_identity::InspectSafeRegularFile(path);
                auto found = pendingRenames_.find(root.config.rootId);
                if (found == pendingRenames_.end() || found->second.empty()) {
                    if (TryScheduleKnownIdentityMove(root, path, inspection)) break;
                    ScheduleSimple(root, EventKind::Added, path);
                    break;
                }
                auto selected = found->second.end();
                if (inspection.ok) {
                    const std::string newIdentity = inspection.identity.ToKey();
                    const auto identityMatch = std::find_if(
                        found->second.begin(),
                        found->second.end(),
                        [&](const PendingRename& pending) {
                            return !pending.identityKey.empty() && pending.identityKey == newIdentity;
                        });
                    if (identityMatch != found->second.end()) {
                        selected = identityMatch;
                    } else {
                        selected = std::find_if(
                            found->second.begin(),
                            found->second.end(),
                            [](const PendingRename& pending) { return pending.identityKey.empty(); });
                    }
                } else {
                    selected = found->second.begin();
                }
                if (selected == found->second.end()) {
                    if (TryScheduleKnownIdentityMove(root, path, inspection)) break;
                    ScheduleSimple(root, EventKind::Added, path);
                    break;
                }
                PendingRename old = std::move(*selected);
                found->second.erase(selected);
                if (found->second.empty()) pendingRenames_.erase(found);
                DirectoryWatchEvent event;
                event.kind = EventKind::Renamed;
                event.rootId = root.config.rootId;
                event.oldPath = old.oldPath;
                event.path = path;
                event.recordId = old.recordId;
                event.identityKey = old.identityKey;
                event.observedAtMilliseconds = MonotonicMilliseconds();
                if (inspection.ok) {
                    const std::string newIdentity = inspection.identity.ToKey();
                    event.identityKey = newIdentity;
                    event.sameVolumeIdentityMatched = !old.identityKey.empty() && old.identityKey == newIdentity;
                    if (event.sameVolumeIdentityMatched && !event.recordId.empty()) {
                        std::lock_guard lock(knownMutex_);
                        const auto tracked = knownByRecord_.find(event.recordId);
                        if (tracked != knownByRecord_.end()) {
                            recordByPath_.erase(file_identity::NormalizePathForComparison(tracked->second.path));
                            tracked->second.path = inspection.normalizedPath;
                            recordByPath_[file_identity::NormalizePathForComparison(inspection.normalizedPath)] =
                                tracked->first;
                        }
                    }
                }
                pendingRemovals_.erase(file_identity::NormalizePathForComparison(old.oldPath));
                ScheduleCoalesced(std::move(event));
                break;
            }
            case FILE_ACTION_ADDED: {
                pendingRemovals_.erase(file_identity::NormalizePathForComparison(path));
                const auto inspection = file_identity::InspectSafeRegularFile(path);
                if (TryScheduleKnownIdentityMove(root, path, inspection)) break;
                ScheduleSimple(root, EventKind::Added, path);
                break;
            }
            case FILE_ACTION_REMOVED:
                ScheduleRemoval(root, path, known);
                break;
            case FILE_ACTION_MODIFIED:
                ScheduleSimple(root, EventKind::Modified, path);
                break;
            default:
                break;
        }
    }

    void ScheduleSimple(RootState& root, EventKind kind, const std::wstring& path) {
        const DWORD attributes = GetFileAttributesW(path.c_str());
        if (attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0) {
            return;
        }
        DirectoryWatchEvent event;
        event.kind = kind;
        event.rootId = root.config.rootId;
        event.path = path;
        event.observedAtMilliseconds = MonotonicMilliseconds();
        const auto known = FindKnownByPath(path);
        if (known) {
            event.recordId = known->recordId;
            event.identityKey = known->identity.ToKey();
        } else {
            const auto inspection = file_identity::InspectSafeRegularFile(path);
            if (inspection.ok) event.identityKey = inspection.identity.ToKey();
        }
        ScheduleCoalesced(std::move(event));
    }

    void ScheduleRemoval(
        RootState& root,
        const std::wstring& path,
        const std::optional<KnownFile>& known) {
        DirectoryWatchEvent event;
        event.kind = EventKind::Removed;
        event.rootId = root.config.rootId;
        event.path = path;
        event.observedAtMilliseconds = MonotonicMilliseconds();
        if (known) {
            event.recordId = known->recordId;
            event.identityKey = known->identity.ToKey();
        }
        pendingRemovals_[file_identity::NormalizePathForComparison(path)] =
            PendingRemoval{std::move(event), Clock::now() + kMissingVerificationDelay};
    }

    void ScheduleMissingFromRename(RootState& root, const PendingRename& rename) {
        DirectoryWatchEvent event;
        event.kind = EventKind::Removed;
        event.rootId = root.config.rootId;
        event.recordId = rename.recordId;
        event.path = rename.oldPath;
        event.identityKey = rename.identityKey;
        event.observedAtMilliseconds = MonotonicMilliseconds();
        pendingRemovals_[file_identity::NormalizePathForComparison(rename.oldPath)] =
            PendingRemoval{std::move(event), Clock::now() + kMissingVerificationDelay};
    }

    void ScheduleCoalesced(DirectoryWatchEvent event) {
        const std::wstring key = CoalesceKey(event);
        pendingEvents_[key] = PendingEvent{std::move(event), Clock::now() + kCoalesceDelay};
    }

    void FlushDueEvents(bool force = false) {
        const auto now = Clock::now();
        for (auto iterator = recentlyReconciledDepartures_.begin();
             iterator != recentlyReconciledDepartures_.end();) {
            if (force || iterator->second <= now) {
                iterator = recentlyReconciledDepartures_.erase(iterator);
            } else {
                ++iterator;
            }
        }
        for (auto iterator = pendingRenames_.begin(); iterator != pendingRenames_.end();) {
            RootState* root = nullptr;
            for (const auto& candidate : roots_) {
                if (candidate->config.rootId == iterator->first) {
                    root = candidate.get();
                    break;
                }
            }
            auto& queue = iterator->second;
            for (auto pending = queue.begin(); pending != queue.end();) {
                if (!force && pending->due > now) {
                    ++pending;
                    continue;
                }
                if (root) ScheduleMissingFromRename(*root, *pending);
                pending = queue.erase(pending);
            }
            if (queue.empty()) {
                iterator = pendingRenames_.erase(iterator);
            } else {
                ++iterator;
            }
        }
        for (auto iterator = pendingRemovals_.begin(); iterator != pendingRemovals_.end();) {
            if (!force && iterator->second.due > now) {
                ++iterator;
                continue;
            }
            const DWORD attributes = GetFileAttributesW(iterator->second.event.path.c_str());
            if (attributes == INVALID_FILE_ATTRIBUTES) {
                const DWORD error = GetLastError();
                if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND) {
                    ScheduleCoalesced(std::move(iterator->second.event));
                }
            }
            iterator = pendingRemovals_.erase(iterator);
        }
        for (auto iterator = pendingEvents_.begin(); iterator != pendingEvents_.end();) {
            if (!force && iterator->second.due > now) {
                ++iterator;
                continue;
            }
            QueueImmediate(std::move(iterator->second.event));
            iterator = pendingEvents_.erase(iterator);
        }
    }

    void QueueImmediate(DirectoryWatchEvent event) {
        event.sequence = nextSequence_.fetch_add(1);
        if (event.observedAtMilliseconds == 0) event.observedAtMilliseconds = MonotonicMilliseconds();
        std::lock_guard lock(eventMutex_);
        if (events_.size() >= DirectoryWatchService::kMaximumQueuedEvents) {
            events_.pop_front();
            if (events_.empty() || events_.back().kind != EventKind::Overflow) {
                DirectoryWatchEvent overflow;
                overflow.sequence = nextSequence_.fetch_add(1);
                overflow.kind = EventKind::Overflow;
                overflow.observedAtMilliseconds = MonotonicMilliseconds();
                events_.push_back(std::move(overflow));
            }
        }
        if (events_.size() < DirectoryWatchService::kMaximumQueuedEvents) {
            events_.push_back(std::move(event));
        }
    }

    void StopPreparedRoots() {
        for (auto& root : roots_) {
            if (root->directory && root->requestPending) {
                CancelIoEx(root->directory.get(), &root->overlapped);
                root->requestPending = false;
            }
        }
        roots_.clear();
        stopEvent_.reset();
        pendingEvents_.clear();
        pendingRenames_.clear();
        pendingRemovals_.clear();
        recentlyReconciledDepartures_.clear();
    }

    std::vector<std::unique_ptr<RootState>> roots_;
    UniqueHandle stopEvent_;
    std::thread worker_;
    std::atomic<bool> running_{false};
    std::atomic<bool> stopping_{false};
    std::atomic<std::uint64_t> nextSequence_{1};

    std::mutex knownMutex_;
    std::unordered_map<std::string, KnownFile> knownByRecord_;
    std::map<std::wstring, std::string> recordByPath_;
    std::unordered_map<std::string, std::set<std::string>> recordsByIdentity_;

    std::mutex eventMutex_;
    std::deque<DirectoryWatchEvent> events_;
    std::map<std::wstring, PendingEvent> pendingEvents_;
    std::map<std::string, std::deque<PendingRename>> pendingRenames_;
    std::map<std::wstring, PendingRemoval> pendingRemovals_;
    std::map<std::wstring, Clock::time_point> recentlyReconciledDepartures_;
};

DirectoryWatchService::DirectoryWatchService() : impl_(std::make_unique<Impl>()) {}
DirectoryWatchService::~DirectoryWatchService() = default;

WatchStartResult DirectoryWatchService::Start(std::vector<WatchRootConfig> roots) {
    return impl_->Start(std::move(roots));
}

void DirectoryWatchService::Stop() { impl_->Stop(); }
bool DirectoryWatchService::IsRunning() const noexcept { return impl_->IsRunning(); }
std::vector<WatchRootConfig> DirectoryWatchService::ConfiguredRoots() const {
    return impl_->ConfiguredRoots();
}

TrackFileResult DirectoryWatchService::TrackKnownFile(
    const std::string& recordId,
    const std::wstring& absolutePath,
    const std::string& expectedIdentityKey) {
    return impl_->TrackKnownFile(recordId, absolutePath, expectedIdentityKey);
}

bool DirectoryWatchService::UntrackKnownFile(const std::string& recordId) {
    return impl_->UntrackKnownFile(recordId);
}

std::vector<DirectoryWatchEvent> DirectoryWatchService::DrainEvents(std::size_t maximumEvents) {
    return impl_->DrainEvents(maximumEvents);
}

}  // namespace oracle::directory_watch
