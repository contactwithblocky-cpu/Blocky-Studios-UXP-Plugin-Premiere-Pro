#include "NativeDragCore.h"
#include "AtomicFileService.h"
#include "DirectoryWatchService.h"
#include "FileOperationService.h"
#include "PackagedFontRegistrationService.h"
#include "ReplayMediaService.h"
#include "SafeFileIdentity.h"

#include "UxpAddon.h"

#include <array>
#include <atomic>
#include <cmath>
#include <cstdint>
#include <memory>
#include <new>
#include <stdexcept>
#include <string>
#include <vector>

namespace {

using oracle::native_drag::NativeDragResult;
using oracle::native_drag::NativeDragSnapshot;
using oracle::native_drag::NativeDragStopResult;
using oracle::native_drag::NativeDragWorker;

std::shared_ptr<NativeDragWorker> gWorker;
std::string gWorkerInitializationError;
std::shared_ptr<oracle::file_operation::FileOperationService> gFileOperations;
std::unique_ptr<oracle::directory_watch::DirectoryWatchService> gDirectoryWatcher;
std::unique_ptr<oracle::font_registration::PackagedFontRegistrationService> gPackagedFonts;
std::shared_ptr<oracle::replay_media::ReplayMediaService> gReplayMedia;
std::atomic<bool> gTerminating{false};
NativeDragStopResult gLastNativeDragStopResult;

constexpr const char* kAddonVersion = "2.0.18";

class ScopedDirectoryWatchPause final {
  public:
    explicit ScopedDirectoryWatchPause(
        oracle::directory_watch::DirectoryWatchService* watcher)
        : watcher_(watcher), wasRunning_(watcher && watcher->IsRunning()) {
        if (wasRunning_) {
            roots_ = watcher_->ConfiguredRoots();
            watcher_->Stop();
        }
    }

    ~ScopedDirectoryWatchPause() {
        if (wasRunning_ && !restartAttempted_ && watcher_) {
            try {
                watcher_->Start(roots_);
            } catch (...) {
                // Destructors must not escape into the UXP host.
            }
        }
    }

    bool WasRunning() const noexcept { return wasRunning_; }
    const std::vector<oracle::directory_watch::WatchRootConfig>& Roots() const noexcept {
        return roots_;
    }
    oracle::directory_watch::WatchStartResult Restart() {
        auto result = wasRunning_ && watcher_
            ? watcher_->Start(roots_)
            : oracle::directory_watch::WatchStartResult{.ok = true};
        restartAttempted_ = true;
        return result;
    }

  private:
    oracle::directory_watch::DirectoryWatchService* watcher_ = nullptr;
    bool wasRunning_ = false;
    bool restartAttempted_ = false;
    std::vector<oracle::directory_watch::WatchRootConfig> roots_;
};

void SetBoolean(addon_env env, addon_value object, const char* name, bool value) {
    addon_value property = nullptr;
    Check(UxpAddonApis.uxp_addon_get_boolean(env, value, &property));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, object, name, property));
}

void SetNumber(addon_env env, addon_value object, const char* name, double value) {
    addon_value property = nullptr;
    Check(UxpAddonApis.uxp_addon_create_double(env, value, &property));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, object, name, property));
}

void SetString(addon_env env, addon_value object, const char* name, const std::string& value) {
    addon_value property = nullptr;
    Check(UxpAddonApis.uxp_addon_create_string_utf8(env, value.data(), value.size(), &property));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, object, name, property));
}

void SetWideString(addon_env env, addon_value object, const char* name, const std::wstring& value) {
    static_assert(sizeof(wchar_t) == sizeof(char16_t));
    addon_value property = nullptr;
    Check(UxpAddonApis.uxp_addon_create_string_utf16(
        env,
        reinterpret_cast<const char16_t*>(value.data()),
        value.size(),
        &property));
    Check(UxpAddonApis.uxp_addon_set_named_property(env, object, name, property));
}

addon_value CreateWideString(addon_env env, const std::wstring& value) {
    static_assert(sizeof(wchar_t) == sizeof(char16_t));
    addon_value output = nullptr;
    Check(UxpAddonApis.uxp_addon_create_string_utf16(
        env,
        reinterpret_cast<const char16_t*>(value.data()),
        value.size(),
        &output));
    return output;
}

addon_value ConvertPackagedFontStatus(
    addon_env env,
    const oracle::font_registration::PackagedFontStatus& nativeStatus) {
    addon_value result = nullptr;
    Check(UxpAddonApis.uxp_addon_create_object(env, &result));
    SetBoolean(env, result, "ok", nativeStatus.ok);
    SetBoolean(env, result, "attempted", nativeStatus.attempted);
    SetBoolean(env, result, "processPrivate", nativeStatus.processPrivate);
    SetBoolean(env, result, "sessionVisible", nativeStatus.sessionVisible);
    SetBoolean(env, result, "alreadyRegistered", nativeStatus.alreadyRegistered);
    SetBoolean(env, result, "cleanupPending", nativeStatus.cleanupPending);
    SetNumber(env, result, "totalFileCount", static_cast<double>(nativeStatus.totalFileCount));
    SetNumber(
        env,
        result,
        "registeredFileCount",
        static_cast<double>(nativeStatus.registeredFileCount));
    SetNumber(
        env,
        result,
        "registeredFaceCount",
        static_cast<double>(nativeStatus.registeredFaceCount));
    SetString(env, result, "state", nativeStatus.state);
    SetString(env, result, "registrationFlags", nativeStatus.registrationFlags);
    SetString(env, result, "errorCode", nativeStatus.errorCode);
    SetString(env, result, "errorMessage", nativeStatus.errorMessage);

    addon_value items = nullptr;
    Check(UxpAddonApis.uxp_addon_create_array_with_length(
        env, nativeStatus.items.size(), &items));
    for (std::uint32_t index = 0; index < nativeStatus.items.size(); ++index) {
        const auto& nativeItem = nativeStatus.items[index];
        addon_value item = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &item));
        SetString(env, item, "id", nativeItem.id);
        SetString(env, item, "familyName", nativeItem.familyName);
        SetString(env, item, "fileName", nativeItem.fileName);
        SetBoolean(env, item, "registered", nativeItem.registered);
        SetNumber(env, item, "faceCount", static_cast<double>(nativeItem.faceCount));
        SetNumber(env, item, "win32Error", static_cast<double>(nativeItem.win32Error));
        SetString(env, item, "errorCode", nativeItem.errorCode);
        SetString(env, item, "errorMessage", nativeItem.errorMessage);
        Check(UxpAddonApis.uxp_addon_set_element(env, items, index, item));
    }
    Check(UxpAddonApis.uxp_addon_set_named_property(env, result, "items", items));
    return result;
}

void RequireNoArguments(addon_env env, addon_callback_info info, const char* functionName) {
    addon_value unexpectedArgument = nullptr;
    size_t argumentCount = 1;
    Check(UxpAddonApis.uxp_addon_get_cb_info(
        env, info, &argumentCount, &unexpectedArgument, nullptr, nullptr));
    if (argumentCount != 0) {
        throw std::invalid_argument(std::string(functionName) + " does not accept arguments");
    }
}

