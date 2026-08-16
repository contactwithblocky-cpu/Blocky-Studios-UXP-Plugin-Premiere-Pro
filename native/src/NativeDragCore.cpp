#include "NativeDragCore.h"
#include "SafeFileIdentity.h"

#include <ShlObj.h>

#include <chrono>
#include <cwctype>
#include <new>
#include <stdexcept>
#include <utility>
#include <vector>

#if defined(ORACLE_NATIVE_DEVELOPMENT_TRACE)
#include <filesystem>
#include <fstream>
#include <iomanip>
#include <sstream>
#endif

#ifdef ORACLE_NATIVE_DRAG_TESTS
bool oracle::native_drag::NativeDevelopmentTraceEnabledForTesting() noexcept {
#if defined(ORACLE_NATIVE_DEVELOPMENT_TRACE)
    return true;
#else
    return false;
#endif
}
#endif

namespace oracle::native_drag {
namespace {

constexpr UINT kNativeDragMessage = WM_APP + 0x4F1;
constexpr UINT kNativeDragCancelMessage = WM_APP + 0x4F2;
#ifdef ORACLE_NATIVE_DRAG_TESTS
constexpr UINT kNativeDragCooperativeTestMessage = WM_APP + 0x4F3;
#endif
constexpr DWORD kCooperativeStopWaitMilliseconds = 2000;

LRESULT CALLBACK NativeDragMessageHook(int code, WPARAM removeMode, LPARAM messageParameter) {
    if (code >= 0 && removeMode == PM_REMOVE && messageParameter != 0) {
        auto* message = reinterpret_cast<MSG*>(messageParameter);
        if (message->message == kNativeDragCancelMessage) {
            message->message = WM_KEYDOWN;
            message->wParam = VK_ESCAPE;
            message->lParam = 1 | (static_cast<LPARAM>(MapVirtualKeyW(VK_ESCAPE, MAPVK_VK_TO_VSC)) << 16);
        }
    }
    return CallNextHookEx(nullptr, code, removeMode, messageParameter);
}

NativeDragStopResult ForcedTerminationFailure(DWORD waitResult, DWORD win32Error) {
    NativeDragStopResult result;
    result.attempted = true;
    result.cancellationRequested = true;
    result.workerExited = true;
    result.oleCleanupCompleted = false;
    result.forcedTermination = true;
    result.waitResult = waitResult;
    result.win32Error = win32Error;
    result.errorCode = "NATIVE_DRAG_FORCED_THREAD_TERMINATION";
    result.errorMessage =
        "The dedicated OLE drag thread ignored cooperative cancellation and was forcibly terminated; COM cleanup did not complete.";
    return result;
}
#if defined(ORACLE_NATIVE_DEVELOPMENT_TRACE)
constexpr std::uint64_t kMaximumDevelopmentLogBytes = 512 * 1024;
std::mutex gTraceMutex;

std::filesystem::path DevelopmentLogPath() {
    wchar_t temporaryDirectory[MAX_PATH + 1]{};
    const DWORD length = GetTempPathW(MAX_PATH, temporaryDirectory);
    if (length == 0 || length > MAX_PATH) {
        return L"oracle-native-drag.log";
    }
    return std::filesystem::path(temporaryDirectory) / L"oracle-native-drag.log";
}

void TraceStage(std::uint64_t requestId, const char* stage, HRESULT result = E_PENDING) noexcept {
    try {
        const std::uint64_t timestamp = GetTickCount64();
        std::ostringstream line;
        line << "[OracleNativeDrag] request=" << requestId
             << " monotonicMs=" << timestamp
             << " thread=" << GetCurrentThreadId()
             << " stage=" << stage;
        if (result != E_PENDING) {
            line << " hresult=0x" << std::hex << std::uppercase
                 << static_cast<std::uint32_t>(result);
        }
        line << "\r\n";
        const std::string utf8 = line.str();
        const int wideLength = MultiByteToWideChar(
            CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), nullptr, 0);
        if (wideLength > 0) {
            std::wstring wide(static_cast<std::size_t>(wideLength), L'\0');
            MultiByteToWideChar(
                CP_UTF8, 0, utf8.data(), static_cast<int>(utf8.size()), wide.data(), wideLength);
            OutputDebugStringW(wide.c_str());
        }

        std::lock_guard lock(gTraceMutex);
        const auto path = DevelopmentLogPath();
        std::error_code error;
        if (std::filesystem::exists(path, error) &&
            std::filesystem::file_size(path, error) > kMaximumDevelopmentLogBytes) {
            std::ofstream truncate(path, std::ios::binary | std::ios::trunc);
        }
        std::ofstream stream(path, std::ios::binary | std::ios::app);
        stream.write(utf8.data(), static_cast<std::streamsize>(utf8.size()));
    } catch (...) {
        // Diagnostics must never interfere with the drag path.
    }
}
#else
void TraceStage(std::uint64_t, const char*, HRESULT = E_PENDING) noexcept {}
#endif

class ScopedGlobalLock final {
  public:
    explicit ScopedGlobalLock(HGLOBAL memory) : memory_(memory), data_(GlobalLock(memory)) {}
    ~ScopedGlobalLock() {
        if (data_) {
            GlobalUnlock(memory_);
        }
    }
    void* get() const { return data_; }

