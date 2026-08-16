#pragma once

#include <Windows.h>
#include <Ole2.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>

namespace oracle::native_drag {

struct NativeDragResult {
    std::uint64_t requestId = 0;
    bool ok = false;
    bool dropped = false;
    bool cancelled = false;
    DWORD effect = DROPEFFECT_NONE;
    HRESULT hresult = E_FAIL;
    std::string errorCode = "DRAG_FAILED";
    std::string errorMessage;
    double nativeDispatchMs = 0.0;
    std::string lastStage = "REQUEST_RECEIVED";
    bool requestReceived = true;
    bool pathValidated = false;
    bool leftButtonConfirmed = false;
    bool workerDispatched = false;
    bool doDragDropEntered = false;
    bool doDragDropReturned = false;
};

struct NativeDragSnapshot {
    std::uint64_t requestId = 0;
    std::string stage = "IDLE";
    bool requestReceived = false;
    bool pathValidated = false;
    bool leftButtonConfirmed = false;
    bool workerQueued = false;
    bool workerAwakened = false;
    bool oleInitialized = false;
    bool doDragDropEntered = false;
    bool doDragDropReturned = false;
    std::uint64_t queryContinueDragCalls = 0;
    std::uint64_t giveFeedbackCalls = 0;
    DWORD lastKeyState = 0;
    bool escapeObserved = false;
    DWORD currentEffect = DROPEFFECT_NONE;
    DWORD finalEffect = DROPEFFECT_NONE;
    HRESULT hresult = E_PENDING;
    HRESULT oleInitializeHresult = E_PENDING;
    DWORD workerThreadId = 0;
    DWORD callerThreadId = 0;
    std::uintptr_t foregroundWindow = 0;
    DWORD foregroundWindowProcessId = 0;
    DWORD foregroundWindowThreadId = 0;
    LONG cursorX = 0;
    LONG cursorY = 0;
    bool promiseCreated = false;
    bool promiseResolved = false;
    bool promiseRejected = false;
    bool shutdownCancellationRequested = false;
    bool workerExited = false;
    bool oleCleanupCompleted = false;
    bool cancellationHookInstalled = false;
    bool forcedTermination = false;
    std::string shutdownErrorCode;
    double elapsedMs = 0.0;
};

struct NativeDragStopResult {
    bool attempted = false;
    bool ok = false;
    bool cancellationRequested = false;
    bool workerExited = false;
    bool oleCleanupCompleted = false;
    bool forcedTermination = false;
    DWORD waitResult = WAIT_FAILED;
    DWORD win32Error = ERROR_SUCCESS;
    std::string errorCode;
    std::string errorMessage;
};

struct PathValidationResult {
    bool ok = false;
    std::string errorCode;
    std::string errorMessage;
    std::wstring normalizedPath;
};

PathValidationResult ValidateAbsoluteFilePath(const std::wstring& absolutePath);
HRESULT CreateHDropStorageMedium(const std::wstring& absolutePath, STGMEDIUM* medium);
HRESULT CreateShellFileDataObject(const std::wstring& absolutePath, IDataObject** dataObject);
HGLOBAL DuplicateHGlobal(HGLOBAL source);
std::string HResultToErrorString(HRESULT result);

#ifdef ORACLE_NATIVE_DRAG_TESTS
bool NativeDevelopmentTraceEnabledForTesting() noexcept;
#endif

class FileDropDataObject final : public IDataObject {
  public:
    explicit FileDropDataObject(HGLOBAL hdropTemplate);

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;
    HRESULT STDMETHODCALLTYPE GetData(FORMATETC* format, STGMEDIUM* medium) override;
    HRESULT STDMETHODCALLTYPE GetDataHere(FORMATETC*, STGMEDIUM*) override;
    HRESULT STDMETHODCALLTYPE QueryGetData(FORMATETC* format) override;
    HRESULT STDMETHODCALLTYPE GetCanonicalFormatEtc(FORMATETC*, FORMATETC* output) override;
    HRESULT STDMETHODCALLTYPE SetData(FORMATETC*, STGMEDIUM*, BOOL) override;
    HRESULT STDMETHODCALLTYPE EnumFormatEtc(DWORD direction, IEnumFORMATETC** enumerator) override;
    HRESULT STDMETHODCALLTYPE DAdvise(FORMATETC*, DWORD, IAdviseSink*, DWORD*) override;
    HRESULT STDMETHODCALLTYPE DUnadvise(DWORD) override;
    HRESULT STDMETHODCALLTYPE EnumDAdvise(IEnumSTATDATA**) override;

