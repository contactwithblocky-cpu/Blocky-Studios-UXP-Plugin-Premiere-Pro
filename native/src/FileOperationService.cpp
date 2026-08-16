#include "FileOperationService.h"

#include <ShlObj.h>
#include <ShObjIdl.h>
#include <shellapi.h>
#include <sherrors.h>

#include <algorithm>
#include <chrono>
#include <cwctype>
#include <filesystem>
#include <memory>
#include <new>
#include <set>
#include <unordered_map>
#include <utility>

namespace oracle::file_operation {
namespace {

template <typename T>
class ComPtr final {
  public:
    ComPtr() = default;
    explicit ComPtr(T* value) : value_(value) {}
    ~ComPtr() { reset(); }
    ComPtr(const ComPtr&) = delete;
    ComPtr& operator=(const ComPtr&) = delete;
    ComPtr(ComPtr&& other) noexcept : value_(other.value_) { other.value_ = nullptr; }
    ComPtr& operator=(ComPtr&& other) noexcept {
        if (this != &other) {
            reset();
            value_ = other.value_;
            other.value_ = nullptr;
        }
        return *this;
    }
    T* get() const noexcept { return value_; }
    T** put() {
        reset();
        return &value_;
    }
    T* operator->() const noexcept { return value_; }
    explicit operator bool() const noexcept { return value_ != nullptr; }
    void reset(T* value = nullptr) {
        if (value_) value_->Release();
        value_ = value;
    }

  private:
    T* value_ = nullptr;
};

std::string HResultCode(HRESULT result) {
    if (result == HRESULT_FROM_WIN32(ERROR_CANCELLED) ||
        result == COPYENGINE_E_USER_CANCELLED || result == COPYENGINE_E_CANCELLED) {
        return "RECYCLE_CANCELLED";
    }
    if (result == HRESULT_FROM_WIN32(ERROR_SHARING_VIOLATION) ||
        result == HRESULT_FROM_WIN32(ERROR_LOCK_VIOLATION) ||
        result == COPYENGINE_E_SHARING_VIOLATION_SRC ||
        result == COPYENGINE_E_SHARING_VIOLATION_DEST) {
        return "FILE_IN_USE";
    }
    if (result == HRESULT_FROM_WIN32(ERROR_FILE_NOT_FOUND) ||
        result == HRESULT_FROM_WIN32(ERROR_PATH_NOT_FOUND) ||
        result == COPYENGINE_E_PATH_NOT_FOUND_SRC ||
        result == COPYENGINE_E_PATH_NOT_FOUND_DEST) {
        return "FILE_NOT_FOUND";
    }
    if (result == COPYENGINE_E_ACCESS_DENIED_SRC ||
        result == COPYENGINE_E_ACCESS_DENIED_DEST ||
        result == COPYENGINE_E_ACCESSDENIED_READONLY) {
        return "ACCESS_DENIED";
    }
    if (result == COPYENGINE_E_RECYCLE_FORCE_NUKE ||
        result == COPYENGINE_E_RECYCLE_SIZE_TOO_BIG ||
        result == COPYENGINE_E_RECYCLE_PATH_TOO_LONG ||
        result == COPYENGINE_E_RECYCLE_BIN_NOT_FOUND) {
        return "RECYCLE_UNAVAILABLE";
    }
    return "RECYCLE_FAILED";
}

bool IsCancellationHResult(HRESULT result) {
    return result == HRESULT_FROM_WIN32(ERROR_CANCELLED) ||
        result == COPYENGINE_E_USER_CANCELLED || result == COPYENGINE_E_CANCELLED;
}

std::string HResultMessage(HRESULT result) {
    wchar_t* message = nullptr;
    const DWORD flags = FORMAT_MESSAGE_ALLOCATE_BUFFER | FORMAT_MESSAGE_FROM_SYSTEM |
        FORMAT_MESSAGE_IGNORE_INSERTS;
    const DWORD length = FormatMessageW(
        flags,
        nullptr,
        static_cast<DWORD>(result),
        MAKELANGID(LANG_NEUTRAL, SUBLANG_DEFAULT),
        reinterpret_cast<wchar_t*>(&message),
        0,
        nullptr);
    std::string output = "Windows Shell operation failed.";
    if (length && message) {
        const int required = WideCharToMultiByte(
            CP_UTF8, 0, message, static_cast<int>(length), nullptr, 0, nullptr, nullptr);
        if (required > 0) {
            output.resize(static_cast<std::size_t>(required));
            WideCharToMultiByte(
                CP_UTF8,
                0,
                message,
                static_cast<int>(length),
                output.data(),
                required,
                nullptr,
                nullptr);
            while (!output.empty() &&
                   (output.back() == '\r' || output.back() == '\n' || output.back() == ' ')) {
                output.pop_back();
            }
        }
    }
    if (message) LocalFree(message);
    return output;
}

FileOperationItemResult ItemFailure(
    const std::string& recordId,
    const std::wstring& path,
    std::string errorCode,
    std::string errorMessage,
    HRESULT result = E_FAIL,
    DWORD win32Error = ERROR_SUCCESS) {
    FileOperationItemResult output;
    output.recordId = recordId;
    output.path = path;
    output.hresult = result;
    output.win32Error = win32Error;
    output.errorCode = std::move(errorCode);
    output.errorMessage = std::move(errorMessage);
    return output;
}

std::wstring ShellItemPath(IShellItem* item) {
    if (!item) return {};
    PWSTR value = nullptr;
    if (FAILED(item->GetDisplayName(SIGDN_FILESYSPATH, &value)) || !value) return {};
    std::wstring path(value);
    CoTaskMemFree(value);
    return file_identity::NormalizePathForComparison(path);
}

struct DeleteExpectation {
    std::size_t resultIndex = 0;
    file_identity::StableFileIdentity identity;
};

class DeleteProgressSink final : public IFileOperationProgressSink {
  public:
    DeleteProgressSink(
        const std::atomic<bool>* cancellationRequested,
        std::unordered_map<std::wstring, DeleteExpectation> expectations,
        std::vector<FileOperationItemResult>* results)
        : cancellationRequested_(cancellationRequested),
          expectations_(std::move(expectations)),
          results_(results) {}