  private:
    HGLOBAL memory_;
    void* data_;
};

std::string WideToUtf8(const std::wstring& value) {
    if (value.empty()) {
        return {};
    }
    const int required = WideCharToMultiByte(
        CP_UTF8, WC_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0, nullptr, nullptr);
    if (required <= 0) {
        return "Windows error";
    }
    std::string result(static_cast<size_t>(required), '\0');
    WideCharToMultiByte(
        CP_UTF8,
        WC_ERR_INVALID_CHARS,
        value.data(),
        static_cast<int>(value.size()),
        result.data(),
        required,
        nullptr,
        nullptr);
    return result;
}

NativeDragResult ErrorResult(
    const char* code,
    const std::string& message,
    HRESULT result,
    double dispatchMilliseconds = 0.0) {
    NativeDragResult output;
    output.hresult = result;
    output.errorCode = code;
    output.errorMessage = message;
    output.nativeDispatchMs = dispatchMilliseconds;
    return output;
}

void MarkPreDispatchStages(NativeDragResult& result) {
    result.requestReceived = true;
    result.pathValidated = true;
    result.leftButtonConfirmed = true;
    result.lastStage = "LEFT_BUTTON_CONFIRMED";
}

void MarkWorkerDispatched(NativeDragResult& result) {
    MarkPreDispatchStages(result);
    result.workerDispatched = true;
    result.lastStage = "WORKER_DISPATCHED";
}

void MarkDoDragDropEntered(NativeDragResult& result) {
    MarkWorkerDispatched(result);
    result.doDragDropEntered = true;
    result.lastStage = "DO_DRAG_DROP_ENTERED";
}

void MarkDoDragDropReturned(NativeDragResult& result) {
    MarkDoDragDropEntered(result);
    result.doDragDropReturned = true;
    result.lastStage = "DO_DRAG_DROP_RETURNED";
}

}  // namespace

PathValidationResult ValidateAbsoluteFilePath(const std::wstring& absolutePath) {
    if (absolutePath.empty()) {
        return {false, "INVALID_PATH", "The replay path is empty."};
    }
    if (absolutePath.find(L'\0') != std::wstring::npos) {
        return {false, "INVALID_PATH", "The replay path contains an invalid null character."};
    }
    const bool driveAbsolute = absolutePath.size() >= 3 && std::iswalpha(absolutePath[0]) &&
        absolutePath[1] == L':' && (absolutePath[2] == L'\\' || absolutePath[2] == L'/');
    const bool uncAbsolute = absolutePath.size() >= 5 &&
        ((absolutePath[0] == L'\\' && absolutePath[1] == L'\\') ||
         (absolutePath[0] == L'/' && absolutePath[1] == L'/'));
    if (!driveAbsolute && !uncAbsolute) {
        return {false, "PATH_NOT_ABSOLUTE", "The replay path is not an absolute Windows path."};
    }

    const auto inspection = oracle::file_identity::InspectSafeDragSourceFile(absolutePath);
    if (!inspection.ok) {
        if (inspection.win32Error == ERROR_FILE_NOT_FOUND ||
            inspection.win32Error == ERROR_PATH_NOT_FOUND ||
            inspection.win32Error == ERROR_BAD_NETPATH ||
            inspection.win32Error == ERROR_BAD_NET_NAME ||
            inspection.errorCode == "PATH_NOT_FOUND") {
            return {false, "FILE_NOT_FOUND", "The replay file does not exist."};
        }
        if (inspection.errorCode == "NOT_A_REGULAR_FILE") {
            return {false, "PATH_IS_DIRECTORY", "The replay path does not refer to a regular file."};
        }
        return {false, inspection.errorCode, inspection.errorMessage};
    }
    if (inspection.fileSize == 0) {
        return {false, "EMPTY_FILE", "The replay file is empty."};
    }
    return {true, {}, {}, inspection.normalizedPath};
}

HRESULT CreateHDropStorageMedium(const std::wstring& absolutePath, STGMEDIUM* medium) {
    if (!medium || absolutePath.empty()) {
        return E_INVALIDARG;
    }
    *medium = {};

    const size_t characterCount = absolutePath.size() + 2;
    const size_t byteCount = sizeof(DROPFILES) + characterCount * sizeof(wchar_t);
    HGLOBAL memory = GlobalAlloc(GMEM_MOVEABLE | GMEM_ZEROINIT, byteCount);
    if (!memory) {
        return E_OUTOFMEMORY;
    }

    ScopedGlobalLock lock(memory);
    if (!lock.get()) {
        GlobalFree(memory);
        return HRESULT_FROM_WIN32(GetLastError());
    }

    auto* dropFiles = static_cast<DROPFILES*>(lock.get());
    dropFiles->pFiles = sizeof(DROPFILES);
    dropFiles->fWide = TRUE;
    auto* destination = reinterpret_cast<wchar_t*>(
        static_cast<unsigned char*>(lock.get()) + sizeof(DROPFILES));
    memcpy(destination, absolutePath.data(), absolutePath.size() * sizeof(wchar_t));
    destination[absolutePath.size()] = L'\0';
    destination[absolutePath.size() + 1] = L'\0';

    medium->tymed = TYMED_HGLOBAL;
    medium->hGlobal = memory;
    medium->pUnkForRelease = nullptr;
    return S_OK;
}

HRESULT CreateShellFileDataObject(const std::wstring& absolutePath, IDataObject** dataObject) {
    if (!dataObject || absolutePath.empty()) {
        return E_INVALIDARG;
    }
    *dataObject = nullptr;

    IShellItem* shellItem = nullptr;
    HRESULT result = SHCreateItemFromParsingName(
        absolutePath.c_str(),
        nullptr,
        IID_PPV_ARGS(&shellItem));
    if (FAILED(result)) {
        return result;
    }
    result = shellItem->BindToHandler(
        nullptr,
        BHID_DataObject,
        IID_PPV_ARGS(dataObject));
    shellItem->Release();
    return result;
}

HGLOBAL DuplicateHGlobal(HGLOBAL source) {
    if (!source) {
        return nullptr;
    }
    const SIZE_T byteCount = GlobalSize(source);
    if (byteCount == 0) {
        return nullptr;
    }
    HGLOBAL duplicate = GlobalAlloc(GMEM_MOVEABLE, byteCount);
    if (!duplicate) {
        return nullptr;
    }

    ScopedGlobalLock sourceLock(source);
    ScopedGlobalLock destinationLock(duplicate);
    if (!sourceLock.get() || !destinationLock.get()) {
        GlobalFree(duplicate);
        return nullptr;
    }
    memcpy(destinationLock.get(), sourceLock.get(), byteCount);
    return duplicate;
}