  private:
    ~FileDropDataObject();

    std::atomic<ULONG> references_{1};
    HGLOBAL hdropTemplate_ = nullptr;
    FORMATETC format_{CF_HDROP, nullptr, DVASPECT_CONTENT, -1, TYMED_HGLOBAL};
};

class FileDropSource final : public IDropSource {
  public:
    using QueryObserver = std::function<void(BOOL, DWORD)>;
    using FeedbackObserver = std::function<void(DWORD)>;

    FileDropSource(
        QueryObserver queryObserver = {},
        FeedbackObserver feedbackObserver = {},
        const std::atomic<bool>* cancellationRequested = nullptr);
    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override;
    ULONG STDMETHODCALLTYPE AddRef() override;
    ULONG STDMETHODCALLTYPE Release() override;
    HRESULT STDMETHODCALLTYPE QueryContinueDrag(BOOL escapePressed, DWORD keyState) override;
    HRESULT STDMETHODCALLTYPE GiveFeedback(DWORD effect) override;

  private:
    ~FileDropSource() = default;
    std::atomic<ULONG> references_{1};
    QueryObserver queryObserver_;
    FeedbackObserver feedbackObserver_;
    const std::atomic<bool>* cancellationRequested_ = nullptr;
};

class NativeDragWorker final {
  public:
    NativeDragWorker();
    ~NativeDragWorker();

    NativeDragWorker(const NativeDragWorker&) = delete;
    NativeDragWorker& operator=(const NativeDragWorker&) = delete;

    using Completion = std::function<void(NativeDragResult)>;

    std::uint64_t StartNativeFileDragAsync(
        const std::wstring& absolutePath,
        DWORD callerThreadId,
        Completion completion);
    NativeDragSnapshot GetSnapshot() const;
    void MarkPromiseSettled(std::uint64_t requestId, bool resolved);
    bool IsAvailable() const noexcept;
    std::string OleWorkerState() const;
    bool CancelActiveDrag();
    NativeDragStopResult Stop();

#ifdef ORACLE_NATIVE_DRAG_TESTS
    bool TryReserveDragForTesting();
    void ReleaseDragForTesting();
    bool BeginCooperativeShutdownWaitForTesting();
    static NativeDragStopResult ForcedTerminationDiagnosticForTesting(DWORD waitResult);
#endif

  private:
    struct DragRequest;

    void ThreadMain();
    NativeDragResult PerformDrag(const std::shared_ptr<DragRequest>& request, double dispatchMilliseconds);
    void UpdateSnapshot(
        std::uint64_t requestId,
        const char* stage,
        const std::function<void(NativeDragSnapshot&)>& update,
        HRESULT traceResult = E_PENDING);
    void CompleteImmediately(std::uint64_t requestId, NativeDragResult result, const Completion& completion);
    void RequestCancellationSignal();
    void RecordStopSnapshot(const NativeDragStopResult& result, const char* stage);

    HANDLE cancellationEvent_ = nullptr;
    std::thread thread_;
    std::mutex startupMutex_;
    std::condition_variable startupCondition_;
    DWORD threadId_ = 0;
    HRESULT oleInitializationResult_ = E_PENDING;
    bool startupComplete_ = false;
    std::atomic<bool> shuttingDown_{false};
    std::atomic<bool> cancellationRequested_{false};
    std::atomic<bool> oleCleanupCompleted_{false};
    std::atomic<bool> cancellationHookInstalled_{false};
    std::atomic<bool> dragActive_{false};
    std::atomic<std::uintptr_t> activeDragWindow_{0};
    std::atomic<DWORD> activeForegroundThreadId_{0};
    std::atomic<std::uint64_t> nextRequestId_{1};
    std::mutex stopMutex_;
    NativeDragStopResult stopResult_;
    mutable std::mutex snapshotMutex_;
    NativeDragSnapshot snapshot_;
    std::uint64_t snapshotStartedTicks_ = 0;
#ifdef ORACLE_NATIVE_DRAG_TESTS
    HANDLE cooperativeTestEnteredEvent_ = nullptr;
#endif
};

}  // namespace oracle::native_drag
