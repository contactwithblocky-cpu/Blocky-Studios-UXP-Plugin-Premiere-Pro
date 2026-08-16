#include "NativeDragCore.h"

#include <ShlObj.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <mutex>
#include <condition_variable>
#include <stdexcept>
#include <string>
#include <vector>

using namespace oracle::native_drag;

namespace {

void Require(bool condition, const char* message) {
    if (!condition) {
        throw std::runtime_error(message);
    }
}

std::filesystem::path CreateTestFile(const std::wstring& name, bool empty = false) {
    const auto directory = std::filesystem::temp_directory_path() / L"oracle native drag tests";
    std::filesystem::create_directories(directory);
    const auto path = directory / name;
    std::ofstream stream(path, std::ios::binary | std::ios::trunc);
    if (!empty) {
        stream << "oracle";
    }
    return path;
}

std::filesystem::path UniqueTestDirectory(const wchar_t* label) {
    return std::filesystem::temp_directory_path() /
        (std::wstring(L"oracle native drag ") + label + L" disposable " +
         std::to_wstring(GetCurrentProcessId()) + L" " + std::to_wstring(GetTickCount64()));
}

std::wstring TryMakeLocalhostUncPath(const std::filesystem::path& localPath) {
    const std::wstring value = localPath.wstring();
    if (value.size() < 3 || value[1] != L':' ||
        (value[2] != L'\\' && value[2] != L'/')) {
        return {};
    }
    std::wstring relative = value.substr(3);
    std::replace(relative.begin(), relative.end(), L'/', L'\\');
    return L"\\\\localhost\\" + std::wstring(1, value[0]) + L"$\\" + relative;
}

void TestHDropPacking() {
    const std::wstring path = L"C:\\Blocky Studios Renders\\Unicode 雪 (take 1).mov";
    STGMEDIUM medium{};
    Require(SUCCEEDED(CreateHDropStorageMedium(path, &medium)), "CF_HDROP allocation failed");
    Require(medium.tymed == TYMED_HGLOBAL, "CF_HDROP must use TYMED_HGLOBAL");
    auto* bytes = static_cast<unsigned char*>(GlobalLock(medium.hGlobal));
    Require(bytes != nullptr, "CF_HDROP could not be locked");
    const auto* header = reinterpret_cast<const DROPFILES*>(bytes);
    Require(header->pFiles == sizeof(DROPFILES), "DROPFILES.pFiles is incorrect");
    Require(header->fWide == TRUE, "DROPFILES must be UTF-16");
    const auto* packedPath = reinterpret_cast<const wchar_t*>(bytes + header->pFiles);
    Require(path == packedPath, "CF_HDROP changed the source path");
    Require(packedPath[path.size()] == L'\0', "CF_HDROP lacks first terminator");
    Require(packedPath[path.size() + 1] == L'\0', "CF_HDROP lacks double-null termination");
    GlobalUnlock(medium.hGlobal);
    ReleaseStgMedium(&medium);
}

void TestDataObjectOwnership() {
    STGMEDIUM templateMedium{};
    Require(SUCCEEDED(CreateHDropStorageMedium(L"C:\\owned.mov", &templateMedium)), "template allocation failed");
    auto* object = new FileDropDataObject(templateMedium.hGlobal);
    templateMedium.hGlobal = nullptr;
    FORMATETC format{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
    STGMEDIUM first{};
    STGMEDIUM second{};
    Require(object->GetData(&format, &first) == S_OK, "first GetData failed");
    Require(object->GetData(&format, &second) == S_OK, "second GetData failed");
    Require(first.hGlobal != second.hGlobal, "GetData must return independently owned storage");
    IDataObject* queried = nullptr;
    Require(object->QueryInterface(IID_IDataObject, reinterpret_cast<void**>(&queried)) == S_OK, "QueryInterface failed");
    Require(queried->Release() == 1, "QueryInterface reference ownership is incorrect");
    ReleaseStgMedium(&first);
    ReleaseStgMedium(&second);
    Require(object->Release() == 0, "IDataObject final release failed");
}

void TestShellDataObject() {
    const HRESULT oleResult = OleInitialize(nullptr);
    Require(SUCCEEDED(oleResult), "test thread OLE initialization failed");
    const auto file = CreateTestFile(L"shell data object 雪.mov");
    IDataObject* object = nullptr;
    const HRESULT createResult = CreateShellFileDataObject(file.wstring(), &object);
    Require(SUCCEEDED(createResult) && object != nullptr, "Shell IDataObject creation failed");
    FORMATETC format{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
    Require(object->QueryGetData(&format) == S_OK, "Shell IDataObject does not expose CF_HDROP");
    STGMEDIUM medium{};
    Require(object->GetData(&format, &medium) == S_OK, "Shell IDataObject CF_HDROP retrieval failed");
    ReleaseStgMedium(&medium);
    object->Release();
    OleUninitialize();
}

void TestPathValidation() {
    Require(ValidateAbsoluteFilePath(L"").errorCode == "INVALID_PATH", "empty path was accepted");
    Require(ValidateAbsoluteFilePath(std::wstring(L"C:\\bad\0path.mov", 15)).errorCode == "INVALID_PATH", "embedded null path was accepted");
    Require(ValidateAbsoluteFilePath(L"relative.mov").errorCode == "PATH_NOT_ABSOLUTE", "relative path was accepted");
    Require(ValidateAbsoluteFilePath(L"C:\\missing-oracle-native-drag.mov").errorCode == "FILE_NOT_FOUND", "missing path error is wrong");
    Require(ValidateAbsoluteFilePath(L"\\\\missing-server\\share\\missing.mov").errorCode == "FILE_NOT_FOUND", "UNC path was not recognized as absolute");

    const auto spaced = CreateTestFile(L"clip with spaces (take 2).mov");
    const auto unicode = CreateTestFile(L"电影-雪.mov");
    const auto empty = CreateTestFile(L"empty.mov", true);
    Require(ValidateAbsoluteFilePath(spaced.wstring()).ok, "path with spaces and parentheses failed");
    Require(ValidateAbsoluteFilePath(unicode.wstring()).ok, "Unicode path failed");
    Require(ValidateAbsoluteFilePath(empty.wstring()).errorCode == "EMPTY_FILE", "empty file was accepted");
    Require(ValidateAbsoluteFilePath(spaced.parent_path().wstring()).errorCode == "PATH_IS_DIRECTORY", "directory was accepted");

    const auto disposable = UniqueTestDirectory(L"path security");
    const auto targetDirectory = disposable / L"target";
    const auto linkedDirectory = disposable / L"linked-parent";
    std::filesystem::create_directories(targetDirectory);
    const auto secureFile = targetDirectory / L"secure 电影-雪.mov";
    {
        std::ofstream stream(secureFile, std::ios::binary | std::ios::trunc);
        stream << "oracle secure drag fixture";
    }

    const auto traversal = targetDirectory / L"nested" / L".." / secureFile.filename();
    Require(
        ValidateAbsoluteFilePath(traversal.wstring()).errorCode == "PATH_TRAVERSAL_NOT_ALLOWED",
        "parent traversal was accepted");
    Require(
        ValidateAbsoluteFilePath(secureFile.wstring() + L":oracle-stream").errorCode ==
            "ALTERNATE_DATA_STREAM_NOT_ALLOWED",
        "alternate data stream was accepted");
    Require(
        ValidateAbsoluteFilePath(L"\\\\?\\" + secureFile.wstring()).errorCode ==
            "DEVICE_PATH_NOT_ALLOWED",
        "extended device namespace was accepted");
    Require(
        ValidateAbsoluteFilePath((targetDirectory / L"NUL.mov").wstring()).errorCode ==
            "DEVICE_PATH_NOT_ALLOWED",
        "reserved DOS device name was accepted");

    const DWORD directoryLinkFlags =
        SYMBOLIC_LINK_FLAG_DIRECTORY | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE;
    Require(
        CreateSymbolicLinkW(linkedDirectory.c_str(), targetDirectory.c_str(), directoryLinkFlags) != FALSE,
        "could not create disposable parent reparse fixture");
    Require(
        ValidateAbsoluteFilePath((linkedDirectory / secureFile.filename()).wstring()).errorCode ==
            "REPARSE_POINT_NOT_ALLOWED",
        "reparse-point parent was accepted");

    const auto linkedFile = disposable / L"linked-file.mov";
    Require(
        CreateSymbolicLinkW(
            linkedFile.c_str(),
            secureFile.c_str(),
            SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE) != FALSE,
        "could not create disposable final reparse fixture");
    Require(
        ValidateAbsoluteFilePath(linkedFile.wstring()).errorCode == "REPARSE_POINT_NOT_ALLOWED",
        "final reparse point was accepted");

    const std::wstring localhostUnc = TryMakeLocalhostUncPath(secureFile);
    if (!localhostUnc.empty() && GetFileAttributesW(localhostUnc.c_str()) != INVALID_FILE_ATTRIBUTES) {
        Require(ValidateAbsoluteFilePath(localhostUnc).ok, "reachable localhost UNC path was rejected");
    } else {
        std::wcout << L"UNC acceptance fixture unavailable; syntactic UNC guard still exercised\n";
    }

    std::filesystem::remove(linkedFile);
    std::filesystem::remove(linkedDirectory);
    std::filesystem::remove_all(disposable);
}

void TestReleaseTraceCompileGate() {
#if defined(ORACLE_NATIVE_DEVELOPMENT_TRACE)
    Require(NativeDevelopmentTraceEnabledForTesting(), "development trace option was not compiled in");
#else
    Require(!NativeDevelopmentTraceEnabledForTesting(), "persistent native tracing compiled into default tests");
#endif
}

void TestDropSourceRules() {
    std::uint64_t queryCalls = 0;
    std::uint64_t feedbackCalls = 0;
    DWORD observedKeyState = 0;
    std::atomic<bool> cancellationRequested{false};
    auto* source = new FileDropSource(
        [&](BOOL, DWORD keyState) {
            ++queryCalls;
            observedKeyState = keyState;
        },
        [&](DWORD) { ++feedbackCalls; },
        &cancellationRequested);
    Require(source->QueryContinueDrag(TRUE, MK_LBUTTON) == DRAGDROP_S_CANCEL, "Escape did not cancel");
    Require(source->QueryContinueDrag(FALSE, 0) == DRAGDROP_S_DROP, "button release did not drop");
    Require(source->QueryContinueDrag(FALSE, MK_LBUTTON) == S_OK, "held button did not continue");
    cancellationRequested.store(true, std::memory_order_release);
    Require(
        source->QueryContinueDrag(FALSE, MK_LBUTTON) == DRAGDROP_S_CANCEL,
        "explicit cancellation signal did not stop the drop source");
    Require(source->GiveFeedback(DROPEFFECT_COPY) == DRAGDROP_S_USEDEFAULTCURSORS, "default cursors were not requested");
    Require(queryCalls == 4, "QueryContinueDrag telemetry count is wrong");
    Require(feedbackCalls == 1, "GiveFeedback telemetry count is wrong");
    Require(observedKeyState == MK_LBUTTON, "QueryContinueDrag key-state telemetry is wrong");
    source->Release();
}

void TestBoundedWorkerShutdown() {
    NativeDragWorker worker;
    Require(
        worker.BeginCooperativeShutdownWaitForTesting(),
        "cooperative shutdown fixture did not enter the worker wait");
    const auto started = std::chrono::steady_clock::now();
    const NativeDragStopResult result = worker.Stop();
    const auto elapsed = std::chrono::duration_cast<std::chrono::milliseconds>(
        std::chrono::steady_clock::now() - started);
    Require(result.attempted, "worker stop did not report an attempt");
    Require(result.ok, "cooperative worker stop reported failure");
    Require(result.cancellationRequested, "active worker stop omitted cancellation state");
    Require(result.workerExited, "cooperative worker did not exit");
    Require(result.oleCleanupCompleted, "cooperative worker skipped OLE cleanup");
    Require(!result.forcedTermination, "cooperative worker used catastrophic termination");
    Require(result.errorCode.empty(), "cooperative worker returned a shutdown error");
    Require(elapsed < std::chrono::milliseconds(1500), "cooperative worker stop exceeded its bound");

    const NativeDragSnapshot snapshot = worker.GetSnapshot();
    Require(snapshot.shutdownCancellationRequested, "snapshot omitted shutdown cancellation");
    Require(snapshot.workerExited, "snapshot omitted worker exit");
    Require(snapshot.oleCleanupCompleted, "snapshot omitted completed OLE cleanup");
    Require(snapshot.cancellationHookInstalled, "snapshot omitted the worker cancellation hook");
    Require(!snapshot.forcedTermination, "snapshot falsely reported forced termination");
    Require(snapshot.shutdownErrorCode.empty(), "snapshot reported a false shutdown error");

    const NativeDragStopResult repeated = worker.Stop();
    Require(repeated.ok && !repeated.forcedTermination, "idempotent stop changed its result");

    const NativeDragStopResult forced =
        NativeDragWorker::ForcedTerminationDiagnosticForTesting(WAIT_TIMEOUT);
    Require(!forced.ok, "forced termination diagnostic reported success");
    Require(forced.forcedTermination, "forced termination diagnostic omitted its marker");
    Require(!forced.oleCleanupCompleted, "forced termination diagnostic claimed COM cleanup");
    Require(
        forced.errorCode == "NATIVE_DRAG_FORCED_THREAD_TERMINATION",
        "forced termination diagnostic changed its stable error code");
}

void TestWorkerGuards() {
    NativeDragWorker worker;
    Require(worker.IsAvailable(), "initialized OLE worker is unavailable");
    Require(worker.OleWorkerState() == "ready", "initialized OLE worker is not ready");
    Require(worker.TryReserveDragForTesting(), "first drag reservation failed");
    Require(!worker.TryReserveDragForTesting(), "concurrent drag reservation was accepted");
    worker.ReleaseDragForTesting();

    const auto file = CreateTestFile(L"left-button-validation.mov");
    NativeDragResult result;
    bool completed = false;
    const std::uint64_t requestId = worker.StartNativeFileDragAsync(
        file.wstring(),
        GetCurrentThreadId(),
        [&](NativeDragResult value) {
            result = std::move(value);
            completed = true;
        });
    Require(completed, "pre-dispatch failure did not settle synchronously");
    Require(result.requestId == requestId, "completion returned the wrong request ID");
    Require(result.errorCode == "LEFT_BUTTON_NOT_HELD", "left-button validation did not reject dispatch");
    Require(result.requestReceived, "REQUEST_RECEIVED stage was not recorded");
    Require(result.pathValidated, "PATH_VALIDATED stage was not recorded");
    Require(!result.leftButtonConfirmed, "released button was incorrectly confirmed");
    Require(!result.workerDispatched, "released button was incorrectly dispatched to the worker");
    Require(result.lastStage == "PATH_VALIDATED", "left-button failure reported the wrong last stage");
    const NativeDragSnapshot snapshot = worker.GetSnapshot();
    Require(snapshot.requestId == requestId, "snapshot returned the wrong request ID");
    Require(snapshot.requestReceived, "snapshot omitted request receipt");
    Require(snapshot.pathValidated, "snapshot omitted path validation");
    Require(snapshot.promiseCreated, "snapshot omitted Promise creation");
    Require(snapshot.stage == "LEFT_BUTTON_NOT_HELD", "snapshot stopped at the wrong stage");
    std::cout << "nativeDispatchMs=" << result.nativeDispatchMs << '\n';

    worker.Stop();
    completed = false;
    worker.StartNativeFileDragAsync(
        file.wstring(),
        GetCurrentThreadId(),
        [&](NativeDragResult value) {
            result = std::move(value);
            completed = true;
        });
    Require(completed, "shutdown request did not settle");
    Require(result.errorCode == "ADDON_SHUTTING_DOWN", "shutdown request returned the wrong error");
}

}  // namespace

int wmain() {
    try {
        TestHDropPacking();
        TestDataObjectOwnership();
        TestShellDataObject();
        TestPathValidation();
        TestReleaseTraceCompileGate();
        TestDropSourceRules();
        TestBoundedWorkerShutdown();
        TestWorkerGuards();
        std::wcout << L"oracle-native-drag native tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "oracle-native-drag native test failure: " << error.what() << '\n';
        return 1;
    }
}