std::string HResultToErrorString(HRESULT result) {
    wchar_t* buffer = nullptr;
    const DWORD length = FormatMessageW(
        FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
        nullptr,
        static_cast<DWORD>(result),
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<wchar_t*>(&buffer),
        0,
        nullptr);
    if (length == 0 || !buffer) {
        char fallback[32]{};
        sprintf_s(fallback, "HRESULT 0x%08lX", static_cast<unsigned long>(result));
        return fallback;
    }
    std::wstring message(buffer, length);
    LocalFree(buffer);
    while (!message.empty() && (message.back() == L'\r' || message.back() == L'\n' || message.back() == L' ')) {
        message.pop_back();
    }
    return WideToUtf8(message);
}

FileDropDataObject::FileDropDataObject(HGLOBAL hdropTemplate) : hdropTemplate_(hdropTemplate) {}

FileDropDataObject::~FileDropDataObject() {
    if (hdropTemplate_) {
        GlobalFree(hdropTemplate_);
    }
}

HRESULT FileDropDataObject::QueryInterface(REFIID iid, void** object) {
    if (!object) {
        return E_POINTER;
    }
    *object = nullptr;
    if (iid == IID_IUnknown || iid == IID_IDataObject) {
        *object = static_cast<IDataObject*>(this);
        AddRef();
        return S_OK;
    }
    return E_NOINTERFACE;
}

ULONG FileDropDataObject::AddRef() { return ++references_; }

ULONG FileDropDataObject::Release() {
    const ULONG remaining = --references_;
    if (remaining == 0) {
        delete this;
    }
    return remaining;
}

HRESULT FileDropDataObject::GetData(FORMATETC* format, STGMEDIUM* medium) {
    if (!medium) {
        return E_POINTER;
    }
    const HRESULT query = QueryGetData(format);
    if (FAILED(query)) {
        return query;
    }
    HGLOBAL duplicate = DuplicateHGlobal(hdropTemplate_);
    if (!duplicate) {
        return E_OUTOFMEMORY;
    }
    *medium = {};
    medium->tymed = TYMED_HGLOBAL;
    medium->hGlobal = duplicate;
    medium->pUnkForRelease = nullptr;
    return S_OK;
}

HRESULT FileDropDataObject::GetDataHere(FORMATETC*, STGMEDIUM*) { return DATA_E_FORMATETC; }

HRESULT FileDropDataObject::QueryGetData(FORMATETC* format) {
    if (!format) {
        return E_POINTER;
    }
    if (format->cfFormat != CF_HDROP) {
        return DV_E_CLIPFORMAT;
    }
    if (format->dwAspect != DVASPECT_CONTENT) {
        return DV_E_DVASPECT;
    }
    if (format->lindex != -1) {
        return DV_E_LINDEX;
    }
    if ((format->tymed & TYMED_HGLOBAL) == 0) {
        return DV_E_TYMED;
    }
    return S_OK;
}

HRESULT FileDropDataObject::GetCanonicalFormatEtc(FORMATETC*, FORMATETC* output) {
    if (!output) {
        return E_POINTER;
    }
    output->ptd = nullptr;
    return E_NOTIMPL;
}

HRESULT FileDropDataObject::SetData(FORMATETC*, STGMEDIUM*, BOOL) { return E_NOTIMPL; }

HRESULT FileDropDataObject::EnumFormatEtc(DWORD direction, IEnumFORMATETC** enumerator) {
    if (!enumerator) {
        return E_POINTER;
    }
    *enumerator = nullptr;
    if (direction != DATADIR_GET) {
        return E_NOTIMPL;
    }
    return SHCreateStdEnumFmtEtc(1, &format_, enumerator);
}

HRESULT FileDropDataObject::DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) {
    return OLE_E_ADVISENOTSUPPORTED;
}
HRESULT FileDropDataObject::DUnadvise(DWORD) { return OLE_E_ADVISENOTSUPPORTED; }
HRESULT FileDropDataObject::EnumDAdvise(IEnumSTATDATA**) { return OLE_E_ADVISENOTSUPPORTED; }

FileDropSource::FileDropSource(
    QueryObserver queryObserver,
    FeedbackObserver feedbackObserver,
    const std::atomic<bool>* cancellationRequested)
    : queryObserver_(std::move(queryObserver)),
      feedbackObserver_(std::move(feedbackObserver)),
      cancellationRequested_(cancellationRequested) {}

HRESULT FileDropSource::QueryInterface(REFIID iid, void** object) {
    if (!object) {
        return E_POINTER;
    }
    *object = nullptr;
    if (iid == IID_IUnknown || iid == IID_IDropSource) {
        *object = static_cast<IDropSource*>(this);
        AddRef();
        return S_OK;
    }
    return E_NOINTERFACE;
}

ULONG FileDropSource::AddRef() { return ++references_; }

ULONG FileDropSource::Release() {
    const ULONG remaining = --references_;
    if (remaining == 0) {
        delete this;
    }
    return remaining;
}

HRESULT FileDropSource::QueryContinueDrag(BOOL escapePressed, DWORD keyState) {
    if (queryObserver_) {
        queryObserver_(escapePressed, keyState);
    }
    if (escapePressed ||
        (cancellationRequested_ && cancellationRequested_->load(std::memory_order_acquire))) {
        return DRAGDROP_S_CANCEL;
    }
    if ((keyState & MK_LBUTTON) == 0) {
        return DRAGDROP_S_DROP;
    }
    return S_OK;
}

HRESULT FileDropSource::GiveFeedback(DWORD effect) {
    if (feedbackObserver_) {
        feedbackObserver_(effect);
    }
    return DRAGDROP_S_USEDEFAULTCURSORS;
}

struct NativeDragWorker::DragRequest {
    DragRequest(std::uint64_t inputRequestId, std::wstring inputPath, Completion inputCompletion)
        : requestId(inputRequestId),
          path(std::move(inputPath)),
          queuedAt(std::chrono::steady_clock::now()),
          completion(std::move(inputCompletion)) {}

    std::uint64_t requestId;
    std::wstring path;
    std::chrono::steady_clock::time_point queuedAt;
    Completion completion;
};

NativeDragWorker::NativeDragWorker() {
    cancellationEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!cancellationEvent_) {
        throw std::runtime_error("The native drag cancellation event could not be created.");
    }