addon_value RegisterPackagedFonts(addon_env env, addon_callback_info info) {
    try {
        RequireNoArguments(env, info, "registerPackagedFonts");
        if (!gPackagedFonts) {
            throw std::runtime_error("Packaged font registration service is unavailable");
        }
        return ConvertPackagedFontStatus(env, gPackagedFonts->RegisterPackagedFonts());
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value GetPackagedFontStatus(addon_env env, addon_callback_info info) {
    try {
        RequireNoArguments(env, info, "getPackagedFontStatus");
        if (!gPackagedFonts) {
            throw std::runtime_error("Packaged font registration service is unavailable");
        }
        return ConvertPackagedFontStatus(env, gPackagedFonts->GetStatus());
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value UnregisterPackagedFonts(addon_env env, addon_callback_info info) {
    try {
        RequireNoArguments(env, info, "unregisterPackagedFonts");
        if (!gPackagedFonts) {
            throw std::runtime_error("Packaged font registration service is unavailable");
        }
        gPackagedFonts->Shutdown();
        return ConvertPackagedFontStatus(env, gPackagedFonts->GetStatus());
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value ConvertResult(addon_env env, const NativeDragResult& nativeResult) {
    addon_value result = nullptr;
    Check(UxpAddonApis.uxp_addon_create_object(env, &result));
    SetNumber(env, result, "requestId", static_cast<double>(nativeResult.requestId));
    SetBoolean(env, result, "ok", nativeResult.ok);
    SetBoolean(env, result, "dropped", nativeResult.dropped);
    SetBoolean(env, result, "cancelled", nativeResult.cancelled);
    SetNumber(env, result, "effect", static_cast<double>(nativeResult.effect));
    SetNumber(env, result, "hresult", static_cast<double>(static_cast<int32_t>(nativeResult.hresult)));
    SetString(env, result, "errorCode", nativeResult.errorCode);
    SetString(env, result, "errorMessage", nativeResult.errorMessage);
    SetNumber(env, result, "nativeDispatchMs", nativeResult.nativeDispatchMs);
    SetString(env, result, "lastStage", nativeResult.lastStage);
    SetBoolean(env, result, "requestReceived", nativeResult.requestReceived);
    SetBoolean(env, result, "pathValidated", nativeResult.pathValidated);
    SetBoolean(env, result, "leftButtonConfirmed", nativeResult.leftButtonConfirmed);
    SetBoolean(env, result, "workerDispatched", nativeResult.workerDispatched);
    SetBoolean(env, result, "doDragDropEntered", nativeResult.doDragDropEntered);
    SetBoolean(env, result, "doDragDropReturned", nativeResult.doDragDropReturned);
    return result;
}

addon_value ConvertSnapshot(addon_env env, const NativeDragSnapshot& snapshot) {
    addon_value result = nullptr;
    Check(UxpAddonApis.uxp_addon_create_object(env, &result));
    SetNumber(env, result, "requestId", static_cast<double>(snapshot.requestId));
    SetString(env, result, "stage", snapshot.stage);
    SetBoolean(env, result, "requestReceived", snapshot.requestReceived);
    SetBoolean(env, result, "pathValidated", snapshot.pathValidated);
    SetBoolean(env, result, "leftButtonConfirmed", snapshot.leftButtonConfirmed);
    SetBoolean(env, result, "workerQueued", snapshot.workerQueued);
    SetBoolean(env, result, "workerAwakened", snapshot.workerAwakened);
    SetBoolean(env, result, "oleInitialized", snapshot.oleInitialized);
    SetBoolean(env, result, "doDragDropEntered", snapshot.doDragDropEntered);
    SetBoolean(env, result, "doDragDropReturned", snapshot.doDragDropReturned);
    SetNumber(env, result, "queryContinueDragCalls", static_cast<double>(snapshot.queryContinueDragCalls));
    SetNumber(env, result, "giveFeedbackCalls", static_cast<double>(snapshot.giveFeedbackCalls));
    SetNumber(env, result, "lastKeyState", static_cast<double>(snapshot.lastKeyState));
    SetBoolean(env, result, "escapeObserved", snapshot.escapeObserved);
    SetNumber(env, result, "currentEffect", static_cast<double>(snapshot.currentEffect));
    SetNumber(env, result, "finalEffect", static_cast<double>(snapshot.finalEffect));
    SetNumber(env, result, "hresult", static_cast<double>(static_cast<std::int32_t>(snapshot.hresult)));
    SetNumber(env, result, "oleInitializeHresult", static_cast<double>(static_cast<std::int32_t>(snapshot.oleInitializeHresult)));
    SetNumber(env, result, "workerThreadId", static_cast<double>(snapshot.workerThreadId));
    SetNumber(env, result, "callerThreadId", static_cast<double>(snapshot.callerThreadId));
    SetNumber(env, result, "foregroundWindow", static_cast<double>(snapshot.foregroundWindow));
    SetNumber(env, result, "foregroundProcessId", static_cast<double>(snapshot.foregroundWindowProcessId));
    SetNumber(env, result, "foregroundWindowThreadId", static_cast<double>(snapshot.foregroundWindowThreadId));
    SetNumber(env, result, "cursorX", static_cast<double>(snapshot.cursorX));
    SetNumber(env, result, "cursorY", static_cast<double>(snapshot.cursorY));
    SetBoolean(env, result, "promiseCreated", snapshot.promiseCreated);
    SetBoolean(env, result, "promiseResolved", snapshot.promiseResolved);
    SetBoolean(env, result, "promiseRejected", snapshot.promiseRejected);
    SetBoolean(
        env,
        result,
        "shutdownCancellationRequested",
        snapshot.shutdownCancellationRequested);
    SetBoolean(env, result, "workerExited", snapshot.workerExited);
    SetBoolean(env, result, "oleCleanupCompleted", snapshot.oleCleanupCompleted);
    SetBoolean(env, result, "cancellationHookInstalled", snapshot.cancellationHookInstalled);
    SetBoolean(env, result, "forcedTermination", snapshot.forcedTermination);
    SetString(env, result, "shutdownErrorCode", snapshot.shutdownErrorCode);
    SetNumber(env, result, "elapsedMs", snapshot.elapsedMs);
    return result;
}

std::wstring GetRequiredPath(addon_env env, addon_callback_info info) {
    addon_value argument = nullptr;
    size_t argumentCount = 1;
    Check(UxpAddonApis.uxp_addon_get_cb_info(env, info, &argumentCount, &argument, nullptr, nullptr));
    if (argumentCount != 1 || !argument) {
        throw std::invalid_argument("startNativeFileDrag requires one absolute path string");
    }
    addon_valuetype valueType = addon_undefined;
    Check(UxpAddonApis.uxp_addon_typeof(env, argument, &valueType));
    if (valueType != addon_string) {
        throw std::invalid_argument("startNativeFileDrag requires a string path");
    }

    size_t length = 0;
    Check(UxpAddonApis.uxp_addon_get_value_string_utf16(env, argument, nullptr, 0, &length));
    std::vector<char16_t> buffer(length + 1, u'\0');
    size_t actualLength = 0;
    Check(UxpAddonApis.uxp_addon_get_value_string_utf16(
        env, argument, buffer.data(), buffer.size(), &actualLength));
    static_assert(sizeof(wchar_t) == sizeof(char16_t));
    return std::wstring(reinterpret_cast<const wchar_t*>(buffer.data()), actualLength);
}

std::string GetUtf8String(addon_env env, addon_value value, const char* label) {
    addon_valuetype valueType = addon_undefined;
    Check(UxpAddonApis.uxp_addon_typeof(env, value, &valueType));
    if (valueType != addon_string) throw std::invalid_argument(std::string(label) + " requires a string");
    size_t length = 0;
    Check(UxpAddonApis.uxp_addon_get_value_string_utf8(env, value, nullptr, 0, &length));
    std::vector<char> buffer(length + 1, '\0');
    size_t actualLength = 0;
    Check(UxpAddonApis.uxp_addon_get_value_string_utf8(
        env, value, buffer.data(), buffer.size(), &actualLength));
    return std::string(buffer.data(), actualLength);
}

std::wstring Utf8PathToWide(const std::string& value) {
    if (value.empty()) return {};
    const int length = MultiByteToWideChar(
        CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()), nullptr, 0);
    if (length <= 0) throw std::invalid_argument("The native path is not valid UTF-8");
    std::wstring wide(static_cast<std::size_t>(length), L'\0');
    if (MultiByteToWideChar(
            CP_UTF8, MB_ERR_INVALID_CHARS, value.data(), static_cast<int>(value.size()),
            wide.data(), length) != length) {
        throw std::invalid_argument("Native path conversion failed");
    }
    return wide;
}

std::string GetNamedString(
    addon_env env,
    addon_value object,
    const char* name,
    bool optional = false) {
    bool hasProperty = false;
    Check(UxpAddonApis.uxp_addon_has_named_property(env, object, name, &hasProperty));
    if (!hasProperty) {
        if (optional) return {};
        throw std::invalid_argument(std::string("Missing required property: ") + name);
    }
    addon_value property = nullptr;
    Check(UxpAddonApis.uxp_addon_get_named_property(env, object, name, &property));
    return GetUtf8String(env, property, name);
}

bool GetNamedBoolean(addon_env env, addon_value object, const char* name, bool fallback) {
    bool hasProperty = false;
    Check(UxpAddonApis.uxp_addon_has_named_property(env, object, name, &hasProperty));
    if (!hasProperty) return fallback;
    addon_value property = nullptr;
    Check(UxpAddonApis.uxp_addon_get_named_property(env, object, name, &property));
    addon_valuetype valueType = addon_undefined;
    Check(UxpAddonApis.uxp_addon_typeof(env, property, &valueType));
    if (valueType != addon_boolean) {
        throw std::invalid_argument(std::string(name) + " requires a boolean");
    }
    bool value = false;
    Check(UxpAddonApis.uxp_addon_get_value_bool(env, property, &value));
    return value;
}

double GetNamedNumber(addon_env env, addon_value object, const char* name, double fallback) {
    bool hasProperty = false;
    Check(UxpAddonApis.uxp_addon_has_named_property(env, object, name, &hasProperty));
    if (!hasProperty) return fallback;
    addon_value property = nullptr;
    Check(UxpAddonApis.uxp_addon_get_named_property(env, object, name, &property));
    addon_valuetype valueType = addon_undefined;
    Check(UxpAddonApis.uxp_addon_typeof(env, property, &valueType));
    if (valueType != addon_number) {
        throw std::invalid_argument(std::string(name) + " requires a number");
    }
    double value = fallback;
    Check(UxpAddonApis.uxp_addon_get_value_double(env, property, &value));
    if (!std::isfinite(value)) throw std::invalid_argument(std::string(name) + " must be finite");
    return value;
}

std::vector<std::string> GetStringArray(
    addon_env env,
    addon_value value,
    const char* label,
    std::size_t maximumLength) {
    bool isArray = false;
    Check(UxpAddonApis.uxp_addon_is_array(env, value, &isArray));
    if (!isArray) throw std::invalid_argument(std::string(label) + " requires an array");
    std::uint32_t length = 0;
    Check(UxpAddonApis.uxp_addon_get_array_length(env, value, &length));
    if (length == 0 || length > maximumLength) {
        throw std::invalid_argument(
            std::string(label) + " must contain between 1 and " +
            std::to_string(maximumLength) + " entries");
    }
    std::vector<std::string> output;
    output.reserve(length);
    for (std::uint32_t index = 0; index < length; ++index) {
        addon_value item = nullptr;
        Check(UxpAddonApis.uxp_addon_get_element(env, value, index, &item));
        output.push_back(GetUtf8String(env, item, label));
    }
    return output;
}

addon_value WriteAtomicStateFile(addon_env env, addon_callback_info info) {
    try {
        std::array<addon_value, 4> arguments{};
        size_t argumentCount = arguments.size();
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, arguments.data(), nullptr, nullptr));
        if (argumentCount != arguments.size()) {
            throw std::invalid_argument(
                "writeAtomicStateFile requires primary, temporary, backup, and UTF-8 text strings");
        }
        const std::wstring primary = Utf8PathToWide(GetUtf8String(env, arguments[0], "primary path"));
        const std::wstring temporary = Utf8PathToWide(GetUtf8String(env, arguments[1], "temporary path"));
        const std::wstring backup = Utf8PathToWide(GetUtf8String(env, arguments[2], "backup path"));
        const std::string text = GetUtf8String(env, arguments[3], "state text");
        const auto nativeResult = oracle::atomic_file::WriteOracleStateAtomically(
            primary, temporary, backup, text);
        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        SetBoolean(env, result, "ok", nativeResult.ok);
        SetBoolean(env, result, "backupCreated", nativeResult.backupCreated);
        SetNumber(env, result, "bytesWritten", static_cast<double>(nativeResult.bytesWritten));
        SetNumber(env, result, "win32Error", static_cast<double>(nativeResult.win32Error));
        SetString(env, result, "errorCode", nativeResult.errorCode);
        SetString(env, result, "errorMessage", nativeResult.errorMessage);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value ConvertRegistrationResult(
    addon_env env,
    const oracle::file_operation::RegistrationResult& nativeResult,
    bool watcherTracked) {
    addon_value result = nullptr;
    Check(UxpAddonApis.uxp_addon_create_object(env, &result));
    SetBoolean(env, result, "ok", nativeResult.ok);
    SetString(env, result, "recordId", nativeResult.recordId);
    SetWideString(env, result, "path", nativeResult.normalizedPath);
    SetString(env, result, "identityKey", nativeResult.identityKey);
    SetBoolean(env, result, "watcherTracked", watcherTracked);
    SetNumber(env, result, "win32Error", static_cast<double>(nativeResult.win32Error));
    SetString(env, result, "errorCode", nativeResult.errorCode);
    SetString(env, result, "errorMessage", nativeResult.errorMessage);
    return result;
}

addon_value InspectReplayFileIdentity(addon_env env, addon_callback_info info) {
    try {
        const std::wstring path = GetRequiredPath(env, info);
        const auto inspection = oracle::file_identity::InspectSafeRegularFile(path);
        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        SetBoolean(env, result, "ok", inspection.ok);
        SetWideString(env, result, "path", inspection.normalizedPath);
        SetString(env, result, "identityKey", inspection.ok ? inspection.identity.ToKey() : std::string{});
        SetNumber(env, result, "win32Error", static_cast<double>(inspection.win32Error));
        SetString(env, result, "errorCode", inspection.errorCode);
        SetString(env, result, "errorMessage", inspection.errorMessage);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value RegisterKnownReplayFile(addon_env env, addon_callback_info info) {
    try {
        std::array<addon_value, 3> arguments{};
        size_t argumentCount = arguments.size();
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, arguments.data(), nullptr, nullptr));
        if (argumentCount < 2 || argumentCount > 3) {
            throw std::invalid_argument(
                "registerKnownReplayFile requires recordId, absolutePath, and optional identityKey");
        }
        if (!gFileOperations || !gDirectoryWatcher) {
            throw std::runtime_error("Native file lifecycle services are unavailable");
        }
        const std::string recordId = GetUtf8String(env, arguments[0], "recordId");
        const std::wstring path = Utf8PathToWide(GetUtf8String(env, arguments[1], "absolutePath"));
        const std::string identityKey = argumentCount == 3
            ? GetUtf8String(env, arguments[2], "identityKey")
            : std::string{};
        const auto previousRegistration = gFileOperations->InspectKnownFile(recordId);
        auto registration = gFileOperations->RegisterKnownFile(recordId, path, identityKey);
        bool watcherTracked = false;
        if (registration.ok) {
            const auto watcherResult = gDirectoryWatcher->TrackKnownFile(
                recordId, registration.normalizedPath, registration.identityKey);
            watcherTracked = watcherResult.ok;
            if (!watcherTracked) {
                if (previousRegistration.ok) {
                    gFileOperations->RegisterKnownFile(
                        recordId,
                        previousRegistration.normalizedPath,
                        previousRegistration.identityKey);
                } else {
                    gFileOperations->UnregisterKnownFile(recordId);
                }
                registration.ok = false;
                registration.win32Error = watcherResult.win32Error;
                registration.errorCode = watcherResult.errorCode;
                registration.errorMessage = watcherResult.errorMessage;
            }
        }
        return ConvertRegistrationResult(env, registration, watcherTracked);
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value UnregisterKnownReplayFile(addon_env env, addon_callback_info info) {
    try {
        addon_value argument = nullptr;
        size_t argumentCount = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, &argument, nullptr, nullptr));
        if (argumentCount != 1) {
            throw std::invalid_argument("unregisterKnownReplayFile requires one recordId");
        }
        const std::string recordId = GetUtf8String(env, argument, "recordId");
        const bool fileRemoved = gFileOperations && gFileOperations->UnregisterKnownFile(recordId);
        const bool watchRemoved = gDirectoryWatcher && gDirectoryWatcher->UntrackKnownFile(recordId);
        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        SetBoolean(env, result, "ok", fileRemoved || watchRemoved);
        SetBoolean(env, result, "fileOperationRegistrationRemoved", fileRemoved);
        SetBoolean(env, result, "watchRegistrationRemoved", watchRemoved);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value RevealFileInExplorer(addon_env env, addon_callback_info info) {
    try {
        addon_value argument = nullptr;
        size_t argumentCount = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, &argument, nullptr, nullptr));
        if (argumentCount != 1) {
            throw std::invalid_argument("revealFileInExplorer requires one known recordId");
        }
        if (!gFileOperations) throw std::runtime_error("Native file operation service is unavailable");
        const auto nativeResult = gFileOperations->RevealKnownFileInExplorer(
            GetUtf8String(env, argument, "recordId"));
        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        SetBoolean(env, result, "ok", nativeResult.ok);
        SetString(env, result, "recordId", nativeResult.recordId);
        SetWideString(env, result, "path", nativeResult.path);
        SetNumber(env, result, "hresult", static_cast<double>(nativeResult.hresult));
        SetNumber(env, result, "win32Error", static_cast<double>(nativeResult.win32Error));
        SetString(env, result, "errorCode", nativeResult.errorCode);
        SetString(env, result, "errorMessage", nativeResult.errorMessage);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value RenameKnownReplayFile(addon_env env, addon_callback_info info) {
    try {
        std::array<addon_value, 2> arguments{};
        size_t argumentCount = arguments.size();
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, arguments.data(), nullptr, nullptr));
        if (argumentCount != 2) {
            throw std::invalid_argument(
                "renameKnownReplayFile requires recordId and an absolute target path");
        }
        if (!gFileOperations || !gDirectoryWatcher) {
            throw std::runtime_error("Native file lifecycle services are unavailable");
        }
        const std::string recordId = GetUtf8String(env, arguments[0], "recordId");
        const std::wstring targetPath = Utf8PathToWide(
            GetUtf8String(env, arguments[1], "targetPath"));

        // ReadDirectoryChangesW handles are explicitly closed before the
        // filesystem mutation, then the exact bounded roots are restored.
        ScopedDirectoryWatchPause watcherPause(gDirectoryWatcher.get());
        const bool watcherWasRunning = watcherPause.WasRunning();

        auto nativeResult = gFileOperations->RenameKnownFile(recordId, targetPath);
        bool watcherTracked = false;
        if (nativeResult.ok) {
            gDirectoryWatcher->UntrackKnownFile(recordId);
            const auto trackResult = gDirectoryWatcher->TrackKnownFile(
                recordId, nativeResult.newPath, nativeResult.identityKey);
            watcherTracked = trackResult.ok;
            if (!watcherTracked) {
                const auto rollback = gFileOperations->RenameKnownFile(
                    recordId, nativeResult.oldPath);
                nativeResult.ok = false;
                nativeResult.rollbackAttempted = true;
                nativeResult.rollbackSucceeded = rollback.ok;
                nativeResult.win32Error = trackResult.win32Error;
                nativeResult.errorCode = "WATCHER_RECONCILIATION_FAILED";
                nativeResult.errorMessage = rollback.ok
                    ? "Watcher reconciliation failed; the original source path was restored."
                    : "Watcher reconciliation failed and the source rename could not be rolled back.";
                if (rollback.ok) {
                    gDirectoryWatcher->TrackKnownFile(
                        recordId, rollback.newPath, rollback.identityKey);
                    nativeResult.identityKey = rollback.identityKey;
                }
            }
        }
        oracle::directory_watch::WatchStartResult restartResult;
        bool watcherRestarted = !watcherWasRunning;
        if (watcherWasRunning) {
            restartResult = watcherPause.Restart();
            watcherRestarted = restartResult.ok;
            if (!watcherRestarted && nativeResult.ok) {
                gDirectoryWatcher->UntrackKnownFile(recordId);
                const auto rollback = gFileOperations->RenameKnownFile(
                    recordId, nativeResult.oldPath);
                nativeResult.ok = false;
                nativeResult.rollbackAttempted = true;
                nativeResult.rollbackSucceeded = rollback.ok;
                nativeResult.errorCode = "WATCHER_RESTART_FAILED";
                nativeResult.errorMessage = rollback.ok
                    ? "The watcher could not restart; the original source path was restored."
                    : "The watcher could not restart and the source rename rollback failed.";
                if (rollback.ok) {
                    gDirectoryWatcher->TrackKnownFile(
                        recordId, rollback.newPath, rollback.identityKey);
                    const auto retry = gDirectoryWatcher->Start(watcherPause.Roots());
                    watcherRestarted = retry.ok;
                }
            }
        }

        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        SetBoolean(env, result, "ok", nativeResult.ok && watcherRestarted);
        SetString(env, result, "recordId", nativeResult.recordId);
        SetWideString(env, result, "oldPath", nativeResult.oldPath);
        SetWideString(env, result, "newPath", nativeResult.newPath);
        SetString(env, result, "identityKey", nativeResult.identityKey);
        SetBoolean(env, result, "watcherWasRunning", watcherWasRunning);
        SetBoolean(env, result, "watcherTracked", watcherTracked);
        SetBoolean(env, result, "watcherRestarted", watcherRestarted);
        SetBoolean(env, result, "watchHandlesReleasedBeforeMutation", true);
        SetBoolean(env, result, "rollbackAttempted", nativeResult.rollbackAttempted);
        SetBoolean(env, result, "rollbackSucceeded", nativeResult.rollbackSucceeded);
        SetNumber(env, result, "win32Error", static_cast<double>(nativeResult.win32Error));
        SetString(
            env,
            result,
            "errorCode",
            !watcherRestarted && nativeResult.errorCode.empty()
                ? restartResult.errorCode
                : nativeResult.errorCode);
        SetString(
            env,
            result,
            "errorMessage",
            !watcherRestarted && nativeResult.errorMessage.empty()
                ? restartResult.errorMessage
                : nativeResult.errorMessage);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value StartDirectoryWatch(addon_env env, addon_callback_info info) {
    try {
        addon_value argument = nullptr;
        size_t argumentCount = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, &argument, nullptr, nullptr));
        if (argumentCount != 1) {
            throw std::invalid_argument("startDirectoryWatch requires one bounded roots array");
        }
        bool isArray = false;
        Check(UxpAddonApis.uxp_addon_is_array(env, argument, &isArray));
        if (!isArray) throw std::invalid_argument("startDirectoryWatch requires a roots array");
        std::uint32_t length = 0;
        Check(UxpAddonApis.uxp_addon_get_array_length(env, argument, &length));
        if (length == 0 || length > oracle::directory_watch::DirectoryWatchService::kMaximumRoots) {
            throw std::invalid_argument("startDirectoryWatch accepts between 1 and 16 explicit roots");
        }
        std::vector<oracle::directory_watch::WatchRootConfig> roots;
        roots.reserve(length);
        for (std::uint32_t index = 0; index < length; ++index) {
            addon_value entry = nullptr;
            Check(UxpAddonApis.uxp_addon_get_element(env, argument, index, &entry));
            addon_valuetype valueType = addon_undefined;
            Check(UxpAddonApis.uxp_addon_typeof(env, entry, &valueType));
            if (valueType != addon_object) {
                throw std::invalid_argument("Each watch root must be an object");
            }
            roots.push_back({
                GetNamedString(env, entry, "id"),
                Utf8PathToWide(GetNamedString(env, entry, "path")),
                GetNamedBoolean(env, entry, "recursive", true),
            });
        }
        if (!gDirectoryWatcher) throw std::runtime_error("Native directory watcher is unavailable");
        const auto nativeResult = gDirectoryWatcher->Start(std::move(roots));
        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        SetBoolean(env, result, "ok", nativeResult.ok);
        SetNumber(env, result, "rootCount", static_cast<double>(nativeResult.rootCount));
        SetNumber(env, result, "win32Error", static_cast<double>(nativeResult.win32Error));
        SetString(env, result, "errorCode", nativeResult.errorCode);
        SetString(env, result, "errorMessage", nativeResult.errorMessage);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value StopDirectoryWatch(addon_env env, addon_callback_info) {
    try {
        if (gDirectoryWatcher) gDirectoryWatcher->Stop();
        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        SetBoolean(env, result, "ok", true);
        SetBoolean(env, result, "running", false);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value PollDirectoryWatchEvents(addon_env env, addon_callback_info info) {
    try {
        std::size_t maximumEvents = 256;
        addon_value argument = nullptr;
        size_t argumentCount = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, &argument, nullptr, nullptr));
        if (argumentCount > 1) {
            throw std::invalid_argument("pollDirectoryWatchEvents accepts one optional maximum count");
        }
        if (argumentCount == 1 && argument) {
            std::uint32_t value = 0;
            Check(UxpAddonApis.uxp_addon_get_value_uint32(env, argument, &value));
            maximumEvents = value;
        }
        const auto events = gDirectoryWatcher
            ? gDirectoryWatcher->DrainEvents(maximumEvents)
            : std::vector<oracle::directory_watch::DirectoryWatchEvent>{};
        addon_value array = nullptr;
        Check(UxpAddonApis.uxp_addon_create_array_with_length(env, events.size(), &array));
        for (std::uint32_t index = 0; index < events.size(); ++index) {
            const auto& event = events[index];
            addon_value item = nullptr;
            Check(UxpAddonApis.uxp_addon_create_object(env, &item));
            SetNumber(env, item, "sequence", static_cast<double>(event.sequence));
            SetString(env, item, "kind", oracle::directory_watch::EventKindName(event.kind));
            SetString(env, item, "rootId", event.rootId);
            SetString(env, item, "recordId", event.recordId);
            SetWideString(env, item, "path", event.path);
            SetWideString(env, item, "oldPath", event.oldPath);
            SetString(env, item, "identityKey", event.identityKey);
            SetBoolean(env, item, "sameVolumeIdentityMatched", event.sameVolumeIdentityMatched);
            SetNumber(
                env,
                item,
                "observedAtMilliseconds",
                static_cast<double>(event.observedAtMilliseconds));
            Check(UxpAddonApis.uxp_addon_set_element(env, array, index, item));
        }
        return array;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value ConvertFileOperationResult(
    addon_env env,
    const oracle::file_operation::FileOperationBatchResult& nativeResult) {
    addon_value result = nullptr;
    Check(UxpAddonApis.uxp_addon_create_object(env, &result));
    SetNumber(env, result, "requestId", static_cast<double>(nativeResult.requestId));
    SetBoolean(env, result, "ok", nativeResult.ok);
    SetBoolean(env, result, "cancelled", nativeResult.cancelled);
    SetBoolean(env, result, "anyOperationsAborted", nativeResult.anyOperationsAborted);
    SetBoolean(
        env,
        result,
        "handlesReleasedBeforeMutation",
        nativeResult.handlesReleasedBeforeMutation);
    SetNumber(env, result, "hresult", static_cast<double>(nativeResult.hresult));

    addon_value items = nullptr;
    Check(UxpAddonApis.uxp_addon_create_array_with_length(
        env, nativeResult.items.size(), &items));
    for (std::uint32_t index = 0; index < nativeResult.items.size(); ++index) {
        const auto& nativeItem = nativeResult.items[index];
        addon_value item = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &item));
        SetString(env, item, "recordId", nativeItem.recordId);
        SetWideString(env, item, "path", nativeItem.path);
        SetBoolean(env, item, "ok", nativeItem.ok);
        SetBoolean(env, item, "cancelled", nativeItem.cancelled);
        SetNumber(env, item, "hresult", static_cast<double>(nativeItem.hresult));
        SetNumber(env, item, "win32Error", static_cast<double>(nativeItem.win32Error));
        SetString(env, item, "errorCode", nativeItem.errorCode);
        SetString(env, item, "errorMessage", nativeItem.errorMessage);
        Check(UxpAddonApis.uxp_addon_set_element(env, items, index, item));
    }
    Check(UxpAddonApis.uxp_addon_set_named_property(env, result, "items", items));
    return result;
}

struct FileOperationDeferredCompletion {
    addon_env env = nullptr;
    addon_deferred deferred = nullptr;
    oracle::file_operation::FileOperationBatchResult result;
};

void DeleteFileOperationDeferredCompletion(addon_task_data data) {
    delete reinterpret_cast<FileOperationDeferredCompletion*>(data);
}

void SettleFileOperationOnScriptingThread(addon_task_data data) {
    auto* completion = reinterpret_cast<FileOperationDeferredCompletion*>(data);
    try {
        HandlerScope scope(completion->env);
        addon_value value = ConvertFileOperationResult(completion->env, completion->result);
        // Partial failure and cancellation are expected structured outcomes,
        // so the promise resolves and JS can render every per-item result.
        Check(UxpAddonApis.uxp_addon_resolve_deferred(
            completion->env, completion->deferred, value));
    } catch (...) {
        // Never allow an exception to cross the host scripting callback.
    }
}

addon_value RecycleKnownFiles(addon_env env, addon_callback_info info) {
    try {
        addon_value argument = nullptr;
        size_t argumentCount = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, &argument, nullptr, nullptr));
        if (argumentCount != 1) {
            throw std::invalid_argument("recycleKnownFiles requires one recordId array");
        }
        if (!gFileOperations || !gFileOperations->IsAvailable()) {
            throw std::runtime_error("Native file operation service is unavailable");
        }
        auto recordIds = GetStringArray(env, argument, "recordIds", 256);
        addon_deferred deferred = nullptr;
        addon_value promise = nullptr;
        Check(UxpAddonApis.uxp_addon_create_promise(env, &deferred, &promise));
        const std::uint64_t requestId = gFileOperations->RecycleKnownFilesAsync(
            std::move(recordIds),
            [env, deferred](oracle::file_operation::FileOperationBatchResult result) {
                if (gTerminating.load()) return;
                auto* completion = new (std::nothrow) FileOperationDeferredCompletion{
                    env, deferred, std::move(result)};
                if (!completion) return;
                UxpAddonApis.uxp_addon_schedule_on_javascript_queue(
                    env,
                    SettleFileOperationOnScriptingThread,
                    completion,
                    DeleteFileOperationDeferredCompletion);
            });
        SetNumber(env, promise, "requestId", static_cast<double>(requestId));
        return promise;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value CancelFileOperation(addon_env env, addon_callback_info info) {
    try {
        addon_value argument = nullptr;
        size_t argumentCount = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, &argument, nullptr, nullptr));
        if (argumentCount != 1) {
            throw std::invalid_argument("cancelFileOperation requires one numeric requestId");
        }
        double value = 0.0;
        Check(UxpAddonApis.uxp_addon_get_value_double(env, argument, &value));
        if (!std::isfinite(value) || value < 1.0 || value != std::floor(value) || value > 9007199254740991.0) {
            throw std::invalid_argument("cancelFileOperation requires a positive safe integer requestId");
        }
        const bool cancelled = gFileOperations &&
            gFileOperations->CancelRequest(static_cast<std::uint64_t>(value));
        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        SetBoolean(env, result, "ok", cancelled);
        SetBoolean(env, result, "cancellationRequested", cancelled);
        SetNumber(env, result, "requestId", value);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value ConvertReplayMediaResult(
    addon_env env,
    const oracle::replay_media::ReplayMediaResult& nativeResult) {
    addon_value result = nullptr;
    Check(UxpAddonApis.uxp_addon_create_object(env, &result));
    SetNumber(env, result, "requestId", static_cast<double>(nativeResult.requestId));
    SetBoolean(env, result, "ok", nativeResult.ok);
    SetBoolean(env, result, "cancelled", nativeResult.cancelled);
    SetBoolean(env, result, "thumbnailReady", nativeResult.thumbnailReady);
    SetBoolean(env, result, "previewReady", nativeResult.previewReady);
    SetBoolean(env, result, "thumbnailReused", nativeResult.thumbnailReused);
    SetBoolean(env, result, "previewReused", nativeResult.previewReused);
    SetBoolean(env, result, "hasAudio", nativeResult.hasAudio);
    SetWideString(env, result, "thumbnailPath", nativeResult.thumbnailPath);
    SetWideString(env, result, "previewPath", nativeResult.previewPath);
    SetString(env, result, "previewMimeType", "video/mp4");
    SetString(env, result, "previewVideoCodec", "h264");
    SetString(env, result, "previewAudioCodec", nativeResult.hasAudio ? "aac" : "");
    SetString(env, result, "cacheKey", nativeResult.cacheKey);
    SetString(env, result, "sourceContainer", nativeResult.sourceContainer);
    SetString(env, result, "sourceVideoCodec", nativeResult.sourceVideoCodec);
    SetString(env, result, "sourceVideoProfile", nativeResult.sourceVideoProfile);
    SetString(env, result, "sourceAudioCodec", nativeResult.sourceAudioCodec);
    SetNumber(env, result, "sourceWidth", static_cast<double>(nativeResult.sourceWidth));
    SetNumber(env, result, "sourceHeight", static_cast<double>(nativeResult.sourceHeight));
    SetNumber(env, result, "durationSeconds", nativeResult.durationSeconds);
    SetNumber(env, result, "fps", nativeResult.fps);
    SetNumber(env, result, "thumbnailBytes", static_cast<double>(nativeResult.thumbnailBytes));
    SetNumber(env, result, "previewBytes", static_cast<double>(nativeResult.previewBytes));
    SetNumber(env, result, "win32Error", static_cast<double>(nativeResult.win32Error));
    SetNumber(env, result, "exitCode", static_cast<double>(nativeResult.exitCode));
    SetNumber(env, result, "elapsedMs", nativeResult.elapsedMs);
    SetString(env, result, "errorCode", nativeResult.errorCode);
    SetString(env, result, "errorMessage", nativeResult.errorMessage);
    return result;
}

struct ReplayMediaDeferredCompletion {
    addon_env env = nullptr;
    addon_deferred deferred = nullptr;
    oracle::replay_media::ReplayMediaResult result;
};

void DeleteReplayMediaDeferredCompletion(addon_task_data data) {
    delete reinterpret_cast<ReplayMediaDeferredCompletion*>(data);
}

void SettleReplayMediaOnScriptingThread(addon_task_data data) {
    auto* completion = reinterpret_cast<ReplayMediaDeferredCompletion*>(data);
    if (gTerminating.load(std::memory_order_acquire)) return;
    try {
        HandlerScope scope(completion->env);
        addon_value value = ConvertReplayMediaResult(completion->env, completion->result);
        Check(UxpAddonApis.uxp_addon_resolve_deferred(
            completion->env, completion->deferred, value));
    } catch (...) {
        // The host owns the deferred on this scripting callback; never escape.
    }
}

addon_value PrepareReplayMedia(addon_env env, addon_callback_info info) {
    try {
        addon_value requestValue = nullptr;
        size_t argumentCount = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, &requestValue, nullptr, nullptr));
        if (argumentCount != 1 || !requestValue) {
            throw std::invalid_argument("prepareReplayMedia requires one request object");
        }
        addon_valuetype valueType = addon_undefined;
        Check(UxpAddonApis.uxp_addon_typeof(env, requestValue, &valueType));
        if (valueType != addon_object) {
            throw std::invalid_argument("prepareReplayMedia requires one request object");
        }
        if (!gReplayMedia || !gReplayMedia->IsAvailable()) {
            throw std::runtime_error("Packaged replay media preparation is unavailable");
        }
        oracle::replay_media::ReplayMediaRequest request;
        request.sourcePath = Utf8PathToWide(GetNamedString(env, requestValue, "sourcePath"));
        request.cacheDirectory = Utf8PathToWide(GetNamedString(env, requestValue, "cacheDirectory"));
        request.cacheKey = GetNamedString(env, requestValue, "cacheKey");
        request.includePreview = GetNamedBoolean(env, requestValue, "includePreview", false);
        request.thumbnailPositionSeconds = GetNamedNumber(
            env, requestValue, "thumbnailPositionSeconds", 0.0);
        const double cacheLimitMb = GetNamedNumber(env, requestValue, "cacheLimitMb", 1024.0);
        if (cacheLimitMb < 128.0 || cacheLimitMb > 4096.0 || cacheLimitMb != std::floor(cacheLimitMb)) {
            throw std::invalid_argument("cacheLimitMb must be an integer from 128 through 4096");
        }
        request.cacheLimitMb = static_cast<std::uint32_t>(cacheLimitMb);

        addon_deferred deferred = nullptr;
        addon_value promise = nullptr;
        Check(UxpAddonApis.uxp_addon_create_promise(env, &deferred, &promise));
        const std::uint64_t requestId = gReplayMedia->PrepareAsync(
            std::move(request),
            [env, deferred](oracle::replay_media::ReplayMediaResult result) {
                if (gTerminating.load(std::memory_order_acquire)) return;
                auto* completion = new (std::nothrow) ReplayMediaDeferredCompletion{
                    env, deferred, std::move(result)};
                if (!completion) return;
                UxpAddonApis.uxp_addon_schedule_on_javascript_queue(
                    env,
                    SettleReplayMediaOnScriptingThread,
                    completion,
                    DeleteReplayMediaDeferredCompletion);
            });
        SetNumber(env, promise, "requestId", static_cast<double>(requestId));
        return promise;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value CancelReplayMedia(addon_env env, addon_callback_info info) {
    try {
        addon_value argument = nullptr;
        size_t argumentCount = 1;
        Check(UxpAddonApis.uxp_addon_get_cb_info(
            env, info, &argumentCount, &argument, nullptr, nullptr));
        if (argumentCount != 1) {
            throw std::invalid_argument("cancelReplayMedia requires one numeric requestId");
        }
        double value = 0.0;
        Check(UxpAddonApis.uxp_addon_get_value_double(env, argument, &value));
        if (!std::isfinite(value) || value < 1.0 || value != std::floor(value) ||
            value > 9007199254740991.0) {
            throw std::invalid_argument("cancelReplayMedia requires a positive safe integer requestId");
        }
        const bool cancelled = gReplayMedia &&
            gReplayMedia->CancelRequest(static_cast<std::uint64_t>(value));
        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        SetBoolean(env, result, "ok", cancelled);
        SetBoolean(env, result, "cancellationRequested", cancelled);
        SetNumber(env, result, "requestId", value);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

struct DeferredCompletion {
    addon_env env = nullptr;
    addon_deferred deferred = nullptr;
    NativeDragResult result;
    std::weak_ptr<NativeDragWorker> worker;
};

void DeleteDeferredCompletion(addon_task_data data) {
    delete reinterpret_cast<DeferredCompletion*>(data);
}

void SettleDeferredOnScriptingThread(addon_task_data data) {
    auto* completion = reinterpret_cast<DeferredCompletion*>(data);
    if (gTerminating.load(std::memory_order_acquire)) return;
    try {
        HandlerScope scope(completion->env);
        const bool resolve = completion->result.ok;
        addon_value value = ConvertResult(completion->env, completion->result);
        if (auto worker = completion->worker.lock()) {
            worker->MarkPromiseSettled(completion->result.requestId, resolve);
        }
        if (resolve) {
            Check(UxpAddonApis.uxp_addon_resolve_deferred(
                completion->env, completion->deferred, value));
        } else {
            Check(UxpAddonApis.uxp_addon_reject_deferred(
                completion->env, completion->deferred, value));
        }
    } catch (...) {
        // This callback is already on the only thread authorized to touch the
        // deferred. Never let an exception escape into the host.
    }
}

addon_value StartNativeFileDrag(addon_env env, addon_callback_info info) {
    try {
        const std::wstring path = GetRequiredPath(env, info);
        addon_deferred deferred = nullptr;
        addon_value promise = nullptr;
        Check(UxpAddonApis.uxp_addon_create_promise(env, &deferred, &promise));

        if (gTerminating.load(std::memory_order_acquire) || !gWorker) {
            NativeDragResult result;
            result.errorCode = "ADDON_SHUTTING_DOWN";
            result.errorMessage = "The native drag worker is unavailable.";
            result.hresult = E_ABORT;
            addon_value value = ConvertResult(env, result);
            Check(UxpAddonApis.uxp_addon_reject_deferred(env, deferred, value));
            return promise;
        }

        std::weak_ptr<NativeDragWorker> weakWorker(gWorker);
        gWorker->StartNativeFileDragAsync(
            path,
            GetCurrentThreadId(),
            [env, deferred, weakWorker](NativeDragResult result) {
                if (gTerminating.load(std::memory_order_acquire)) return;
                auto* completion = new (std::nothrow) DeferredCompletion{
                    env, deferred, std::move(result), weakWorker};
                if (!completion) {
                    return;
                }
                if (gTerminating.load(std::memory_order_acquire)) {
                    delete completion;
                    return;
                }
                UxpAddonApis.uxp_addon_schedule_on_javascript_queue(
                    env,
                    SettleDeferredOnScriptingThread,
                    completion,
                    DeleteDeferredCompletion);
            });
        return promise;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value GetNativeDragSnapshot(addon_env env, addon_callback_info) {
    try {
        return ConvertSnapshot(env, gWorker ? gWorker->GetSnapshot() : NativeDragSnapshot{});
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

addon_value NativeSelfTest(addon_env env, addon_callback_info) {
    try {
        const bool workerAvailable = gWorker && gWorker->IsAvailable();
        const bool shutdownIntegrityOk = !gLastNativeDragStopResult.attempted ||
            (gLastNativeDragStopResult.ok &&
             !gLastNativeDragStopResult.forcedTermination &&
             gLastNativeDragStopResult.oleCleanupCompleted);
        const auto packagedFontStatus = gPackagedFonts
            ? gPackagedFonts->GetStatus()
            : oracle::font_registration::PackagedFontStatus{};
        addon_value result = nullptr;
        Check(UxpAddonApis.uxp_addon_create_object(env, &result));
        const bool replayMediaAvailable = gReplayMedia && gReplayMedia->IsAvailable();
        SetBoolean(env, result, "ok", workerAvailable && shutdownIntegrityOk && replayMediaAvailable);
        SetString(env, result, "addonVersion", kAddonVersion);
        SetString(env, result, "architecture", "x64");
        SetString(env, result, "platform", "win32");
        SetBoolean(env, result, "workerAvailable", workerAvailable);
        SetBoolean(env, result, "atomicStateWriterAvailable", true);
        SetBoolean(env, result, "replayMediaPreparationAvailable", replayMediaAvailable);
        SetBoolean(
            env,
            result,
            "fileOperationServiceAvailable",
            gFileOperations && gFileOperations->IsAvailable());
        SetBoolean(env, result, "directoryWatchServiceAvailable", gDirectoryWatcher != nullptr);
        SetBoolean(
            env,
            result,
            "directoryWatchRunning",
            gDirectoryWatcher && gDirectoryWatcher->IsRunning());
        SetBoolean(env, result, "explorerSelectionAvailable", true);
        SetBoolean(
            env,
            result,
            "packagedFontRegistrationAvailable",
            packagedFontStatus.ok);
        SetBoolean(
            env,
            result,
            "packagedFontsProcessPrivate",
            packagedFontStatus.processPrivate);
        SetBoolean(
            env,
            result,
            "packagedFontsSessionVisible",
            packagedFontStatus.sessionVisible);
        SetString(
            env,
            result,
            "packagedFontRegistrationFlags",
            packagedFontStatus.registrationFlags);
        SetString(env, result, "packagedFontState", packagedFontStatus.state);
        SetNumber(
            env,
            result,
            "packagedFontFileCount",
            static_cast<double>(packagedFontStatus.registeredFileCount));
        SetNumber(
            env,
            result,
            "packagedFontFaceCount",
            static_cast<double>(packagedFontStatus.registeredFaceCount));
        SetBoolean(
            env,
            result,
            "safeSourceRenameAvailable",
            gFileOperations && gFileOperations->IsAvailable());
        SetBoolean(
            env,
            result,
            "recycleBinFileOperationsAvailable",
            gFileOperations && gFileOperations->IsAvailable());
        SetString(
            env,
            result,
            "oleWorkerState",
            gWorker ? gWorker->OleWorkerState()
                    : (gWorkerInitializationError.empty() ? "unavailable" : gWorkerInitializationError));
        SetBoolean(
            env,
            result,
            "lastNativeDragStopAttempted",
            gLastNativeDragStopResult.attempted);
        SetBoolean(env, result, "nativeDragShutdownIntegrityOk", shutdownIntegrityOk);
        SetBoolean(env, result, "lastNativeDragStopOk", gLastNativeDragStopResult.ok);
        SetBoolean(
            env,
            result,
            "lastNativeDragStopForcedTermination",
            gLastNativeDragStopResult.forcedTermination);
        SetBoolean(
            env,
            result,
            "lastNativeDragStopOleCleanupCompleted",
            gLastNativeDragStopResult.oleCleanupCompleted);
        SetString(
            env,
            result,
            "lastNativeDragStopErrorCode",
            gLastNativeDragStopResult.errorCode);
        return result;
    } catch (...) {
        return CreateErrorFromException(env);
    }
}

void RegisterFunction(
    addon_env env,
    addon_value exports,
    const addon_apis& addonApis,
    const char* exportName,
    addon_callback callback) {
    addon_value function = nullptr;
    addon_status status = addonApis.uxp_addon_create_function(
        env,
        nullptr,
        0,
        callback,
        nullptr,
        &function);
    if (status != addon_ok) {
        std::string message = "Unable to wrap native export: ";
        message.append(exportName);
        addonApis.uxp_addon_throw_error(env, nullptr, message.c_str());
        throw std::runtime_error(message);
    }

    status = addonApis.uxp_addon_set_named_property(env, exports, exportName, function);
    if (status != addon_ok) {
        std::string message = "Unable to register native export: ";
        message.append(exportName);
        addonApis.uxp_addon_throw_error(env, nullptr, message.c_str());
        throw std::runtime_error(message);
    }
}

addon_value Init(addon_env env, addon_value exports, const addon_apis& addonApis) {
    // Follow Adobe's Hybrid SDK template exactly: create anonymous native
    // functions, attach them to the supplied exports object, and return that
    // same object. Export registration must not depend on worker startup.
    RegisterFunction(env, exports, addonApis, "startNativeFileDrag", StartNativeFileDrag);
    RegisterFunction(env, exports, addonApis, "nativeSelfTest", NativeSelfTest);
    RegisterFunction(env, exports, addonApis, "getNativeDragSnapshot", GetNativeDragSnapshot);
    RegisterFunction(env, exports, addonApis, "writeAtomicStateFile", WriteAtomicStateFile);
    RegisterFunction(env, exports, addonApis, "inspectReplayFileIdentity", InspectReplayFileIdentity);
    RegisterFunction(env, exports, addonApis, "registerKnownReplayFile", RegisterKnownReplayFile);
    RegisterFunction(env, exports, addonApis, "unregisterKnownReplayFile", UnregisterKnownReplayFile);
    RegisterFunction(env, exports, addonApis, "recycleKnownFiles", RecycleKnownFiles);
    RegisterFunction(env, exports, addonApis, "cancelFileOperation", CancelFileOperation);
    RegisterFunction(env, exports, addonApis, "revealFileInExplorer", RevealFileInExplorer);
    RegisterFunction(env, exports, addonApis, "renameKnownReplayFile", RenameKnownReplayFile);
    RegisterFunction(env, exports, addonApis, "startDirectoryWatch", StartDirectoryWatch);
    RegisterFunction(env, exports, addonApis, "pollDirectoryWatchEvents", PollDirectoryWatchEvents);
    RegisterFunction(env, exports, addonApis, "stopDirectoryWatch", StopDirectoryWatch);
    RegisterFunction(env, exports, addonApis, "registerPackagedFonts", RegisterPackagedFonts);
    RegisterFunction(env, exports, addonApis, "getPackagedFontStatus", GetPackagedFontStatus);
    RegisterFunction(env, exports, addonApis, "unregisterPackagedFonts", UnregisterPackagedFonts);
    RegisterFunction(env, exports, addonApis, "prepareReplayMedia", PrepareReplayMedia);
    RegisterFunction(env, exports, addonApis, "cancelReplayMedia", CancelReplayMedia);

    gTerminating.store(false);
    try {
        gPackagedFonts =
            std::make_unique<oracle::font_registration::PackagedFontRegistrationService>();
        gPackagedFonts->RegisterPackagedFonts();
    } catch (...) {
        gPackagedFonts.reset();
    }
    gWorkerInitializationError.clear();
    try {
        gWorker = std::make_shared<NativeDragWorker>();
    } catch (const std::exception& error) {
        gWorker.reset();
        gWorkerInitializationError = error.what();
    } catch (...) {
        gWorker.reset();
        gWorkerInitializationError = "workerInitializationFailed";
    }
    try {
        gFileOperations = std::make_shared<oracle::file_operation::FileOperationService>();
    } catch (...) {
        gFileOperations.reset();
    }
    try {
        gDirectoryWatcher = std::make_unique<oracle::directory_watch::DirectoryWatchService>();
    } catch (...) {
        gDirectoryWatcher.reset();
    }
    try {
        gReplayMedia = std::make_shared<oracle::replay_media::ReplayMediaService>();
    } catch (...) {
        gReplayMedia.reset();
    }
    return exports;
}

void Terminate(addon_env) {
    gTerminating.store(true);
    if (gReplayMedia) {
        gReplayMedia->Shutdown();
        gReplayMedia.reset();
    }
    if (gPackagedFonts) {
        gPackagedFonts->Shutdown();
        gPackagedFonts.reset();
    }
    if (gDirectoryWatcher) {
        gDirectoryWatcher->Stop();
        gDirectoryWatcher.reset();
    }
    if (gFileOperations) {
        gFileOperations->Stop();
        gFileOperations.reset();
    }
    if (gWorker) {
        gLastNativeDragStopResult = gWorker->Stop();
        gWorker.reset();
    }
}

}  // namespace

UXP_ADDON_INIT(Init)
UXP_ADDON_TERMINATE(Terminate)
