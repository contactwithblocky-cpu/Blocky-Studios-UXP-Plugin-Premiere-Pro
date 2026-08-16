#include "FileOperationService.h"

#include <Windows.h>

#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <stdexcept>
#include <string>
#include <thread>

using oracle::file_operation::FileOperationBatchResult;
using oracle::file_operation::FileOperationService;

namespace {

void Require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

std::filesystem::path UniqueDirectory(const wchar_t* label) {
    return std::filesystem::temp_directory_path() /
        (std::wstring(L"oracle ") + label + L" disposable " +
         std::to_wstring(GetCurrentProcessId()) + L" " + std::to_wstring(GetTickCount64()));
}

void WriteDisposableMedia(const std::filesystem::path& path, const std::string& marker) {
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    stream << "ORACLE_DISPOSABLE_TEST_MEDIA\n" << marker << '\n';
    stream.flush();
    Require(stream.good(), "could not create disposable test media");
}

std::string ReadDisposableMedia(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    return std::string(
        std::istreambuf_iterator<char>(stream),
        std::istreambuf_iterator<char>());
}

FileOperationBatchResult AwaitRecycle(
    FileOperationService& service,
    std::vector<std::string> recordIds,
    std::function<void(std::uint64_t)> afterStart = {}) {
    std::mutex mutex;
    std::condition_variable condition;
    bool complete = false;
    FileOperationBatchResult output;
    const auto requestId = service.RecycleKnownFilesAsync(
        std::move(recordIds),
        [&](FileOperationBatchResult result) {
            {
                std::lock_guard lock(mutex);
                output = std::move(result);
                complete = true;
            }
            condition.notify_all();
        });
    if (afterStart) afterStart(requestId);
    std::unique_lock lock(mutex);
    Require(
        condition.wait_for(lock, std::chrono::seconds(15), [&] { return complete; }),
        "native recycle request timed out");
    return output;
}

void TestRegistrationIdentityAndRevealValidation() {
    const auto directory = UniqueDirectory(L"identity");
    std::filesystem::create_directories(directory);
    const auto media = directory / L"replay 雪.mp4";
    WriteDisposableMedia(media, "identity");

    FileOperationService service;
    Require(service.IsAvailable(), "file operation COM worker did not initialize");
    const auto registration = service.RegisterKnownFile("replay-identity", media.wstring());
    Require(registration.ok, "valid replay registration failed");
    Require(!registration.identityKey.empty(), "registration did not return stable identity");

    HANDLE exclusive = CreateFileW(
        media.c_str(),
        GENERIC_READ | DELETE,
        0,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    Require(exclusive != INVALID_HANDLE_VALUE, "registration retained an unsafe media handle");
    CloseHandle(exclusive);

    int revealCalls = 0;
    std::wstring revealedPath;
    const auto reveal = service.RevealKnownFileInExplorer(
        "replay-identity",
        [&](const std::wstring& validatedPath) {
            ++revealCalls;
            revealedPath = validatedPath;
            return S_OK;
        });
    Require(reveal.ok && revealCalls == 1, "validated Shell reveal helper did not invoke once");
    Require(
        oracle::file_identity::NormalizePathForComparison(revealedPath) ==
            oracle::file_identity::NormalizePathForComparison(media.wstring()),
        "Shell reveal helper selected a different path");

    DeleteFileW(media.c_str());
    WriteDisposableMedia(media, "replacement identity");
    const auto replacedReveal = service.RevealKnownFileInExplorer(
        "replay-identity",
        [&](const std::wstring&) {
            ++revealCalls;
            return S_OK;
        });
    Require(
        !replacedReveal.ok && replacedReveal.errorCode == "FILE_IDENTITY_CHANGED",
        "reveal accepted a same-path replacement identity");
    Require(revealCalls == 1, "unsafe replacement reached SHOpenFolderAndSelectItems helper");

    const auto unknown = AwaitRecycle(service, {"not-known"});
    Require(
        unknown.items.size() == 1 && unknown.items[0].errorCode == "UNKNOWN_LIBRARY_RECORD",
        "recycle accepted a record outside known library state");
    service.Stop();
    std::filesystem::remove_all(directory);
}

void TestReparseAndDirectoryGuards() {
    const auto directory = UniqueDirectory(L"reparse");
    const auto targetDirectory = directory / L"target";
    const auto linkedDirectory = directory / L"linked";
    std::filesystem::create_directories(targetDirectory);
    const auto media = targetDirectory / L"guard.mp4";
    WriteDisposableMedia(media, "reparse");

    FileOperationService service;
    const auto directoryResult = service.RegisterKnownFile("directory", targetDirectory.wstring());
    Require(
        !directoryResult.ok && directoryResult.errorCode == "NOT_A_REGULAR_FILE",
        "directory was accepted as disposable media");

    const DWORD flags = SYMBOLIC_LINK_FLAG_DIRECTORY | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE;
    const BOOL linked = CreateSymbolicLinkW(linkedDirectory.c_str(), targetDirectory.c_str(), flags);
    Require(linked != FALSE, "could not create disposable reparse point for safety test");
    const auto reparseResult = service.RegisterKnownFile(
        "reparse", (linkedDirectory / L"guard.mp4").wstring());
    Require(
        !reparseResult.ok && reparseResult.errorCode == "REPARSE_POINT_NOT_ALLOWED",
        "reparse-point parent was accepted");

    service.Stop();
    std::filesystem::remove_all(directory);
}

void TestIdentityRaceStopsBeforeMutation() {
    const auto directory = UniqueDirectory(L"identity race");
    std::filesystem::create_directories(directory);
    const auto media = directory / L"race.mp4";
    WriteDisposableMedia(media, "original");

    FileOperationService service;
    Require(service.RegisterKnownFile("race", media.wstring()).ok, "race media registration failed");
    service.SetBeforeFinalValidationHookForTesting([&] {
        Require(DeleteFileW(media.c_str()) != FALSE, "could not replace identity in race hook");
        WriteDisposableMedia(media, "replacement");
    });
    const auto result = AwaitRecycle(service, {"race"});
    Require(result.items.size() == 1, "identity race result count changed");
    Require(
        !result.items[0].ok && result.items[0].errorCode == "FILE_IDENTITY_CHANGED",
        "identity race was not rejected immediately before recycle");
    Require(std::filesystem::exists(media), "identity race deleted the replacement file");

    service.Stop();
    std::filesystem::remove_all(directory);
}

void TestQueuedPathReplacementSurvivesRecycle() {
    const auto directory = UniqueDirectory(L"queued replacement");
    std::filesystem::create_directories(directory);
    const auto stableMedia = directory / L"queued-stable.mp4";
    const auto media = directory / L"queued-race.mp4";
    WriteDisposableMedia(stableMedia, "stable item should recycle");
    WriteDisposableMedia(media, "registered original");

    FileOperationService service;
    Require(
        service.RegisterKnownFile("queued-stable", stableMedia.wstring()).ok,
        "queued-stable media registration failed");
    Require(
        service.RegisterKnownFile("queued-race", media.wstring()).ok,
        "queued-race media registration failed");
    service.PauseBeforePerformForTesting(true);
    const auto result = AwaitRecycle(service, {"queued-stable", "queued-race"}, [&](std::uint64_t) {
        Require(
            service.WaitUntilPausedForTesting(5000),
            "recycle request did not reach the queued-before-perform barrier");
        Require(DeleteFileW(media.c_str()) != FALSE, "could not remove queued-race original");
        WriteDisposableMedia(media, "same-path replacement must survive");
        service.ReleasePausedOperationForTesting();
    });

    Require(result.items.size() == 2, "queued replacement result count changed");
    Require(
        result.items[0].ok && !std::filesystem::exists(stableMedia),
        "queued replacement guard lost the valid item's partial success");
    Require(
        !result.items[1].ok && result.items[1].errorCode == "FILE_IDENTITY_CHANGED",
        "queued same-path replacement was not rejected in the Shell pre-delete callback");
    Require(
        result.items[1].errorMessage.find("replacement was preserved") != std::string::npos,
        "queued replacement failure did not explain that the replacement was preserved");
    Require(!result.ok, "queued replacement partial failure was reported as total success");
    Require(std::filesystem::exists(media), "queued same-path replacement was recycled");
    Require(
        ReadDisposableMedia(media).find("same-path replacement must survive") != std::string::npos,
        "queued same-path replacement contents changed");
    const auto staleRegistration = service.InspectKnownFile("queued-race");
    Require(
        !staleRegistration.ok && staleRegistration.errorCode == "FILE_IDENTITY_CHANGED",
        "queued replacement silently changed the bounded known-file registration");

    service.Stop();
    std::filesystem::remove_all(directory);
}

void TestRecycleCancellationAndSuccess() {
    const auto directory = UniqueDirectory(L"cancel success");
    std::filesystem::create_directories(directory);
    const auto cancelledMedia = directory / L"cancelled.mp4";
    const auto recycledMedia = directory / L"recycled.mp4";
    WriteDisposableMedia(cancelledMedia, "cancel");
    WriteDisposableMedia(recycledMedia, "success");

    FileOperationService service;
    Require(service.RegisterKnownFile("cancel", cancelledMedia.wstring()).ok, "cancel media registration failed");
    Require(service.RegisterKnownFile("success", recycledMedia.wstring()).ok, "success media registration failed");

    service.PauseBeforePerformForTesting(true);
    const auto cancelled = AwaitRecycle(service, {"cancel"}, [&](std::uint64_t requestId) {
        Require(service.WaitUntilPausedForTesting(5000), "recycle request did not reach pre-perform barrier");
        Require(service.CancelRequest(requestId), "active recycle request could not be cancelled");
        service.ReleasePausedOperationForTesting();
    });
    Require(cancelled.cancelled && cancelled.anyOperationsAborted, "cancel status was not surfaced");
    Require(cancelled.items.size() == 1 && cancelled.items[0].cancelled, "per-item cancel result missing");
    Require(std::filesystem::exists(cancelledMedia), "cancelled recycle removed the file");

    const auto success = AwaitRecycle(service, {"success"});
    Require(success.ok && success.items.size() == 1 && success.items[0].ok, "Recycle Bin success failed");
    Require(success.handlesReleasedBeforeMutation, "service did not confirm handle release boundary");
    Require(!std::filesystem::exists(recycledMedia), "successful Recycle Bin operation left the source file");

    service.Stop();
    std::filesystem::remove_all(directory);
}

void TestSharingViolationProducesPartialResults() {
    const auto directory = UniqueDirectory(L"partial");
    std::filesystem::create_directories(directory);
    const auto removable = directory / L"first-removable.mp4";
    const auto locked = directory / L"second-locked.mp4";
    WriteDisposableMedia(removable, "partial success");
    WriteDisposableMedia(locked, "sharing violation");

    FileOperationService service;
    Require(service.RegisterKnownFile("removable", removable.wstring()).ok, "partial success registration failed");
    Require(service.RegisterKnownFile("locked", locked.wstring()).ok, "locked media registration failed");

    HANDLE lock = CreateFileW(
        locked.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    Require(lock != INVALID_HANDLE_VALUE, "could not create sharing-violation lock");
    const auto partial = AwaitRecycle(service, {"removable", "locked"});
    CloseHandle(lock);

    Require(partial.items.size() == 2, "partial recycle lost per-item results");
    Require(partial.items[0].ok && !std::filesystem::exists(removable), "valid item did not recycle before failure");
    Require(
        !partial.items[1].ok && partial.items[1].errorCode == "FILE_IN_USE" &&
            std::filesystem::exists(locked),
        "locked item was not reported as a sharing violation");
    Require(!partial.ok, "partial failure was reported as total success");

    service.Stop();
    std::filesystem::remove_all(directory);
}

void TestGuardedSourceRename() {
    const auto directory = UniqueDirectory(L"source rename");
    std::filesystem::create_directories(directory);
    const auto source = directory / L"source.mp4";
    const auto renamed = directory / L"renamed.mp4";
    const auto existing = directory / L"existing.mp4";
    const auto wrongExtension = directory / L"wrong.mov";
    const auto linkedTarget = directory / L"linked.mp4";
    WriteDisposableMedia(source, "rename source");
    WriteDisposableMedia(existing, "must not overwrite");

    FileOperationService service;
    const auto registration = service.RegisterKnownFile("rename", source.wstring());
    Require(registration.ok, "rename source registration failed");

    const auto existingResult = service.RenameKnownFile("rename", existing.wstring());
    Require(
        !existingResult.ok && existingResult.errorCode == "RENAME_TARGET_EXISTS",
        "source rename overwrote an existing target");
    Require(std::filesystem::exists(source) && std::filesystem::exists(existing), "target-exists guard mutated media");

    const auto extensionResult = service.RenameKnownFile("rename", wrongExtension.wstring());
    Require(
        !extensionResult.ok && extensionResult.errorCode == "RENAME_EXTENSION_CHANGED",
        "source rename changed the replay extension");

    const DWORD linkFlags = SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE;
    Require(
        CreateSymbolicLinkW(linkedTarget.c_str(), existing.c_str(), linkFlags) != FALSE,
        "could not create rename target reparse point");
    const auto reparseResult = service.RenameKnownFile("rename", linkedTarget.wstring());
    Require(
        !reparseResult.ok && reparseResult.errorCode == "REPARSE_POINT_NOT_ALLOWED",
        "source rename accepted a reparse target");

    const auto renameResult = service.RenameKnownFile("rename", renamed.wstring());
    Require(renameResult.ok, "guarded source rename failed");
    Require(
        renameResult.oldPath == source.wstring() && renameResult.newPath == renamed.wstring(),
        "rename result paths changed");
    Require(renameResult.identityKey == registration.identityKey, "source rename changed stable identity");
    Require(!std::filesystem::exists(source) && std::filesystem::exists(renamed), "source rename did not move exactly one file");
    const auto registeredAfter = service.InspectKnownFile("rename");
    Require(
        registeredAfter.ok &&
            oracle::file_identity::NormalizePathForComparison(registeredAfter.normalizedPath) ==
                oracle::file_identity::NormalizePathForComparison(renamed.wstring()),
        "known-file registration did not commit the renamed path");

    service.Stop();
    std::filesystem::remove_all(directory);
}

void TestRenameIdentityRaceAndSharingViolation() {
    const auto directory = UniqueDirectory(L"rename races");
    std::filesystem::create_directories(directory);
    const auto raceSource = directory / L"race.mp4";
    const auto raceTarget = directory / L"race-renamed.mp4";
    const auto lockedSource = directory / L"locked.mp4";
    const auto lockedTarget = directory / L"locked-renamed.mp4";
    WriteDisposableMedia(raceSource, "race original");
    WriteDisposableMedia(lockedSource, "locked original");

    FileOperationService service;
    Require(service.RegisterKnownFile("rename-race", raceSource.wstring()).ok, "rename race registration failed");
    Require(service.RegisterKnownFile("rename-locked", lockedSource.wstring()).ok, "rename lock registration failed");
    service.SetBeforeRenameValidationHookForTesting([&] {
        Require(DeleteFileW(raceSource.c_str()) != FALSE, "could not replace rename race source");
        WriteDisposableMedia(raceSource, "race replacement");
    });
    const auto race = service.RenameKnownFile("rename-race", raceTarget.wstring());
    Require(
        !race.ok && race.errorCode == "FILE_IDENTITY_CHANGED",
        "rename identity race reached filesystem mutation");
    Require(std::filesystem::exists(raceSource) && !std::filesystem::exists(raceTarget), "rename race moved replacement media");

    HANDLE lock = CreateFileW(
        lockedSource.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    Require(lock != INVALID_HANDLE_VALUE, "could not create rename sharing lock");
    const auto sharing = service.RenameKnownFile("rename-locked", lockedTarget.wstring());
    CloseHandle(lock);
    Require(
        !sharing.ok && sharing.errorCode == "FILE_IN_USE",
        "rename sharing violation was not reported");
    Require(std::filesystem::exists(lockedSource) && !std::filesystem::exists(lockedTarget), "sharing failure mutated media");
    const auto stillRegistered = service.InspectKnownFile("rename-locked");
    Require(
        stillRegistered.ok && stillRegistered.normalizedPath == lockedSource.wstring(),
        "sharing failure changed known state");

    service.Stop();
    std::filesystem::remove_all(directory);
}

}  // namespace

int wmain() {
    try {
        TestRegistrationIdentityAndRevealValidation();
        TestReparseAndDirectoryGuards();
        TestIdentityRaceStopsBeforeMutation();
        TestQueuedPathReplacementSurvivesRecycle();
        TestRecycleCancellationAndSuccess();
        TestSharingViolationProducesPartialResults();
        TestGuardedSourceRename();
        TestRenameIdentityRaceAndSharingViolation();
        std::wcout << L"oracle file operation service tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "oracle file operation service test failure: " << error.what() << '\n';
        return 1;
    }
}