#ifdef ORACLE_NATIVE_DRAG_TESTS
    cooperativeTestEnteredEvent_ = CreateEventW(nullptr, TRUE, FALSE, nullptr);
    if (!cooperativeTestEnteredEvent_) {
        CloseHandle(cancellationEvent_);
        cancellationEvent_ = nullptr;
        throw std::runtime_error("The native drag test synchronization event could not be created.");
    }
#endif
    try {
        thread_ = std::thread(&NativeDragWorker::ThreadMain, this);
    } catch (...) {
#ifdef ORACLE_NATIVE_DRAG_TESTS
        CloseHandle(cooperativeTestEnteredEvent_);
        cooperativeTestEnteredEvent_ = nullptr;
#endif
        CloseHandle(cancellationEvent_);
        cancellationEvent_ = nullptr;
        throw;
    }
    std::unique_lock lock(startupMutex_);
    startupCondition_.wait(lock, [this] { return startupComplete_; });
}

NativeDragWorker::~NativeDragWorker() {
    (void)Stop();
#ifdef ORACLE_NATIVE_DRAG_TESTS
    if (cooperativeTestEnteredEvent_) {
        CloseHandle(cooperativeTestEnteredEvent_);
        cooperativeTestEnteredEvent_ = nullptr;
    }
#endif
    if (cancellationEvent_) {
        CloseHandle(cancellationEvent_);
        cancellationEvent_ = nullptr;
    }
}

void NativeDragWorker::UpdateSnapshot(
    std::uint64_t requestId,
    const char* stage,
    const std::function<void(NativeDragSnapshot&)>& update,
    HRESULT traceResult) {
    {
        std::lock_guard lock(snapshotMutex_);
        if (snapshot_.requestId != requestId) {
            return;
        }
        if (stage && *stage) {
            snapshot_.stage = stage;
        }
        update(snapshot_);
        snapshot_.elapsedMs = static_cast<double>(GetTickCount64() - snapshotStartedTicks_);
    }
    if (stage && *stage) {
        TraceStage(requestId, stage, traceResult);
    }
}

NativeDragSnapshot NativeDragWorker::GetSnapshot() const {
    std::lock_guard lock(snapshotMutex_);
    NativeDragSnapshot copy = snapshot_;
    if (copy.requestId != 0) {
        copy.elapsedMs = static_cast<double>(GetTickCount64() - snapshotStartedTicks_);
    }
    return copy;
}

void NativeDragWorker::MarkPromiseSettled(std::uint64_t requestId, bool resolved) {
    UpdateSnapshot(
        requestId,
        resolved ? "PROMISE_RESOLVED" : "PROMISE_REJECTED",
        [resolved](NativeDragSnapshot& snapshot) {
            snapshot.promiseResolved = resolved;
            snapshot.promiseRejected = !resolved;
        });
}

void NativeDragWorker::CompleteImmediately(
    std::uint64_t requestId,
    NativeDragResult result,
    const Completion& completion) {
    result.requestId = requestId;
    if (completion) {
        completion(std::move(result));
    }
}

