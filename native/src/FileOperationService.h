#pragma once

#include "SafeFileIdentity.h"

#include <Windows.h>

#include <atomic>
#include <condition_variable>
#include <cstdint>
#include <deque>
#include <functional>
#include <memory>
#include <mutex>
#include <string>
#include <thread>
#include <unordered_map>
#include <vector>

namespace oracle::file_operation {

struct RegistrationResult {
    bool ok = false;
    std::string recordId;
    std::wstring normalizedPath;
    std::string identityKey;
    unsigned long win32Error = 0;
    std::string errorCode;
    std::string errorMessage;
};

struct FileOperationItemResult {
    std::string recordId;
    std::wstring path;
    bool ok = false;
    bool cancelled = false;
    long hresult = E_FAIL;
    unsigned long win32Error = 0;
    std::string errorCode;
    std::string errorMessage;
};

struct FileOperationBatchResult {
    std::uint64_t requestId = 0;
    bool ok = false;
    bool cancelled = false;
    bool anyOperationsAborted = false;
    bool handlesReleasedBeforeMutation = true;
    long hresult = E_FAIL;
    std::vector<FileOperationItemResult> items;
};

struct RevealResult {
    bool ok = false;
    std::string recordId;
    std::wstring path;
    long hresult = E_FAIL;
    unsigned long win32Error = 0;
    std::string errorCode;
    std::string errorMessage;
};

struct FileRenameResult {
    bool ok = false;
    std::string recordId;
    std::wstring oldPath;
    std::wstring newPath;
    std::string identityKey;
    bool rollbackAttempted = false;
    bool rollbackSucceeded = false;
    unsigned long win32Error = 0;
    std::string errorCode;
    std::string errorMessage;
};

using ShellRevealInvoker = std::function<HRESULT(const std::wstring&)>;

// Calls SHOpenFolderAndSelectItems for exactly one already-validated file.
// Tests can provide an invoker to verify selection behavior without opening UI.
RevealResult RevealValidatedFileInExplorer(
    const std::string& recordId,
    const std::wstring& path,
    const file_identity::StableFileIdentity& expectedIdentity,
    ShellRevealInvoker invoker = {});

class FileOperationService final {
  public:
    using Completion = std::function<void(FileOperationBatchResult)>;

    FileOperationService();
    ~FileOperationService();

    FileOperationService(const FileOperationService&) = delete;
    FileOperationService& operator=(const FileOperationService&) = delete;

    RegistrationResult RegisterKnownFile(
        const std::string& recordId,
        const std::wstring& absolutePath,
        const std::string& expectedIdentityKey = {});
    bool UnregisterKnownFile(const std::string& recordId);
    RegistrationResult InspectKnownFile(const std::string& recordId) const;
    RevealResult RevealKnownFileInExplorer(
        const std::string& recordId,
        ShellRevealInvoker invoker = {}) const;
    FileRenameResult RenameKnownFile(
        const std::string& recordId,
        const std::wstring& targetAbsolutePath);

    std::uint64_t RecycleKnownFilesAsync(
        std::vector<std::string> recordIds,
        Completion completion);
    bool CancelRequest(std::uint64_t requestId);
    bool IsAvailable() const noexcept;
    void Stop();

#ifdef ORACLE_FILE_OPERATION_TESTS
    void PauseBeforePerformForTesting(bool pause);
    bool WaitUntilPausedForTesting(unsigned long timeoutMilliseconds);
    void ReleasePausedOperationForTesting();
    void SetBeforeFinalValidationHookForTesting(std::function<void()> hook);
    void SetBeforeRenameValidationHookForTesting(std::function<void()> hook);
#endif

  private:
    struct KnownFileRecord;
    struct Request;

    void ThreadMain();
    FileOperationBatchResult Execute(const std::shared_ptr<Request>& request);

    mutable std::mutex registryMutex_;
    std::unordered_map<std::string, KnownFileRecord> knownFiles_;

    std::thread worker_;
    mutable std::mutex queueMutex_;
    std::condition_variable queueCondition_;
    std::deque<std::shared_ptr<Request>> queue_;
    std::shared_ptr<Request> activeRequest_;
    std::atomic<std::uint64_t> nextRequestId_{1};
    std::atomic<bool> stopping_{false};
    std::atomic<bool> available_{false};

#ifdef ORACLE_FILE_OPERATION_TESTS
    std::mutex testMutex_;
    std::condition_variable testCondition_;
    bool pauseBeforePerform_ = false;
    bool operationPaused_ = false;
    bool releasePausedOperation_ = false;
    std::function<void()> beforeFinalValidationHook_;
    std::function<void()> beforeRenameValidationHook_;
#endif
};

}  // namespace oracle::file_operation