    HRESULT STDMETHODCALLTYPE QueryInterface(REFIID iid, void** object) override {
        if (!object) return E_POINTER;
        *object = nullptr;
        if (iid == IID_IUnknown || iid == IID_IFileOperationProgressSink) {
            *object = static_cast<IFileOperationProgressSink*>(this);
            AddRef();
            return S_OK;
        }
        return E_NOINTERFACE;
    }
    ULONG STDMETHODCALLTYPE AddRef() override { return ++references_; }
    ULONG STDMETHODCALLTYPE Release() override {
        const ULONG remaining = --references_;
        if (remaining == 0) delete this;
        return remaining;
    }
    HRESULT STDMETHODCALLTYPE StartOperations() override { return S_OK; }
    HRESULT STDMETHODCALLTYPE FinishOperations(HRESULT result) override {
        finishResult_ = result;
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE PreRenameItem(DWORD, IShellItem*, LPCWSTR) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE PostRenameItem(DWORD, IShellItem*, LPCWSTR, HRESULT, IShellItem*) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE PreMoveItem(DWORD, IShellItem*, IShellItem*, LPCWSTR) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE PostMoveItem(
        DWORD, IShellItem*, IShellItem*, LPCWSTR, HRESULT, IShellItem*) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE PreCopyItem(DWORD, IShellItem*, IShellItem*, LPCWSTR) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE PostCopyItem(
        DWORD, IShellItem*, IShellItem*, LPCWSTR, HRESULT, IShellItem*) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE PreDeleteItem(DWORD, IShellItem* item) override {
        const auto found = expectations_.find(ShellItemPath(item));
        if (found == expectations_.end() || !results_ ||
            found->second.resultIndex >= results_->size()) {
            return HRESULT_FROM_WIN32(ERROR_FILE_INVALID);
        }
        auto& output = (*results_)[found->second.resultIndex];
        if (cancellationRequested_ && cancellationRequested_->load()) {
            output.ok = false;
            output.cancelled = true;
            output.hresult = HRESULT_FROM_WIN32(ERROR_CANCELLED);
            output.win32Error = ERROR_CANCELLED;
            output.errorCode = "RECYCLE_CANCELLED";
            output.errorMessage = "The recycle request was cancelled before mutation.";
            return output.hresult;
        }

        // DeleteItem only queues a path. Resolve that path again in the Shell's
        // last pre-mutation callback so a same-name replacement created after
        // queueing can never inherit the registered replay's recycle request.
        const auto inspection = file_identity::InspectSafeRegularFile(output.path);
        if (!inspection.ok) {
            output.ok = false;
            output.cancelled = false;
            output.win32Error = inspection.win32Error;
            output.hresult = inspection.win32Error
                ? HRESULT_FROM_WIN32(inspection.win32Error)
                : HRESULT_FROM_WIN32(ERROR_FILE_INVALID);
            output.errorCode = inspection.errorCode;
            output.errorMessage = inspection.errorMessage;
            return output.hresult;
        }
        if (inspection.identity != found->second.identity) {
            output.ok = false;
            output.cancelled = false;
            output.hresult = HRESULT_FROM_WIN32(ERROR_FILE_INVALID);
            output.win32Error = ERROR_FILE_INVALID;
            output.errorCode = "FILE_IDENTITY_CHANGED";
            output.errorMessage =
                "The file was replaced after recycle was queued; the replacement was preserved.";
            return output.hresult;
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE PostDeleteItem(
        DWORD,
        IShellItem* item,
        HRESULT result,
        IShellItem*) override {
        const auto found = expectations_.find(ShellItemPath(item));
        if (found == expectations_.end() || !results_ ||
            found->second.resultIndex >= results_->size()) return S_OK;
        auto& output = (*results_)[found->second.resultIndex];
        if (output.errorCode != "RECYCLE_NOT_PERFORMED") return S_OK;
        output.hresult = result;
        output.win32Error = HRESULT_FACILITY(result) == FACILITY_WIN32 ? HRESULT_CODE(result) : ERROR_SUCCESS;
        if (SUCCEEDED(result)) {
            output.ok = true;
            output.errorCode.clear();
            output.errorMessage.clear();
        } else {
            output.cancelled = IsCancellationHResult(result);
            output.errorCode = HResultCode(result);
            output.errorMessage = HResultMessage(result);
        }
        return S_OK;
    }
    HRESULT STDMETHODCALLTYPE PreNewItem(DWORD, IShellItem*, LPCWSTR) override { return E_NOTIMPL; }
    HRESULT STDMETHODCALLTYPE PostNewItem(DWORD, IShellItem*, LPCWSTR, LPCWSTR, DWORD, HRESULT, IShellItem*) override {
        return E_NOTIMPL;
    }
    HRESULT STDMETHODCALLTYPE UpdateProgress(UINT, UINT) override { return S_OK; }
    HRESULT STDMETHODCALLTYPE ResetTimer() override { return S_OK; }
    HRESULT STDMETHODCALLTYPE PauseTimer() override { return S_OK; }
    HRESULT STDMETHODCALLTYPE ResumeTimer() override { return S_OK; }

    HRESULT FinishResult() const noexcept { return finishResult_; }

  private:
    ~DeleteProgressSink() = default;
    std::atomic<ULONG> references_{1};
    const std::atomic<bool>* cancellationRequested_ = nullptr;
    std::unordered_map<std::wstring, DeleteExpectation> expectations_;
    std::vector<FileOperationItemResult>* results_ = nullptr;
    HRESULT finishResult_ = E_PENDING;
};

HRESULT InvokeShellRevealOnCurrentThread(const std::wstring& path) {
    PIDLIST_ABSOLUTE absoluteItem = nullptr;
    HRESULT result = SHParseDisplayName(path.c_str(), nullptr, &absoluteItem, 0, nullptr);
    if (FAILED(result) || !absoluteItem) return FAILED(result) ? result : E_FAIL;
    PCUITEMID_CHILD child = ILFindLastID(absoluteItem);
    PIDLIST_ABSOLUTE parent = ILCloneFull(absoluteItem);
    if (!child || !parent || !ILRemoveLastID(parent)) {
        if (parent) CoTaskMemFree(parent);
        CoTaskMemFree(absoluteItem);
        return E_FAIL;
    }
    PCUITEMID_CHILD children[1]{child};
    result = SHOpenFolderAndSelectItems(parent, 1, children, 0);
    CoTaskMemFree(parent);
    CoTaskMemFree(absoluteItem);
    return result;
}

HRESULT DefaultShellReveal(const std::wstring& path) {
    // Explorer selection uses a short-lived STA of its own. It never borrows
    // the long-lived OLE drag apartment or the UXP scripting thread apartment.
    HRESULT output = E_FAIL;
    std::thread worker([&] {
        const HRESULT initialized = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
        if (FAILED(initialized)) {
            output = initialized;
            return;
        }
        output = InvokeShellRevealOnCurrentThread(path);
        CoUninitialize();
    });
    worker.join();
    return output;
}

std::wstring LowerExtension(const std::filesystem::path& path) {
    std::wstring extension = path.extension().wstring();
    std::transform(extension.begin(), extension.end(), extension.begin(), [](wchar_t character) {
        return static_cast<wchar_t>(std::towlower(character));
    });
    return extension;
}

bool IsSupportedReplayExtension(const std::wstring& extension) {
    static const std::set<std::wstring> supported{
        L".avi", L".m4v", L".mkv", L".mov", L".mp4", L".mpeg",
        L".mpg", L".webm", L".wmv"};
    return supported.contains(extension);
}

}  // namespace

struct FileOperationService::KnownFileRecord {
    std::string recordId;
    std::wstring path;
    file_identity::StableFileIdentity identity;
};

struct FileOperationService::Request {
    std::uint64_t requestId = 0;
    std::vector<std::string> recordIds;
    Completion completion;
    std::atomic<bool> cancellationRequested{false};
};

RevealResult RevealValidatedFileInExplorer(
    const std::string& recordId,
    const std::wstring& path,
    const file_identity::StableFileIdentity& expectedIdentity,
    ShellRevealInvoker invoker) {
    RevealResult result;
    result.recordId = recordId;
    result.path = path;
    const auto inspection = file_identity::InspectSafeRegularFile(path);
    if (!inspection.ok) {
        result.win32Error = inspection.win32Error;
        result.errorCode = inspection.errorCode;
        result.errorMessage = inspection.errorMessage;
        result.hresult = inspection.win32Error
            ? HRESULT_FROM_WIN32(inspection.win32Error)
            : E_INVALIDARG;
        return result;
    }
    if (inspection.identity != expectedIdentity) {
        result.errorCode = "FILE_IDENTITY_CHANGED";
        result.errorMessage = "The file at this path is no longer the registered replay.";
        result.hresult = HRESULT_FROM_WIN32(ERROR_FILE_INVALID);
        return result;
    }
    result.path = inspection.normalizedPath;
    const HRESULT shellResult = (invoker ? invoker : DefaultShellReveal)(result.path);
    result.hresult = shellResult;
    result.win32Error = HRESULT_FACILITY(shellResult) == FACILITY_WIN32
        ? HRESULT_CODE(shellResult)
        : ERROR_SUCCESS;
    result.ok = SUCCEEDED(shellResult);
    if (!result.ok) {
        result.errorCode = "REVEAL_FAILED";
        result.errorMessage = HResultMessage(shellResult);
    }
    return result;
}

FileOperationService::FileOperationService() {
    worker_ = std::thread(&FileOperationService::ThreadMain, this);
    for (int attempt = 0; attempt < 200 && !available_.load() && worker_.joinable(); ++attempt) {
        if (stopping_.load()) break;
        std::this_thread::sleep_for(std::chrono::milliseconds(5));
    }
}

FileOperationService::~FileOperationService() {
    Stop();
}

RegistrationResult FileOperationService::RegisterKnownFile(
    const std::string& recordId,
    const std::wstring& absolutePath,
    const std::string& expectedIdentityKey) {
    RegistrationResult result;
    result.recordId = recordId;
    if (recordId.empty() || recordId.size() > 256 ||
        std::any_of(recordId.begin(), recordId.end(), [](unsigned char value) { return value < 0x20; })) {
        result.errorCode = "INVALID_RECORD_ID";
        result.errorMessage = "Known replay record IDs must be non-empty control-free strings.";
        return result;
    }
    const auto inspection = file_identity::InspectSafeRegularFile(absolutePath);
    if (!inspection.ok) {
        result.win32Error = inspection.win32Error;
        result.errorCode = inspection.errorCode;
        result.errorMessage = inspection.errorMessage;
        return result;
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
            result.errorMessage = "The file identity does not match the library record.";
            return result;
        }
    }
    KnownFileRecord record{recordId, inspection.normalizedPath, inspection.identity};
    {
        std::lock_guard lock(registryMutex_);
        if (knownFiles_.size() >= 10000 && !knownFiles_.contains(recordId)) {
            result.errorCode = "KNOWN_FILE_LIMIT_REACHED";
            result.errorMessage = "The native known-file registry is full.";
            return result;
        }
        knownFiles_[recordId] = std::move(record);
    }
    result.ok = true;
    result.normalizedPath = inspection.normalizedPath;
    result.identityKey = inspection.identity.ToKey();
    return result;
}

bool FileOperationService::UnregisterKnownFile(const std::string& recordId) {
    std::lock_guard lock(registryMutex_);
    return knownFiles_.erase(recordId) != 0;
}

RegistrationResult FileOperationService::InspectKnownFile(const std::string& recordId) const {
    KnownFileRecord record;
    {
        std::lock_guard lock(registryMutex_);
        const auto found = knownFiles_.find(recordId);
        if (found == knownFiles_.end()) {
            RegistrationResult result;
            result.recordId = recordId;
            result.errorCode = "UNKNOWN_LIBRARY_RECORD";
            result.errorMessage = "The replay is not registered in native library state.";
            return result;
        }
        record = found->second;
    }
    RegistrationResult result;
    result.recordId = recordId;
    const auto inspection = file_identity::InspectSafeRegularFile(record.path);
    if (!inspection.ok) {
        result.win32Error = inspection.win32Error;
        result.errorCode = inspection.errorCode;
        result.errorMessage = inspection.errorMessage;
        return result;
    }
    if (inspection.identity != record.identity) {
        result.errorCode = "FILE_IDENTITY_CHANGED";
        result.errorMessage = "The file at this path is no longer the registered replay.";
        return result;
    }
    result.ok = true;
    result.normalizedPath = inspection.normalizedPath;
    result.identityKey = inspection.identity.ToKey();
    return result;
}

RevealResult FileOperationService::RevealKnownFileInExplorer(
    const std::string& recordId,
    ShellRevealInvoker invoker) const {
    KnownFileRecord record;
    {
        std::lock_guard lock(registryMutex_);
        const auto found = knownFiles_.find(recordId);
        if (found == knownFiles_.end()) {
            RevealResult result;
            result.recordId = recordId;
            result.errorCode = "UNKNOWN_LIBRARY_RECORD";
            result.errorMessage = "The replay is not registered in native library state.";
            return result;
        }
        record = found->second;
    }
    return RevealValidatedFileInExplorer(recordId, record.path, record.identity, std::move(invoker));
}

FileRenameResult FileOperationService::RenameKnownFile(
    const std::string& recordId,
    const std::wstring& targetAbsolutePath) {
    FileRenameResult result;
    result.recordId = recordId;
    std::unique_lock registryLock(registryMutex_);
    const auto found = knownFiles_.find(recordId);
    if (found == knownFiles_.end()) {
        result.errorCode = "UNKNOWN_LIBRARY_RECORD";
        result.errorMessage = "The replay is not registered in native library state.";
        return result;
    }
    result.oldPath = found->second.path;
    result.identityKey = found->second.identity.ToKey();

    const auto sourceInspection = file_identity::InspectSafeRegularFile(found->second.path);
    if (!sourceInspection.ok) {
        result.win32Error = sourceInspection.win32Error;
        result.errorCode = sourceInspection.errorCode;
        result.errorMessage = sourceInspection.errorMessage;
        return result;
    }
    if (sourceInspection.identity != found->second.identity) {
        result.errorCode = "FILE_IDENTITY_CHANGED";
        result.errorMessage = "The source path no longer contains the registered replay.";
        return result;
    }

    auto targetInspection = file_identity::InspectSafeNewFileTarget(targetAbsolutePath);
    if (!targetInspection.ok) {
        result.win32Error = targetInspection.win32Error;
        result.errorCode = targetInspection.errorCode;
        result.errorMessage = targetInspection.errorMessage;
        return result;
    }
    result.newPath = targetInspection.normalizedPath;
    const std::filesystem::path sourcePath(sourceInspection.normalizedPath);
    const std::filesystem::path targetPath(targetInspection.normalizedPath);
    if (file_identity::NormalizePathForComparison(sourcePath.parent_path().wstring()) !=
        file_identity::NormalizePathForComparison(targetPath.parent_path().wstring())) {
        result.errorCode = "RENAME_MUST_KEEP_PARENT";
        result.errorMessage = "Source-file rename cannot move a replay to another directory.";
        return result;
    }
    const std::wstring sourceExtension = LowerExtension(sourcePath);
    const std::wstring targetExtension = LowerExtension(targetPath);
    if (!IsSupportedReplayExtension(sourceExtension) || targetExtension != sourceExtension) {
        result.errorCode = "RENAME_EXTENSION_CHANGED";
        result.errorMessage = "Replay source-file rename must preserve its supported extension.";
        return result;
    }
    if (file_identity::NormalizePathForComparison(sourcePath.wstring()) ==
        file_identity::NormalizePathForComparison(targetPath.wstring())) {
        result.errorCode = "RENAME_TARGET_UNCHANGED";
        result.errorMessage = "The new source path is unchanged.";
        return result;
    }

#ifdef ORACLE_FILE_OPERATION_TESTS
    std::function<void()> renameHook;
    {
        std::lock_guard testLock(testMutex_);
        renameHook = beforeRenameValidationHook_;
        beforeRenameValidationHook_ = {};
    }
    if (renameHook) renameHook();
#endif

    // These final checks are deliberately adjacent to MoveFileExW. Both
    // inspection functions close every validation handle before returning.
    const auto finalSource = file_identity::InspectSafeRegularFile(found->second.path);
    if (!finalSource.ok || finalSource.identity != found->second.identity) {
        result.win32Error = finalSource.win32Error;
        result.errorCode = finalSource.ok ? "FILE_IDENTITY_CHANGED" : finalSource.errorCode;
        result.errorMessage = finalSource.ok
            ? "The source identity changed immediately before rename."
            : finalSource.errorMessage;
        return result;
    }
    targetInspection = file_identity::InspectSafeNewFileTarget(targetPath.wstring());
    if (!targetInspection.ok) {
        result.win32Error = targetInspection.win32Error;
        result.errorCode = targetInspection.errorCode;
        result.errorMessage = targetInspection.errorMessage;
        return result;
    }

    if (!MoveFileExW(
            found->second.path.c_str(),
            targetInspection.normalizedPath.c_str(),
            MOVEFILE_WRITE_THROUGH)) {
        const DWORD error = GetLastError();
        result.win32Error = error;
        result.errorCode = error == ERROR_SHARING_VIOLATION || error == ERROR_LOCK_VIOLATION
            ? "FILE_IN_USE"
            : (error == ERROR_FILE_EXISTS || error == ERROR_ALREADY_EXISTS
                   ? "RENAME_TARGET_EXISTS"
                   : "SOURCE_RENAME_FAILED");
        result.errorMessage = "Windows could not rename the replay source file.";
        return result;
    }

    const auto renamedInspection = file_identity::InspectSafeRegularFile(targetInspection.normalizedPath);
    if (!renamedInspection.ok || renamedInspection.identity != found->second.identity) {
        result.rollbackAttempted = true;
        result.rollbackSucceeded = MoveFileExW(
            targetInspection.normalizedPath.c_str(),
            found->second.path.c_str(),
            MOVEFILE_WRITE_THROUGH) != FALSE;
        result.win32Error = renamedInspection.win32Error;
        result.errorCode = "POST_RENAME_IDENTITY_FAILED";
        result.errorMessage = result.rollbackSucceeded
            ? "Post-rename identity validation failed; the source path was restored."
            : "Post-rename identity validation failed and automatic rollback also failed.";
        return result;
    }

    found->second.path = renamedInspection.normalizedPath;
    result.ok = true;
    result.newPath = renamedInspection.normalizedPath;
    result.identityKey = renamedInspection.identity.ToKey();
    return result;
}

std::uint64_t FileOperationService::RecycleKnownFilesAsync(
    std::vector<std::string> recordIds,
    Completion completion) {
    const std::uint64_t requestId = nextRequestId_.fetch_add(1);
    auto request = std::make_shared<Request>();
    request->requestId = requestId;
    request->recordIds = std::move(recordIds);
    request->completion = std::move(completion);
    const auto completeStopped = [&] {
        FileOperationBatchResult result;
        result.requestId = requestId;
        result.cancelled = true;
        result.anyOperationsAborted = true;
        result.hresult = HRESULT_FROM_WIN32(ERROR_CANCELLED);
        for (const auto& recordId : request->recordIds) {
            auto item = ItemFailure(
                recordId,
                {},
                "SERVICE_STOPPED",
                "The native file operation service is stopped.",
                HRESULT_FROM_WIN32(ERROR_CANCELLED),
                ERROR_CANCELLED);
            item.cancelled = true;
            result.items.push_back(std::move(item));
        }
        if (request->completion) request->completion(std::move(result));
    };
    if (stopping_.load()) {
        completeStopped();
        return requestId;
    }
    bool stoppedWhileQueuing = false;
    {
        std::lock_guard lock(queueMutex_);
        stoppedWhileQueuing = stopping_.load();
        if (!stoppedWhileQueuing) queue_.push_back(request);
    }
    if (stoppedWhileQueuing) {
        completeStopped();
        return requestId;
    }
    queueCondition_.notify_one();
    return requestId;
}

bool FileOperationService::CancelRequest(std::uint64_t requestId) {
    std::lock_guard lock(queueMutex_);
    if (activeRequest_ && activeRequest_->requestId == requestId) {
        activeRequest_->cancellationRequested.store(true);
        return true;
    }
    for (const auto& request : queue_) {
        if (request->requestId == requestId) {
            request->cancellationRequested.store(true);
            return true;
        }
    }
    return false;
}

bool FileOperationService::IsAvailable() const noexcept {
    return available_.load() && !stopping_.load();
}

void FileOperationService::Stop() {
    const bool wasStopping = stopping_.exchange(true);
    if (!wasStopping) {
        {
            std::lock_guard lock(queueMutex_);
            if (activeRequest_) activeRequest_->cancellationRequested.store(true);
            for (const auto& request : queue_) request->cancellationRequested.store(true);
        }
#ifdef ORACLE_FILE_OPERATION_TESTS
        ReleasePausedOperationForTesting();
#endif
        queueCondition_.notify_all();
    }
    if (worker_.joinable()) worker_.join();
    available_.store(false);
}

void FileOperationService::ThreadMain() {
    const HRESULT initializeResult = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
    if (FAILED(initializeResult)) {
        stopping_.store(true);
        queueCondition_.notify_all();
        return;
    }
    available_.store(true);
    while (true) {
        std::shared_ptr<Request> request;
        {
            std::unique_lock lock(queueMutex_);
            queueCondition_.wait(lock, [this] { return stopping_.load() || !queue_.empty(); });
            if (queue_.empty() && stopping_.load()) break;
            request = queue_.front();
            queue_.pop_front();
            activeRequest_ = request;
        }
        FileOperationBatchResult result = Execute(request);
        if (request->completion) request->completion(std::move(result));
        {
            std::lock_guard lock(queueMutex_);
            activeRequest_.reset();
        }
    }
    available_.store(false);
    CoUninitialize();
}

FileOperationBatchResult FileOperationService::Execute(const std::shared_ptr<Request>& request) {
    FileOperationBatchResult batch;
    batch.requestId = request->requestId;
    if (request->recordIds.empty() || request->recordIds.size() > 256) {
        batch.hresult = E_INVALIDARG;
        batch.items.push_back(ItemFailure(
            {}, {}, "INVALID_BATCH", "A recycle request must contain between 1 and 256 records.", E_INVALIDARG));
        return batch;
    }

    std::set<std::string> uniqueIds;
    std::vector<KnownFileRecord> candidates;
    batch.items.reserve(request->recordIds.size());
    candidates.reserve(request->recordIds.size());
    std::unique_lock registryLock(registryMutex_);
    for (const auto& recordId : request->recordIds) {
        if (!uniqueIds.insert(recordId).second) {
            batch.items.push_back(ItemFailure(
                recordId, {}, "DUPLICATE_RECORD", "The recycle batch contains a duplicate record ID."));
            candidates.push_back({});
            continue;
        }
        const auto found = knownFiles_.find(recordId);
        if (found == knownFiles_.end()) {
            batch.items.push_back(ItemFailure(
                recordId,
                {},
                "UNKNOWN_LIBRARY_RECORD",
                "The replay is not registered in native library state."));
            candidates.push_back({});
            continue;
        }
        const auto inspection = file_identity::InspectSafeRegularFile(found->second.path);
        if (!inspection.ok) {
            batch.items.push_back(ItemFailure(
                recordId,
                found->second.path,
                inspection.errorCode,
                inspection.errorMessage,
                inspection.win32Error ? HRESULT_FROM_WIN32(inspection.win32Error) : E_INVALIDARG,
                inspection.win32Error));
            candidates.push_back({});
            continue;
        }
        if (inspection.identity != found->second.identity) {
            batch.items.push_back(ItemFailure(
                recordId,
                found->second.path,
                "FILE_IDENTITY_CHANGED",
                "The file at this path is no longer the registered replay.",
                HRESULT_FROM_WIN32(ERROR_FILE_INVALID)));
            candidates.push_back({});
            continue;
        }
        candidates.push_back(found->second);
        batch.items.push_back(ItemFailure(
            recordId,
            found->second.path,
            "RECYCLE_NOT_PERFORMED",
            "The Shell recycle operation did not run."));
    }

#ifdef ORACLE_FILE_OPERATION_TESTS
    std::function<void()> validationHook;
    {
        std::lock_guard testLock(testMutex_);
        validationHook = beforeFinalValidationHook_;
        beforeFinalValidationHook_ = {};
    }
    if (validationHook) validationHook();
#endif

    if (request->cancellationRequested.load()) {
        for (auto& item : batch.items) {
            if (item.errorCode == "RECYCLE_NOT_PERFORMED") {
                item.cancelled = true;
                item.hresult = HRESULT_FROM_WIN32(ERROR_CANCELLED);
                item.win32Error = ERROR_CANCELLED;
                item.errorCode = "RECYCLE_CANCELLED";
                item.errorMessage = "The recycle request was cancelled before mutation.";
            }
        }
        batch.cancelled = true;
        batch.anyOperationsAborted = true;
        batch.hresult = HRESULT_FROM_WIN32(ERROR_CANCELLED);
        return batch;
    }

    ComPtr<IFileOperation> operation;
    HRESULT result = CoCreateInstance(
        CLSID_FileOperation,
        nullptr,
        CLSCTX_INPROC_SERVER,
        IID_PPV_ARGS(operation.put()));
    if (FAILED(result)) {
        batch.hresult = result;
        for (auto& item : batch.items) {
            if (item.errorCode == "RECYCLE_NOT_PERFORMED") {
                item.hresult = result;
                item.errorCode = "SHELL_SERVICE_UNAVAILABLE";
                item.errorMessage = HResultMessage(result);
            }
        }
        return batch;
    }
    constexpr DWORD flags = FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI |
        FOF_SILENT | FOFX_RECYCLEONDELETE;
    result = operation->SetOperationFlags(flags);
    if (FAILED(result)) {
        batch.hresult = result;
        for (auto& item : batch.items) {
            if (item.errorCode == "RECYCLE_NOT_PERFORMED") {
                item.hresult = result;
                item.errorCode = "RECYCLE_FLAGS_REJECTED";
                item.errorMessage = HResultMessage(result);
            }
        }
        return batch;
    }

    std::unordered_map<std::wstring, DeleteExpectation> expectations;
    std::vector<ComPtr<IShellItem>> shellItems;
    shellItems.reserve(candidates.size());
    for (std::size_t index = 0; index < candidates.size(); ++index) {
        const auto& candidate = candidates[index];
        if (candidate.recordId.empty()) {
            shellItems.emplace_back();
            continue;
        }
        // Final identity validation is deliberately adjacent to DeleteItem.
        // InspectSafeRegularFile closes its validation handle before returning.
        const auto finalInspection = file_identity::InspectSafeRegularFile(candidate.path);
        if (!finalInspection.ok || finalInspection.identity != candidate.identity) {
            auto& item = batch.items[index];
            item.errorCode = finalInspection.ok ? "FILE_IDENTITY_CHANGED" : finalInspection.errorCode;
            item.errorMessage = finalInspection.ok
                ? "The file identity changed immediately before recycle."
                : finalInspection.errorMessage;
            item.win32Error = finalInspection.win32Error;
            item.hresult = finalInspection.win32Error
                ? HRESULT_FROM_WIN32(finalInspection.win32Error)
                : HRESULT_FROM_WIN32(ERROR_FILE_INVALID);
            shellItems.emplace_back();
            continue;
        }
        ComPtr<IShellItem> shellItem;
        result = SHCreateItemFromParsingName(candidate.path.c_str(), nullptr, IID_PPV_ARGS(shellItem.put()));
        if (FAILED(result)) {
            auto& item = batch.items[index];
            item.hresult = result;
            item.errorCode = "SHELL_ITEM_CREATE_FAILED";
            item.errorMessage = HResultMessage(result);
            shellItems.emplace_back();
            continue;
        }
        result = operation->DeleteItem(shellItem.get(), nullptr);
        if (FAILED(result)) {
            auto& item = batch.items[index];
            item.hresult = result;
            item.errorCode = HResultCode(result);
            item.errorMessage = HResultMessage(result);
            shellItems.emplace_back();
            continue;
        }
        expectations.emplace(
            file_identity::NormalizePathForComparison(candidate.path),
            DeleteExpectation{index, candidate.identity});
        shellItems.push_back(std::move(shellItem));
    }

    auto* rawSink = new (std::nothrow) DeleteProgressSink(
        &request->cancellationRequested, std::move(expectations), &batch.items);
    if (!rawSink) {
        batch.hresult = E_OUTOFMEMORY;
        return batch;
    }
    ComPtr<DeleteProgressSink> sink(rawSink);
    DWORD adviseCookie = 0;
    result = operation->Advise(sink.get(), &adviseCookie);
    if (FAILED(result)) {
        batch.hresult = result;
        return batch;
    }

#ifdef ORACLE_FILE_OPERATION_TESTS
    {
        std::unique_lock testLock(testMutex_);
        if (pauseBeforePerform_) {
            operationPaused_ = true;
            releasePausedOperation_ = false;
            testCondition_.notify_all();
            testCondition_.wait(testLock, [this] {
                return releasePausedOperation_ || stopping_.load();
            });
            operationPaused_ = false;
        }
    }
#endif

    if (request->cancellationRequested.load()) {
        result = HRESULT_FROM_WIN32(ERROR_CANCELLED);
    } else {
        // registryLock remains held through PerformOperations, so a record
        // cannot leave known native state between validation and mutation.
        result = operation->PerformOperations();
    }
    operation->Unadvise(adviseCookie);

    BOOL aborted = FALSE;
    const HRESULT abortedResult = operation->GetAnyOperationsAborted(&aborted);
    batch.anyOperationsAborted = SUCCEEDED(abortedResult) && aborted;
    batch.cancelled = request->cancellationRequested.load() ||
        IsCancellationHResult(result);
    batch.anyOperationsAborted = batch.anyOperationsAborted || batch.cancelled;
    batch.hresult = result;

    for (std::size_t index = 0; index < batch.items.size(); ++index) {
        auto& item = batch.items[index];
        if (item.errorCode != "RECYCLE_NOT_PERFORMED") continue;
        const DWORD attributes = item.path.empty() ? INVALID_FILE_ATTRIBUTES
                                                   : GetFileAttributesW(item.path.c_str());
        if (attributes == INVALID_FILE_ATTRIBUTES &&
            (GetLastError() == ERROR_FILE_NOT_FOUND || GetLastError() == ERROR_PATH_NOT_FOUND)) {
            item.ok = true;
            item.hresult = S_OK;
            item.win32Error = ERROR_SUCCESS;
            item.errorCode.clear();
            item.errorMessage.clear();
        } else {
            const HRESULT itemResult = batch.cancelled
                ? HRESULT_FROM_WIN32(ERROR_CANCELLED)
                : (FAILED(result) ? result : E_FAIL);
            item.cancelled = batch.cancelled;
            item.hresult = itemResult;
            item.win32Error = HRESULT_FACILITY(itemResult) == FACILITY_WIN32
                ? HRESULT_CODE(itemResult)
                : ERROR_SUCCESS;
            item.errorCode = batch.cancelled ? "RECYCLE_CANCELLED" : HResultCode(itemResult);
            item.errorMessage = batch.cancelled
                ? "The recycle request was cancelled before this item was removed."
                : HResultMessage(itemResult);
        }
    }
    batch.ok = !batch.items.empty() &&
        std::all_of(batch.items.begin(), batch.items.end(), [](const auto& item) { return item.ok; });
    if (batch.ok) batch.hresult = S_OK;
    return batch;
}

#ifdef ORACLE_FILE_OPERATION_TESTS
void FileOperationService::PauseBeforePerformForTesting(bool pause) {
    std::lock_guard lock(testMutex_);
    pauseBeforePerform_ = pause;
}

bool FileOperationService::WaitUntilPausedForTesting(unsigned long timeoutMilliseconds) {
    std::unique_lock lock(testMutex_);
    return testCondition_.wait_for(
        lock,
        std::chrono::milliseconds(timeoutMilliseconds),
        [this] { return operationPaused_; });
}

void FileOperationService::ReleasePausedOperationForTesting() {
    {
        std::lock_guard lock(testMutex_);
        releasePausedOperation_ = true;
        pauseBeforePerform_ = false;
    }
    testCondition_.notify_all();
}

void FileOperationService::SetBeforeFinalValidationHookForTesting(std::function<void()> hook) {
    std::lock_guard lock(testMutex_);
    beforeFinalValidationHook_ = std::move(hook);
}

void FileOperationService::SetBeforeRenameValidationHookForTesting(std::function<void()> hook) {
    std::lock_guard lock(testMutex_);
    beforeRenameValidationHook_ = std::move(hook);
}
#endif

}  // namespace oracle::file_operation