std::uint64_t NativeDragWorker::StartNativeFileDragAsync(
    const std::wstring& absolutePath,
    DWORD callerThreadId,
    Completion completion) {
    const std::uint64_t requestId = nextRequestId_.fetch_add(1, std::memory_order_relaxed);
    if (dragActive_.load(std::memory_order_acquire)) {
        NativeDragResult result = ErrorResult(
            "DRAG_ALREADY_ACTIVE",
            "A native replay drag is already active.",
            HRESULT_FROM_WIN32(ERROR_BUSY));
        result.requestId = requestId;
        MarkPreDispatchStages(result);
        TraceStage(requestId, "DRAG_ALREADY_ACTIVE", result.hresult);
        if (completion) {
            completion(std::move(result));
        }
        return requestId;
    }
    {
        std::lock_guard lock(snapshotMutex_);
        snapshot_ = {};
        snapshot_.requestId = requestId;
        snapshot_.stage = "REQUEST_RECEIVED";
        snapshot_.requestReceived = true;
        snapshot_.promiseCreated = true;
        snapshot_.callerThreadId = callerThreadId;
        snapshot_.workerThreadId = threadId_;
        snapshot_.oleInitializeHresult = oleInitializationResult_;
        snapshot_.cancellationHookInstalled =
            cancellationHookInstalled_.load(std::memory_order_acquire);
        snapshotStartedTicks_ = GetTickCount64();
    }
    TraceStage(requestId, "REQUEST_RECEIVED");

    if (shuttingDown_.load(std::memory_order_acquire)) {
        NativeDragResult result = ErrorResult("ADDON_SHUTTING_DOWN", "The native drag addon is shutting down.", E_ABORT);
        UpdateSnapshot(requestId, "REQUEST_REJECTED", [result](NativeDragSnapshot& snapshot) {
            snapshot.hresult = result.hresult;
        }, result.hresult);
        CompleteImmediately(requestId, std::move(result), completion);
        return requestId;
    }
    if (FAILED(oleInitializationResult_)) {
        NativeDragResult result = ErrorResult(
            "OLE_INITIALIZATION_FAILED",
            HResultToErrorString(oleInitializationResult_),
            oleInitializationResult_);
        UpdateSnapshot(requestId, "OLE_INITIALIZATION_FAILED", [this](NativeDragSnapshot& snapshot) {
            snapshot.hresult = oleInitializationResult_;
        }, oleInitializationResult_);
        CompleteImmediately(requestId, std::move(result), completion);
        return requestId;
    }
    if (!cancellationHookInstalled_.load(std::memory_order_acquire)) {
        NativeDragResult result = ErrorResult(
            "NATIVE_DRAG_CANCELLATION_UNAVAILABLE",
            "The native drag cancellation hook could not be installed.",
            E_ABORT);
        UpdateSnapshot(
            requestId,
            "CANCELLATION_HOOK_UNAVAILABLE",
            [result](NativeDragSnapshot& snapshot) { snapshot.hresult = result.hresult; },
            result.hresult);
        CompleteImmediately(requestId, std::move(result), completion);
        return requestId;
    }

    const PathValidationResult validation = ValidateAbsoluteFilePath(absolutePath);
    if (!validation.ok) {
        NativeDragResult result =
            ErrorResult(validation.errorCode.c_str(), validation.errorMessage, E_INVALIDARG);
        result.lastStage = "REQUEST_RECEIVED";
        UpdateSnapshot(requestId, "PATH_VALIDATION_FAILED", [result](NativeDragSnapshot& snapshot) {
            snapshot.hresult = result.hresult;
        }, result.hresult);
        CompleteImmediately(requestId, std::move(result), completion);
        return requestId;
    }
    UpdateSnapshot(requestId, "PATH_VALIDATED", [](NativeDragSnapshot& snapshot) {
        snapshot.pathValidated = true;
    });

    const SHORT callerButtonState = GetAsyncKeyState(VK_LBUTTON);
    if ((callerButtonState & 0x8000) == 0) {
        NativeDragResult result = ErrorResult(
            "LEFT_BUTTON_NOT_HELD",
            "The primary mouse button was released before the native drag began.",
            HRESULT_FROM_WIN32(ERROR_CANCELLED));
        result.pathValidated = true;
        result.lastStage = "PATH_VALIDATED";
        UpdateSnapshot(requestId, "LEFT_BUTTON_NOT_HELD", [result](NativeDragSnapshot& snapshot) {
            snapshot.lastKeyState = 0;
            snapshot.hresult = result.hresult;
        }, result.hresult);
        CompleteImmediately(requestId, std::move(result), completion);
        return requestId;
    }
    UpdateSnapshot(requestId, "LEFT_BUTTON_CONFIRMED", [](NativeDragSnapshot& snapshot) {
        snapshot.leftButtonConfirmed = true;
        snapshot.lastKeyState = MK_LBUTTON;
    });

    bool expected = false;
    if (!dragActive_.compare_exchange_strong(expected, true, std::memory_order_acq_rel)) {
        NativeDragResult result = ErrorResult("DRAG_ALREADY_ACTIVE", "A native replay drag is already active.", HRESULT_FROM_WIN32(ERROR_BUSY));
        MarkPreDispatchStages(result);
        UpdateSnapshot(requestId, "DRAG_ALREADY_ACTIVE", [result](NativeDragSnapshot& snapshot) {
            snapshot.hresult = result.hresult;
        }, result.hresult);
        CompleteImmediately(requestId, std::move(result), completion);
        return requestId;
    }

    cancellationRequested_.store(false, std::memory_order_release);
    ResetEvent(cancellationEvent_);
    if (shuttingDown_.load(std::memory_order_acquire)) {
        RequestCancellationSignal();
        dragActive_.store(false, std::memory_order_release);
        NativeDragResult result = ErrorResult(
            "ADDON_SHUTTING_DOWN",
            "The native drag addon is shutting down.",
            E_ABORT);
        result.pathValidated = true;
        result.leftButtonConfirmed = true;
        result.lastStage = "LEFT_BUTTON_CONFIRMED";
        UpdateSnapshot(requestId, "REQUEST_REJECTED", [result](NativeDragSnapshot& snapshot) {
            snapshot.hresult = result.hresult;
            snapshot.shutdownCancellationRequested = true;
        }, result.hresult);
        CompleteImmediately(requestId, std::move(result), completion);
        return requestId;
    }

    auto request = std::make_shared<DragRequest>(
        requestId,
        validation.normalizedPath,
        std::move(completion));
    auto* messagePayload = new (std::nothrow) std::shared_ptr<DragRequest>(request);
    UpdateSnapshot(requestId, "WORKER_QUEUED", [](NativeDragSnapshot& snapshot) {
        snapshot.workerQueued = true;
    });
    if (!messagePayload || !PostThreadMessageW(threadId_, kNativeDragMessage, 0, reinterpret_cast<LPARAM>(messagePayload))) {
        delete messagePayload;
        dragActive_.store(false, std::memory_order_release);
        NativeDragResult result = ErrorResult("DRAG_FAILED", "The drag request could not be dispatched to the OLE worker.", HRESULT_FROM_WIN32(GetLastError()));
        MarkPreDispatchStages(result);
        UpdateSnapshot(requestId, "WORKER_QUEUE_FAILED", [result](NativeDragSnapshot& snapshot) {
            snapshot.workerQueued = false;
            snapshot.hresult = result.hresult;
        }, result.hresult);
        CompleteImmediately(requestId, std::move(result), request->completion);
        return requestId;
    }
    return requestId;
}

bool NativeDragWorker::IsAvailable() const noexcept {
    return startupComplete_ &&
           SUCCEEDED(oleInitializationResult_) &&
           cancellationHookInstalled_.load(std::memory_order_acquire) &&
           thread_.joinable() &&
           !shuttingDown_.load(std::memory_order_acquire);
}

std::string NativeDragWorker::OleWorkerState() const {
    if (!startupComplete_) {
        return "starting";
    }
    if (shuttingDown_.load(std::memory_order_acquire)) {
        return thread_.joinable() ? "stopping" : "stopped";
    }
    if (FAILED(oleInitializationResult_)) {
        return "oleInitializationFailed";
    }
    return thread_.joinable() ? "ready" : "stopped";
}

void NativeDragWorker::RequestCancellationSignal() {
    cancellationRequested_.store(true, std::memory_order_release);
    if (cancellationEvent_) SetEvent(cancellationEvent_);

    const HWND sourceWindow = reinterpret_cast<HWND>(
        activeDragWindow_.load(std::memory_order_acquire));
    if (sourceWindow && IsWindow(sourceWindow)) {
        PostMessageW(sourceWindow, WM_CANCELMODE, 0, 0);
        PostMessageW(
            sourceWindow,
            WM_KEYDOWN,
            VK_ESCAPE,
            1 | (static_cast<LPARAM>(MapVirtualKeyW(VK_ESCAPE, MAPVK_VK_TO_VSC)) << 16));
        PostMessageW(
            sourceWindow,
            WM_KEYUP,
            VK_ESCAPE,
            1 | (static_cast<LPARAM>(MapVirtualKeyW(VK_ESCAPE, MAPVK_VK_TO_VSC)) << 16) |
                (static_cast<LPARAM>(1) << 30) | (static_cast<LPARAM>(1) << 31));
    }
    if (threadId_ != 0) {
        PostThreadMessageW(threadId_, kNativeDragCancelMessage, 0, 0);
        PostThreadMessageW(threadId_, WM_CANCELMODE, 0, 0);
        CoCancelCall(threadId_, 0);
    }
}

