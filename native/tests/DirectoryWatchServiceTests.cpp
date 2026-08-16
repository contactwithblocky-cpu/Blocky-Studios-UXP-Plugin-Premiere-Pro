#include "DirectoryWatchService.h"
#include "SafeFileIdentity.h"

#include <Windows.h>

#include <chrono>
#include <algorithm>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using oracle::directory_watch::DirectoryWatchEvent;
using oracle::directory_watch::DirectoryWatchService;
using oracle::directory_watch::EventKind;
using oracle::directory_watch::WatchRootConfig;

namespace {

void Require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

std::filesystem::path UniqueDirectory(const wchar_t* label) {
    return std::filesystem::temp_directory_path() /
        (std::wstring(L"oracle watcher ") + label + L" disposable " +
         std::to_wstring(GetCurrentProcessId()) + L" " + std::to_wstring(GetTickCount64()));
}

void WriteDisposableMedia(const std::filesystem::path& path, const std::string& marker, bool append = false) {
    std::ofstream stream(
        path,
        std::ios::binary | (append ? std::ios::app : std::ios::trunc));
    stream << "ORACLE_DISPOSABLE_WATCH_MEDIA:" << marker << '\n';
    stream.flush();
    Require(stream.good(), "could not write disposable watcher media");
}

std::vector<DirectoryWatchEvent> CollectFor(
    DirectoryWatchService& service,
    std::chrono::milliseconds duration) {
    std::vector<DirectoryWatchEvent> output;
    const auto deadline = std::chrono::steady_clock::now() + duration;
    while (std::chrono::steady_clock::now() < deadline) {
        auto events = service.DrainEvents(1024);
        output.insert(
            output.end(),
            std::make_move_iterator(events.begin()),
            std::make_move_iterator(events.end()));
        std::this_thread::sleep_for(std::chrono::milliseconds(25));
    }
    auto finalEvents = service.DrainEvents(1024);
    output.insert(
        output.end(),
        std::make_move_iterator(finalEvents.begin()),
        std::make_move_iterator(finalEvents.end()));
    return output;
}

void TestRootBoundsAndNoDriveScans() {
    DirectoryWatchService service;
    wchar_t windowsDirectory[MAX_PATH]{};
    Require(GetWindowsDirectoryW(windowsDirectory, MAX_PATH) != 0, "Windows directory unavailable");
    const std::filesystem::path volumeRoot = std::filesystem::path(windowsDirectory).root_path();
    const auto rootResult = service.Start({WatchRootConfig{"drive", volumeRoot.wstring(), true}});
    Require(
        !rootResult.ok && rootResult.errorCode == "VOLUME_ROOT_NOT_ALLOWED",
        "watcher accepted an entire drive scan");

    const auto parent = UniqueDirectory(L"root bounds");
    const auto nested = parent / L"nested";
    const auto linked = parent / L"linked";
    std::filesystem::create_directories(nested);

    const auto nestedNonrecursive = service.Start({
        WatchRootConfig{"parent-direct", parent.wstring(), false},
        WatchRootConfig{"nested-direct", nested.wstring(), false},
    });
    Require(
        nestedNonrecursive.ok && nestedNonrecursive.rootCount == 2,
        "watcher rejected nested nonrecursive roots that do not duplicate coverage");
    service.Stop();

    const auto recursiveChild = service.Start({
        WatchRootConfig{"parent-direct", parent.wstring(), false},
        WatchRootConfig{"nested-recursive", nested.wstring(), true},
    });
    Require(
        recursiveChild.ok && recursiveChild.rootCount == 2,
        "watcher rejected a recursive child under a nonrecursive parent");
    service.Stop();

    const auto overlap = service.Start({
        WatchRootConfig{"parent", parent.wstring(), true},
        WatchRootConfig{"nested", nested.wstring(), false},
    });
    Require(
        !overlap.ok && overlap.errorCode == "OVERLAPPING_WATCH_ROOTS",
        "watcher accepted a child already covered by a recursive parent");
    const auto reverseOverlap = service.Start({
        WatchRootConfig{"nested", nested.wstring(), false},
        WatchRootConfig{"parent", parent.wstring(), true},
    });
    Require(
        !reverseOverlap.ok && reverseOverlap.errorCode == "OVERLAPPING_WATCH_ROOTS",
        "watcher accepted recursive parent coverage when roots were supplied child-first");
    const auto equalRoots = service.Start({
        WatchRootConfig{"same-a", nested.wstring(), false},
        WatchRootConfig{"same-b", nested.wstring(), false},
    });
    Require(
        !equalRoots.ok && equalRoots.errorCode == "OVERLAPPING_WATCH_ROOTS",
        "watcher accepted equal nonrecursive roots");
    Require(
        CreateSymbolicLinkW(
            linked.c_str(),
            nested.c_str(),
            SYMBOLIC_LINK_FLAG_DIRECTORY | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE) != FALSE,
        "could not create disposable watcher reparse root");
    const auto reparse = service.Start({WatchRootConfig{"linked", linked.wstring(), true}});
    Require(
        !reparse.ok && reparse.errorCode == "REPARSE_POINT_NOT_ALLOWED",
        "watcher accepted a reparse-point root");
    std::filesystem::remove_all(parent);
}

void TestRenameIdentityCoalescingMissingDelayAndCancellation() {
    const auto parent = UniqueDirectory(L"events");
    const auto watched = parent / L"watched";
    const auto outside = parent / L"outside";
    std::filesystem::create_directories(watched);
    std::filesystem::create_directories(outside);
    const auto original = watched / L"original.mp4";
    const auto renamed = watched / L"renamed.mp4";
    WriteDisposableMedia(original, "rename");

    DirectoryWatchService service;
    const auto start = service.Start({WatchRootConfig{"replays", watched.wstring(), true}});
    Require(start.ok && start.rootCount == 1 && service.IsRunning(), "bounded watcher did not start");
    const auto tracked = service.TrackKnownFile("rename-record", original.wstring());
    Require(tracked.ok && !tracked.identityKey.empty(), "known file could not be tracked");

    Require(MoveFileExW(original.c_str(), renamed.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE, "external rename failed");
    const auto renameEvents = CollectFor(service, std::chrono::milliseconds(700));
    const auto rename = std::find_if(renameEvents.begin(), renameEvents.end(), [](const auto& event) {
        return event.kind == EventKind::Renamed && event.recordId == "rename-record";
    });
    Require(rename != renameEvents.end(), "same-volume external rename was not paired");
    Require(rename->sameVolumeIdentityMatched, "rename did not preserve stable file identity");
    Require(
        oracle::file_identity::NormalizePathForComparison(rename->oldPath) ==
            oracle::file_identity::NormalizePathForComparison(original.wstring()) &&
        oracle::file_identity::NormalizePathForComparison(rename->path) ==
            oracle::file_identity::NormalizePathForComparison(renamed.wstring()),
        "rename event paths were not exact");

    const auto pairA = watched / L"pair-a.mp4";
    const auto pairB = watched / L"pair-b.mp4";
    const auto pairANew = watched / L"pair-a-new.mp4";
    const auto pairBNew = watched / L"pair-b-new.mp4";
    WriteDisposableMedia(pairA, "pair a");
    WriteDisposableMedia(pairB, "pair b");
    Require(service.TrackKnownFile("pair-a", pairA.wstring()).ok, "pair a tracking failed");
    Require(service.TrackKnownFile("pair-b", pairB.wstring()).ok, "pair b tracking failed");
    service.DrainEvents(1024);
    Require(MoveFileExW(pairA.c_str(), pairANew.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE, "pair a rename failed");
    Require(MoveFileExW(pairB.c_str(), pairBNew.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE, "pair b rename failed");
    const auto pairedEvents = CollectFor(service, std::chrono::milliseconds(700));
    const auto matchedPairCount = std::count_if(pairedEvents.begin(), pairedEvents.end(), [](const auto& event) {
        return event.kind == EventKind::Renamed && event.sameVolumeIdentityMatched &&
            (event.recordId == "pair-a" || event.recordId == "pair-b");
    });
    Require(matchedPairCount == 2, "concurrent rename pairs were not matched by stable identity");

    service.DrainEvents(1024);
    for (int index = 0; index < 30; ++index) {
        WriteDisposableMedia(renamed, std::to_string(index), true);
    }
    const auto modificationEvents = CollectFor(service, std::chrono::milliseconds(600));
    const auto modifiedCount = std::count_if(modificationEvents.begin(), modificationEvents.end(), [&](const auto& event) {
        return event.kind == EventKind::Modified &&
            oracle::file_identity::NormalizePathForComparison(event.path) ==
                oracle::file_identity::NormalizePathForComparison(renamed.wstring());
    });
    Require(modifiedCount >= 1 && modifiedCount <= 2, "duplicate write events were not coalesced");

    service.DrainEvents(1024);
    Require(DeleteFileW(renamed.c_str()) != FALSE, "transient delete failed");
    std::this_thread::sleep_for(std::chrono::milliseconds(60));
    WriteDisposableMedia(renamed, "transient replacement");
    const auto transientEvents = CollectFor(service, std::chrono::milliseconds(650));
    const bool falseMissing = std::any_of(transientEvents.begin(), transientEvents.end(), [](const auto& event) {
        return event.kind == EventKind::Removed && event.recordId == "rename-record";
    });
    Require(!falseMissing, "bounded missing delay emitted a transient removal");

    service.DrainEvents(1024);
    Require(DeleteFileW(renamed.c_str()) != FALSE, "final delete failed");
    const auto missingEvents = CollectFor(service, std::chrono::milliseconds(850));
    const bool missing = std::any_of(missingEvents.begin(), missingEvents.end(), [](const auto& event) {
        return event.kind == EventKind::Removed && event.recordId == "rename-record";
    });
    Require(missing, "verified missing file did not emit a removal");

    service.DrainEvents(1024);
    WriteDisposableMedia(outside / L"outside.mp4", "must not be scanned");
    const auto outsideEvents = CollectFor(service, std::chrono::milliseconds(250));
    Require(outsideEvents.empty(), "watcher observed a path outside explicit roots");

    const auto handleSource = watched / L"watch-handle.mp4";
    const auto handleTarget = watched / L"watch-handle-renamed.mp4";
    WriteDisposableMedia(handleSource, "watch handle release");
    Require(service.TrackKnownFile("watch-handle", handleSource.wstring()).ok, "watch handle media was not tracked");
    const auto configuredRoots = service.ConfiguredRoots();
    Require(configuredRoots.size() == 1, "watch root snapshot changed");
    service.Stop();
    Require(
        MoveFileExW(handleSource.c_str(), handleTarget.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE,
        "watcher retained a handle that blocked source rename");
    service.UntrackKnownFile("watch-handle");
    Require(service.TrackKnownFile("watch-handle", handleTarget.wstring()).ok, "renamed watch media was not reconciled");
    Require(service.Start(configuredRoots).ok, "bounded roots did not restart after source mutation");

    const auto beforeStop = GetTickCount64();
    service.Stop();
    Require(!service.IsRunning(), "watcher did not report stopped state");
    Require(GetTickCount64() - beforeStop < 2000, "ReadDirectoryChangesW cancellation was not prompt");
    std::filesystem::remove_all(parent);
    Require(!std::filesystem::exists(parent), "watcher retained directory handles after shutdown");
}

void TestCrossRootSameVolumeMoveAndRestart() {
    const auto parent = UniqueDirectory(L"cross root");
    const auto rootA = parent / L"root-a";
    const auto rootB = parent / L"root-b";
    std::filesystem::create_directories(rootA);
    std::filesystem::create_directories(rootB);
    const auto original = rootA / L"cross-root-original.mp4";
    const auto moved = rootB / L"cross-root-moved.mp4";
    const auto returned = rootA / L"cross-root-returned.mp4";
    WriteDisposableMedia(original, "cross root same volume");

    DirectoryWatchService service;
    const std::vector<WatchRootConfig> roots{
        WatchRootConfig{"root-a", rootA.wstring(), true},
        WatchRootConfig{"root-b", rootB.wstring(), true},
    };
    const auto start = service.Start(roots);
    Require(start.ok && start.rootCount == 2, "two bounded sibling roots did not start");
    const auto tracked = service.TrackKnownFile("cross-root-record", original.wstring());
    Require(tracked.ok && !tracked.identityKey.empty(), "cross-root source tracking failed");

    Require(
        MoveFileExW(original.c_str(), moved.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE,
        "same-volume cross-root move failed");
    const auto movedEvents = CollectFor(service, std::chrono::milliseconds(950));
    const auto movedEvent = std::find_if(movedEvents.begin(), movedEvents.end(), [](const auto& event) {
        return event.kind == EventKind::Renamed && event.recordId == "cross-root-record";
    });
    Require(movedEvent != movedEvents.end(), "cross-root move was not paired by known identity");
    Require(movedEvent->sameVolumeIdentityMatched, "cross-root move did not prove same-volume identity");
    Require(movedEvent->rootId == "root-b", "cross-root rename was not attributed to the destination root");
    Require(
        oracle::file_identity::NormalizePathForComparison(movedEvent->oldPath) ==
            oracle::file_identity::NormalizePathForComparison(original.wstring()) &&
        oracle::file_identity::NormalizePathForComparison(movedEvent->path) ==
            oracle::file_identity::NormalizePathForComparison(moved.wstring()),
        "cross-root rename paths were not exact");
    Require(
        std::none_of(movedEvents.begin(), movedEvents.end(), [](const auto& event) {
            return event.kind == EventKind::Removed && event.recordId == "cross-root-record";
        }),
        "cross-root pairing leaked a stale known-file removal");

    service.Stop();
    Require(!service.IsRunning(), "cross-root watcher did not stop");
    Require(service.Start(roots).ok, "cross-root watcher did not restart with bounded roots");
    const auto afterRestart = CollectFor(service, std::chrono::milliseconds(200));
    Require(afterRestart.empty(), "watcher restart leaked cancelled cross-root state");
    Require(
        MoveFileExW(moved.c_str(), returned.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE,
        "reverse cross-root move after restart failed");
    const auto returnedEvents = CollectFor(service, std::chrono::milliseconds(950));
    const auto returnedEvent = std::find_if(returnedEvents.begin(), returnedEvents.end(), [](const auto& event) {
        return event.kind == EventKind::Renamed && event.recordId == "cross-root-record" &&
            event.sameVolumeIdentityMatched;
    });
    Require(returnedEvent != returnedEvents.end(), "updated known path did not survive watcher restart");
    Require(
        oracle::file_identity::NormalizePathForComparison(returnedEvent->oldPath) ==
            oracle::file_identity::NormalizePathForComparison(moved.wstring()) &&
        oracle::file_identity::NormalizePathForComparison(returnedEvent->path) ==
            oracle::file_identity::NormalizePathForComparison(returned.wstring()),
        "reverse cross-root paths were not exact after restart");

    const auto beforeStop = GetTickCount64();
    service.Stop();
    Require(GetTickCount64() - beforeStop < 2000, "cross-root watcher cancellation was not prompt");
    std::filesystem::remove_all(parent);
    Require(!std::filesystem::exists(parent), "cross-root watcher retained directory handles");
}

void TestCrossRootAmbiguityAndIdentityNonmatchRemainHonest() {
    const auto parent = UniqueDirectory(L"cross root honesty");
    const auto rootA = parent / L"root-a";
    const auto rootB = parent / L"root-b";
    const auto outside = parent / L"outside";
    std::filesystem::create_directories(rootA);
    std::filesystem::create_directories(rootB);
    std::filesystem::create_directories(outside);
    const std::vector<WatchRootConfig> roots{
        WatchRootConfig{"root-a", rootA.wstring(), true},
        WatchRootConfig{"root-b", rootB.wstring(), true},
    };

    const auto firstLink = rootA / L"ambiguous-first.mp4";
    const auto secondLink = rootA / L"ambiguous-second.mp4";
    const auto ambiguousTarget = rootB / L"ambiguous-target.mp4";
    WriteDisposableMedia(firstLink, "ambiguous hard links");
    Require(
        CreateHardLinkW(secondLink.c_str(), firstLink.c_str(), nullptr) != FALSE,
        "could not create disposable hard-link ambiguity");

    DirectoryWatchService service;
    Require(service.Start(roots).ok, "honesty watcher roots did not start");
    const auto firstTracked = service.TrackKnownFile("ambiguous-first", firstLink.wstring());
    const auto secondTracked = service.TrackKnownFile("ambiguous-second", secondLink.wstring());
    Require(
        firstTracked.ok && secondTracked.ok && firstTracked.identityKey == secondTracked.identityKey,
        "hard-link ambiguity did not share a stable identity");
    service.Stop();
    Require(DeleteFileW(secondLink.c_str()) != FALSE, "could not remove the second ambiguous link");
    Require(service.Start(roots).ok, "honesty watcher did not restart");
    Require(
        MoveFileExW(firstLink.c_str(), ambiguousTarget.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE,
        "ambiguous cross-root move failed");
    const auto ambiguousEvents = CollectFor(service, std::chrono::milliseconds(1000));
    Require(
        std::none_of(ambiguousEvents.begin(), ambiguousEvents.end(), [](const auto& event) {
            return event.kind == EventKind::Renamed &&
                (event.recordId == "ambiguous-first" || event.recordId == "ambiguous-second");
        }),
        "ambiguous shared identity was guessed as a known-file rename");
    Require(
        std::any_of(ambiguousEvents.begin(), ambiguousEvents.end(), [&](const auto& event) {
            return event.kind == EventKind::Added &&
                oracle::file_identity::NormalizePathForComparison(event.path) ==
                    oracle::file_identity::NormalizePathForComparison(ambiguousTarget.wstring());
        }),
        "ambiguous target was not reported honestly as an add");
    service.UntrackKnownFile("ambiguous-first");
    service.UntrackKnownFile("ambiguous-second");

    const auto nonmatchSource = rootA / L"nonmatch-source.mp4";
    const auto incomingOutside = outside / L"different-identity.mp4";
    const auto nonmatchTarget = rootB / L"nonmatch-target.mp4";
    WriteDisposableMedia(nonmatchSource, "known identity");
    WriteDisposableMedia(incomingOutside, "different identity");
    const auto nonmatchTracked = service.TrackKnownFile("nonmatch-record", nonmatchSource.wstring());
    const auto incomingInspection = oracle::file_identity::InspectSafeRegularFile(incomingOutside.wstring());
    Require(
        nonmatchTracked.ok && incomingInspection.ok &&
            nonmatchTracked.identityKey != incomingInspection.identity.ToKey(),
        "nonmatch fixture did not have distinct stable identities");
    CollectFor(service, std::chrono::milliseconds(250));
    service.DrainEvents(1024);
    Require(DeleteFileW(nonmatchSource.c_str()) != FALSE, "nonmatch source removal failed");
    Require(
        MoveFileExW(incomingOutside.c_str(), nonmatchTarget.c_str(), MOVEFILE_WRITE_THROUGH) != FALSE,
        "different-identity target move failed");
    const auto nonmatchEvents = CollectFor(service, std::chrono::milliseconds(1000));
    Require(
        std::none_of(nonmatchEvents.begin(), nonmatchEvents.end(), [](const auto& event) {
            return event.kind == EventKind::Renamed && event.recordId == "nonmatch-record";
        }),
        "different identity was falsely paired as a known-file move");
    Require(
        std::any_of(nonmatchEvents.begin(), nonmatchEvents.end(), [](const auto& event) {
            return event.kind == EventKind::Removed && event.recordId == "nonmatch-record";
        }),
        "different-identity move suppressed the real known-file removal");
    Require(
        std::any_of(nonmatchEvents.begin(), nonmatchEvents.end(), [&](const auto& event) {
            return event.kind == EventKind::Added &&
                oracle::file_identity::NormalizePathForComparison(event.path) ==
                    oracle::file_identity::NormalizePathForComparison(nonmatchTarget.wstring());
        }),
        "different-identity target was not reported as an add");

    service.Stop();
    std::filesystem::remove_all(parent);
    Require(!std::filesystem::exists(parent), "honesty watcher retained disposable media handles");
}

}  // namespace

int wmain() {
    try {
        TestRootBoundsAndNoDriveScans();
        TestRenameIdentityCoalescingMissingDelayAndCancellation();
        TestCrossRootSameVolumeMoveAndRestart();
        TestCrossRootAmbiguityAndIdentityNonmatchRemainHonest();
        std::wcout << L"oracle directory watch service tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "oracle directory watch service test failure: " << error.what() << '\n';
        return 1;
    }
}