bool NativeDragWorker::CancelActiveDrag() {
    if (!dragActive_.load(std::memory_order_acquire)) return false;
    RequestCancellationSignal();
    const NativeDragSnapshot current = GetSnapshot();
    if (current.requestId != 0) {
        UpdateSnapshot(current.requestId, "CANCELLATION_REQUESTED", [](NativeDragSnapshot& snapshot) {
            snapshot.shutdownCancellationRequested = true;
            snapshot.escapeObserved = true;
        }, E_ABORT);
    }
    return true;
}

void NativeDragWorker::RecordStopSnapshot(
    const NativeDragStopResult& result,
    const char* stage) {
    std::lock_guard lock(snapshotMutex_);
    if (stage && *stage) snapshot_.stage = stage;
    snapshot_.shutdownCancellationRequested = result.cancellationRequested;
    snapshot_.workerExited = result.workerExited;
    snapshot_.oleCleanupCompleted = result.oleCleanupCompleted;
    snapshot_.cancellationHookInstalled =
        cancellationHookInstalled_.load(std::memory_order_acquire);
    snapshot_.forcedTermination = result.forcedTermination;
    snapshot_.shutdownErrorCode = result.errorCode;
    if (result.forcedTermination) snapshot_.hresult = E_ABORT;
    if (snapshot_.requestId != 0) {
        snapshot_.elapsedMs = static_cast<double>(GetTickCount64() - snapshotStartedTicks_);
    }
}

NativeDragStopResult NativeDragWorker::Stop() {
    std::lock_guard stopLock(stopMutex_);
    if (stopResult_.attempted) return stopResult_;

    NativeDragStopResult result;
    result.attempted = true;
    shuttingDown_.store(true, std::memory_order_release);
    result.cancellationRequested = dragActive_.load(std::memory_order_acquire);
    RequestCancellationSignal();

    const NativeDragSnapshot current = GetSnapshot();
    if (current.requestId != 0 && current.doDragDropEntered && !current.doDragDropReturned) {
        TraceStage(current.requestId, "SHUTDOWN_CANCELLATION_REQUESTED", E_ABORT);
    }

    if (!thread_.joinable()) {
        result.workerExited = true;
        result.oleCleanupCompleted = oleCleanupCompleted_.load(std::memory_order_acquire);
        result.ok = result.oleCleanupCompleted;
        result.waitResult = WAIT_OBJECT_0;
        if (!result.ok) {
            result.errorCode = "NATIVE_DRAG_OLE_CLEANUP_INCOMPLETE";
            result.errorMessage = "The OLE worker stopped without completing apartment cleanup.";
        }
        stopResult_ = result;
        RecordStopSnapshot(stopResult_, result.ok ? "WORKER_STOPPED" : "WORKER_STOP_FAILED");
        return stopResult_;
    }

    PostThreadMessageW(threadId_, WM_QUIT, 0, 0);
    const HANDLE workerHandle = thread_.native_handle();
    DWORD waitResult = WaitForSingleObject(workerHandle, kCooperativeStopWaitMilliseconds);
    if (waitResult != WAIT_OBJECT_0) {
        RequestCancellationSignal();
        PostThreadMessageW(threadId_, WM_QUIT, 0, 0);
        waitResult = WaitForSingleObject(workerHandle, kCooperativeStopWaitMilliseconds);
    }

    if (waitResult != WAIT_OBJECT_0) {
        const DWORD foregroundThreadId =
            activeForegroundThreadId_.load(std::memory_order_acquire);
        if (foregroundThreadId != 0 && threadId_ != 0 && foregroundThreadId != threadId_) {
            AttachThreadInput(threadId_, foregroundThreadId, FALSE);
        }
        const BOOL terminated = TerminateThread(workerHandle, ERROR_CANCELLED);
        const DWORD terminateError = terminated ? ERROR_SUCCESS : GetLastError();
        if (!terminated && WaitForSingleObject(workerHandle, 0) != WAIT_OBJECT_0) {
            // This is a dedicated STA owned solely by the addon. A second
            // attempt avoids handing a joinable thread to std::thread after a
            // transient race while never claiming that COM cleanup succeeded.
            TerminateThread(workerHandle, ERROR_CANCELLED);
        }
        waitResult = WaitForSingleObject(workerHandle, kCooperativeStopWaitMilliseconds);
        result = ForcedTerminationFailure(waitResult, terminateError);
        activeDragWindow_.store(0, std::memory_order_release);
        activeForegroundThreadId_.store(0, std::memory_order_release);
    }

    // Natural exit and TerminateThread both signal the owned thread handle;
    // join then closes std::thread's native handle. No detached DLL thread is
    // ever allowed to outlive the addon.
    thread_.join();
    if (!result.forcedTermination) {
        result.waitResult = waitResult;
        result.workerExited = true;
        result.oleCleanupCompleted = oleCleanupCompleted_.load(std::memory_order_acquire);
        result.ok = result.oleCleanupCompleted;
        if (!result.ok) {
            result.errorCode = "NATIVE_DRAG_OLE_CLEANUP_INCOMPLETE";
            result.errorMessage = "The OLE worker exited without completing apartment cleanup.";
        }
    }
    stopResult_ = result;
    RecordStopSnapshot(
        stopResult_,
        stopResult_.forcedTermination
            ? "WORKER_FORCED_TERMINATION"
            : (stopResult_.ok ? "WORKER_STOPPED" : "WORKER_STOP_FAILED"));
    return stopResult_;
}

void NativeDragWorker::ThreadMain() {
    const HRESULT oleResult = OleInitialize(nullptr);
    MSG message{};
    PeekMessageW(&message, nullptr, WM_USER, WM_USER, PM_NOREMOVE);
    const HHOOK messageHook = SetWindowsHookExW(
        WH_GETMESSAGE,
        NativeDragMessageHook,
        nullptr,
        GetCurrentThreadId());
    cancellationHookInstalled_.store(messageHook != nullptr, std::memory_order_release);
    {
        std::lock_guard lock(startupMutex_);
        threadId_ = GetCurrentThreadId();
        oleInitializationResult_ = oleResult;
        startupComplete_ = true;
    }
    startupCondition_.notify_all();

    if (FAILED(oleResult)) {
        if (messageHook) UnhookWindowsHookEx(messageHook);
        oleCleanupCompleted_.store(true, std::memory_order_release);
        return;
    }

    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
#ifdef ORACLE_NATIVE_DRAG_TESTS
        if (message.message == kNativeDragCooperativeTestMessage) {
            dragActive_.store(true, std::memory_order_release);
            {
                std::lock_guard lock(snapshotMutex_);
                snapshot_ = {};
                snapshot_.requestId = nextRequestId_.fetch_add(1, std::memory_order_relaxed);
                snapshot_.stage = "TEST_COOPERATIVE_WAIT_ENTERED";
                snapshot_.requestReceived = true;
                snapshot_.workerQueued = true;
                snapshot_.workerAwakened = true;
                snapshot_.oleInitialized = true;
                snapshot_.cancellationHookInstalled =
                    cancellationHookInstalled_.load(std::memory_order_acquire);
                snapshot_.doDragDropEntered = true;
                snapshot_.workerThreadId = GetCurrentThreadId();
                snapshotStartedTicks_ = GetTickCount64();
            }
            SetEvent(cooperativeTestEnteredEvent_);
            WaitForSingleObject(cancellationEvent_, INFINITE);
            dragActive_.store(false, std::memory_order_release);
            continue;
        }
#endif
        if (message.message != kNativeDragMessage) {
            TranslateMessage(&message);
            DispatchMessageW(&message);
            continue;
        }

        std::unique_ptr<std::shared_ptr<DragRequest>> payload(
            reinterpret_cast<std::shared_ptr<DragRequest>*>(message.lParam));
        const std::shared_ptr<DragRequest> request = *payload;
        UpdateSnapshot(request->requestId, "WORKER_AWAKENED", [this](NativeDragSnapshot& snapshot) {
            snapshot.workerAwakened = true;
            snapshot.workerThreadId = GetCurrentThreadId();
        });
        UpdateSnapshot(request->requestId, "OLE_INITIALIZED", [this](NativeDragSnapshot& snapshot) {
            snapshot.oleInitialized = SUCCEEDED(oleInitializationResult_);
            snapshot.oleInitializeHresult = oleInitializationResult_;
        }, oleInitializationResult_);
        const auto startedAt = std::chrono::steady_clock::now();
        const double dispatchMilliseconds =
            std::chrono::duration<double, std::milli>(startedAt - request->queuedAt).count();
        NativeDragResult result;
        if (shuttingDown_.load(std::memory_order_acquire)) {
            result = ErrorResult(
                "ADDON_SHUTTING_DOWN",
                "The native drag addon stopped before the queued drag began.",
                E_ABORT,
                dispatchMilliseconds);
            MarkWorkerDispatched(result);
        } else {
            result = PerformDrag(request, dispatchMilliseconds);
        }
        result.requestId = request->requestId;
        dragActive_.store(false, std::memory_order_release);
        if (request->completion && !shuttingDown_.load(std::memory_order_acquire)) {
            request->completion(std::move(result));
        }
        if (shuttingDown_.load(std::memory_order_acquire)) break;
    }

    if (messageHook) UnhookWindowsHookEx(messageHook);
    OleUninitialize();
    oleCleanupCompleted_.store(true, std::memory_order_release);
}

NativeDragResult NativeDragWorker::PerformDrag(
    const std::shared_ptr<DragRequest>& request,
    double dispatchMilliseconds) {
    const std::wstring& absolutePath = request->path;
    if (cancellationRequested_.load(std::memory_order_acquire)) {
        NativeDragResult result;
        result.ok = true;
        result.cancelled = true;
        result.hresult = DRAGDROP_S_CANCEL;
        result.errorCode.clear();
        result.nativeDispatchMs = dispatchMilliseconds;
        MarkWorkerDispatched(result);
        return result;
    }
    const SHORT workerButtonState = GetAsyncKeyState(VK_LBUTTON);
    if ((workerButtonState & 0x8000) == 0) {
        NativeDragResult result = ErrorResult(
            "LEFT_BUTTON_NOT_HELD",
            "The primary mouse button was released before OLE entered the native drag loop.",
            HRESULT_FROM_WIN32(ERROR_CANCELLED),
            dispatchMilliseconds);
        MarkWorkerDispatched(result);
        UpdateSnapshot(request->requestId, "LEFT_BUTTON_RELEASED_BEFORE_OLE", [result](NativeDragSnapshot& snapshot) {
            snapshot.lastKeyState = 0;
            snapshot.hresult = result.hresult;
        }, result.hresult);
        return result;
    }

    IDataObject* dataObject = nullptr;
    const HRESULT dataObjectResult = CreateShellFileDataObject(absolutePath, &dataObject);
    if (FAILED(dataObjectResult) || !dataObject) {
        NativeDragResult result = ErrorResult(
            "SHELL_DATA_OBJECT_FAILED",
            HResultToErrorString(dataObjectResult),
            dataObjectResult,
            dispatchMilliseconds);
        MarkWorkerDispatched(result);
        UpdateSnapshot(request->requestId, "SHELL_DATA_OBJECT_FAILED", [dataObjectResult](NativeDragSnapshot& snapshot) {
            snapshot.hresult = dataObjectResult;
        }, dataObjectResult);
        return result;
    }
    TraceStage(request->requestId, "SHELL_DATA_OBJECT_CREATED", S_OK);
    DWORD effect = DROPEFFECT_NONE;
    const HWND foregroundWindow = GetForegroundWindow();
    DWORD foregroundProcessId = 0;
    const DWORD foregroundThreadId = foregroundWindow
        ? GetWindowThreadProcessId(foregroundWindow, &foregroundProcessId)
        : 0;
    POINT cursor{};
    GetCursorPos(&cursor);
    activeDragWindow_.store(
        reinterpret_cast<std::uintptr_t>(foregroundWindow),
        std::memory_order_release);
    activeForegroundThreadId_.store(foregroundThreadId, std::memory_order_release);
    UpdateSnapshot(request->requestId, "DO_DRAG_DROP_ENTERED", [=, this](NativeDragSnapshot& snapshot) {
        snapshot.doDragDropEntered = true;
        snapshot.lastKeyState = MK_LBUTTON;
        snapshot.foregroundWindow = reinterpret_cast<std::uintptr_t>(foregroundWindow);
        snapshot.foregroundWindowProcessId = foregroundProcessId;
        snapshot.foregroundWindowThreadId = foregroundThreadId;
        snapshot.workerThreadId = GetCurrentThreadId();
        snapshot.cursorX = cursor.x;
        snapshot.cursorY = cursor.y;
        snapshot.oleInitializeHresult = oleInitializationResult_;
    });
    // The custom IDropSource A/B entered both DoDragDrop and SHDoDragDrop in
    // Premiere 26.3 but Windows never called QueryContinueDrag/GiveFeedback.
    // Let the Shell create its standard drop source, cursor, and button loop.
    TraceStage(request->requestId, "SHELL_DROP_SOURCE_SELECTED");
    const DWORD workerThreadId = GetCurrentThreadId();
    const bool needsInputAttachment =
        foregroundThreadId != 0 && foregroundThreadId != workerThreadId;
    bool inputQueuesAttached = false;
    if (needsInputAttachment) {
        inputQueuesAttached = AttachThreadInput(workerThreadId, foregroundThreadId, TRUE) == TRUE;
        TraceStage(
            request->requestId,
            inputQueuesAttached ? "INPUT_QUEUES_ATTACHED" : "INPUT_QUEUE_ATTACH_FAILED",
            inputQueuesAttached ? S_OK : HRESULT_FROM_WIN32(GetLastError()));
    }
    TraceStage(request->requestId, "SH_DO_DRAG_DROP_ENTERED");
    const HRESULT callCancellationResult = CoEnableCallCancellation(nullptr);
    const HRESULT dragResult = SHDoDragDrop(
        foregroundWindow,
        dataObject,
        nullptr,
        DROPEFFECT_COPY,
        &effect);
    if (SUCCEEDED(callCancellationResult)) CoDisableCallCancellation(nullptr);
    TraceStage(request->requestId, "SH_DO_DRAG_DROP_RETURNED", dragResult);
    if (inputQueuesAttached) {
        const BOOL detached = AttachThreadInput(workerThreadId, foregroundThreadId, FALSE);
        TraceStage(
            request->requestId,
            detached ? "INPUT_QUEUES_DETACHED" : "INPUT_QUEUE_DETACH_FAILED",
            detached ? S_OK : HRESULT_FROM_WIN32(GetLastError()));
    }
    activeDragWindow_.store(0, std::memory_order_release);
    activeForegroundThreadId_.store(0, std::memory_order_release);
    UpdateSnapshot(request->requestId, "DO_DRAG_DROP_RETURNED", [dragResult, effect](NativeDragSnapshot& snapshot) {
        snapshot.doDragDropReturned = true;
        snapshot.finalEffect = effect;
        snapshot.currentEffect = effect;
        snapshot.hresult = dragResult;
    }, dragResult);
    dataObject->Release();

    if (dragResult == DRAGDROP_S_CANCEL ||
        cancellationRequested_.load(std::memory_order_acquire)) {
        NativeDragResult result;
        result.ok = true;
        result.cancelled = true;
        result.effect = effect;
        result.hresult = dragResult;
        result.errorCode.clear();
        result.nativeDispatchMs = dispatchMilliseconds;
        MarkDoDragDropReturned(result);
        return result;
    }
    if (dragResult == DRAGDROP_S_DROP && (effect & DROPEFFECT_COPY) != 0) {
        NativeDragResult result;
        result.ok = true;
        result.dropped = true;
        result.effect = effect;
        result.hresult = dragResult;
        result.errorCode.clear();
        result.nativeDispatchMs = dispatchMilliseconds;
        MarkDoDragDropReturned(result);
        return result;
    }
    if (SUCCEEDED(dragResult)) {
        NativeDragResult result;
        result.ok = true;
        result.cancelled = true;
        result.effect = effect;
        result.hresult = dragResult;
        result.errorCode.clear();
        result.nativeDispatchMs = dispatchMilliseconds;
        MarkDoDragDropReturned(result);
        return result;
    }
    NativeDragResult result = ErrorResult("DRAG_FAILED", HResultToErrorString(dragResult), dragResult, dispatchMilliseconds);
    MarkDoDragDropReturned(result);
    return result;
}

#ifdef ORACLE_NATIVE_DRAG_TESTS
bool NativeDragWorker::TryReserveDragForTesting() {
    bool expected = false;
    return dragActive_.compare_exchange_strong(expected, true, std::memory_order_acq_rel);
}
void NativeDragWorker::ReleaseDragForTesting() { dragActive_.store(false, std::memory_order_release); }

bool NativeDragWorker::BeginCooperativeShutdownWaitForTesting() {
    if (!thread_.joinable() || shuttingDown_.load(std::memory_order_acquire)) return false;
    cancellationRequested_.store(false, std::memory_order_release);
    ResetEvent(cancellationEvent_);
    ResetEvent(cooperativeTestEnteredEvent_);
    if (!PostThreadMessageW(threadId_, kNativeDragCooperativeTestMessage, 0, 0)) return false;
    return WaitForSingleObject(cooperativeTestEnteredEvent_, 2000) == WAIT_OBJECT_0;
}

NativeDragStopResult NativeDragWorker::ForcedTerminationDiagnosticForTesting(DWORD waitResult) {
    return ForcedTerminationFailure(waitResult, ERROR_TIMEOUT);
}
#endif

}  // namespace oracle::native_drag
