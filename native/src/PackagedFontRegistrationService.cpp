#include "PackagedFontRegistrationService.h"

#include "SafeFileIdentity.h"

#include <Windows.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <memory>
#include <utility>

namespace oracle::font_registration {
namespace {

// FR_PRIVATE is deliberate. The registration is temporary and confined to the
// host process; Blocky Studios never copies into the Windows Fonts directory or writes
// a font registry entry.
constexpr DWORD kPrivateFontFlags = FR_PRIVATE;
constexpr LONGLONG kMinimumFontBytes = 1024;
constexpr LONGLONG kMaximumFontBytes = 16LL * 1024LL * 1024LL;

struct FontDefinition {
    const char* id;
    const char* familyName;
    const wchar_t* fileName;
    const char* publicFileName;
};

constexpr FontDefinition kFontDefinitions[] = {
    {"samsungSharpSansRegular", "Samsung Sharp Sans", L"samsung_sharp_sans_regular.otf", "samsung_sharp_sans_regular.otf"},
    {"samsungSharpSansMedium", "Samsung Sharp Sans", L"samsung_sharp_sans_medium.otf", "samsung_sharp_sans_medium.otf"},
    {"samsungSharpSansBold", "Samsung Sharp Sans", L"samsung_sharp_sans_bold.otf", "samsung_sharp_sans_bold.otf"},
};

struct HandleCloser {
    void operator()(void* value) const noexcept {
        const HANDLE handle = static_cast<HANDLE>(value);
        if (handle && handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    }
};

using UniqueHandle = std::unique_ptr<void, HandleCloser>;

struct FontFileValidation {
    bool ok = false;
    UniqueHandle handle;
    DWORD win32Error = ERROR_SUCCESS;
    std::string errorCode;
    std::string errorMessage;
};

std::wstring GetCurrentModulePath(DWORD* error) {
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&GetCurrentModulePath),
            &module)) {
        if (error) *error = GetLastError();
        return {};
    }

    std::wstring buffer(512, L'\0');
    for (;;) {
        SetLastError(ERROR_SUCCESS);
        const DWORD written = GetModuleFileNameW(
            module, buffer.data(), static_cast<DWORD>(buffer.size()));
        if (written == 0) {
            if (error) *error = GetLastError();
            return {};
        }
        if (written < buffer.size() - 1) {
            buffer.resize(written);
            return buffer;
        }
        if (buffer.size() >= 32768) {
            if (error) *error = ERROR_FILENAME_EXCED_RANGE;
            return {};
        }
        buffer.resize(std::min<std::size_t>(buffer.size() * 2, 32768), L'\0');
    }
}

std::wstring ResolvePluginRoot(const std::wstring& overrideRoot, DWORD* error) {
    if (!overrideRoot.empty()) {
        const DWORD required = GetFullPathNameW(overrideRoot.c_str(), 0, nullptr, nullptr);
        if (required == 0) {
            if (error) *error = GetLastError();
            return {};
        }
        std::wstring normalized(required, L'\0');
        const DWORD written = GetFullPathNameW(
            overrideRoot.c_str(), required, normalized.data(), nullptr);
        if (written == 0 || written >= required) {
            if (error) *error = written == 0 ? GetLastError() : ERROR_INSUFFICIENT_BUFFER;
            return {};
        }
        normalized.resize(written);
        return std::filesystem::path(normalized).lexically_normal().wstring();
    }

    const std::wstring modulePath = GetCurrentModulePath(error);
    if (modulePath.empty()) return {};
    const std::filesystem::path module(modulePath);
    const std::filesystem::path x64Directory = module.parent_path();
    const std::filesystem::path winDirectory = x64Directory.parent_path();
    const std::filesystem::path pluginRoot = winDirectory.parent_path();
    if (x64Directory.filename() != L"x64" || winDirectory.filename() != L"win" ||
        pluginRoot.empty()) {
        if (error) *error = ERROR_BAD_PATHNAME;
        return {};
    }
    return pluginRoot.lexically_normal().wstring();
}

BOOL CALLBACK NotifyFontChangeForCurrentProcess(HWND window, LPARAM processIdValue) {
    DWORD windowProcessId = 0;
    GetWindowThreadProcessId(window, &windowProcessId);
    if (windowProcessId == static_cast<DWORD>(processIdValue)) {
        PostMessageW(window, WM_FONTCHANGE, 0, 0);
    }
    return TRUE;
}

void NotifyCurrentProcessFontChange() noexcept {
    EnumWindows(
        NotifyFontChangeForCurrentProcess,
        static_cast<LPARAM>(GetCurrentProcessId()));
}

void SetFailure(
    PackagedFontItemStatus& item,
    std::string code,
    std::string message,
    DWORD win32Error = ERROR_SUCCESS) {
    item.registered = false;
    item.faceCount = 0;
    item.win32Error = win32Error;
    item.errorCode = std::move(code);
    item.errorMessage = std::move(message);
}

bool HasSfntSignature(const std::array<unsigned char, 4>& signature) {
    return signature == std::array<unsigned char, 4>{0x00, 0x01, 0x00, 0x00} ||
        signature == std::array<unsigned char, 4>{'O', 'T', 'T', 'O'} ||
        signature == std::array<unsigned char, 4>{'t', 'r', 'u', 'e'} ||
        signature == std::array<unsigned char, 4>{'t', 'y', 'p', '1'} ||
        signature == std::array<unsigned char, 4>{'t', 't', 'c', 'f'};
}

FontFileValidation OpenValidatedFontFile(
    const std::wstring& path,
    const oracle::file_identity::StableFileIdentity& expectedIdentity) {
    FontFileValidation validation;
    validation.handle.reset(CreateFileW(
        path.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL | FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_SEQUENTIAL_SCAN,
        nullptr));
    if (validation.handle.get() == INVALID_HANDLE_VALUE) {
        validation.handle.release();
        validation.win32Error = GetLastError();
        validation.errorCode = "FONT_OPEN_FAILED";
        validation.errorMessage = "A packaged font could not be locked for validation.";
        return validation;
    }

    FILE_ATTRIBUTE_TAG_INFO tagInfo{};
    if (!GetFileInformationByHandleEx(
            validation.handle.get(), FileAttributeTagInfo, &tagInfo, sizeof(tagInfo))) {
        validation.win32Error = GetLastError();
        validation.errorCode = "FONT_ATTRIBUTES_FAILED";
        validation.errorMessage = "A packaged font's file attributes could not be verified.";
        return validation;
    }
    if ((tagInfo.FileAttributes & (FILE_ATTRIBUTE_DIRECTORY | FILE_ATTRIBUTE_REPARSE_POINT)) != 0 ||
        tagInfo.ReparseTag != 0) {
        validation.win32Error = ERROR_REPARSE_TAG_INVALID;
        validation.errorCode = "FONT_NOT_REGULAR_FILE";
        validation.errorMessage = "A packaged font is not a normal regular file.";
        return validation;
    }

    FILE_ID_INFO identity{};
    if (!GetFileInformationByHandleEx(
            validation.handle.get(), FileIdInfo, &identity, sizeof(identity))) {
        validation.win32Error = GetLastError();
        validation.errorCode = "FONT_IDENTITY_FAILED";
        validation.errorMessage = "A packaged font's stable file identity could not be verified.";
        return validation;
    }
    oracle::file_identity::StableFileIdentity openedIdentity;
    openedIdentity.volumeSerial = identity.VolumeSerialNumber;
    std::copy(
        std::begin(identity.FileId.Identifier),
        std::end(identity.FileId.Identifier),
        openedIdentity.fileId.begin());
    if (openedIdentity != expectedIdentity) {
        validation.win32Error = ERROR_FILE_INVALID;
        validation.errorCode = "FONT_IDENTITY_CHANGED";
        validation.errorMessage = "A packaged font changed during validation.";
        return validation;
    }

    LARGE_INTEGER byteSize{};
    if (!GetFileSizeEx(validation.handle.get(), &byteSize)) {
        validation.win32Error = GetLastError();
        validation.errorCode = "FONT_SIZE_UNAVAILABLE";
        validation.errorMessage = "A packaged font's byte size could not be verified.";
        return validation;
    }
    if (byteSize.QuadPart < kMinimumFontBytes || byteSize.QuadPart > kMaximumFontBytes) {
        validation.win32Error = ERROR_FILE_INVALID;
        validation.errorCode = "FONT_SIZE_OUT_OF_RANGE";
        validation.errorMessage = "A packaged font's byte size is outside the allowed bounds.";
        return validation;
    }

    std::array<unsigned char, 4> signature{};
    DWORD bytesRead = 0;
    if (!ReadFile(
            validation.handle.get(),
            signature.data(),
            static_cast<DWORD>(signature.size()),
            &bytesRead,
            nullptr) ||
        bytesRead != signature.size()) {
        validation.win32Error = GetLastError();
        if (validation.win32Error == ERROR_SUCCESS) validation.win32Error = ERROR_HANDLE_EOF;
        validation.errorCode = "FONT_SIGNATURE_READ_FAILED";
        validation.errorMessage = "A packaged font's SFNT signature could not be read.";
        return validation;
    }
    if (!HasSfntSignature(signature)) {
        validation.win32Error = ERROR_FILE_INVALID;
        validation.errorCode = "FONT_SIGNATURE_INVALID";
        validation.errorMessage = "A packaged font does not have a supported SFNT signature.";
        return validation;
    }

    validation.ok = true;
    return validation;
}

}  // namespace

PackagedFontRegistrationService::PackagedFontRegistrationService(
    std::wstring pluginRootOverride)
    : pluginRootOverride_(std::move(pluginRootOverride)) {
    fonts_.reserve(std::size(kFontDefinitions));
    for (const auto& definition : kFontDefinitions) {
        FontEntry entry;
        entry.status.id = definition.id;
        entry.status.familyName = definition.familyName;
        entry.status.fileName = definition.publicFileName;
        fonts_.push_back(std::move(entry));
    }
    RebuildSummaryLocked(false);
}

PackagedFontRegistrationService::~PackagedFontRegistrationService() {
    Shutdown();
}

PackagedFontStatus PackagedFontRegistrationService::RegisterPackagedFonts() {
    std::lock_guard lock(mutex_);
    const bool allWereRegistered = !fonts_.empty() &&
        std::all_of(fonts_.begin(), fonts_.end(), [](const FontEntry& font) {
            return font.status.registered;
        });
    attempted_ = true;
    if (allWereRegistered) {
        RebuildSummaryLocked(true);
        return status_;
    }

    DWORD rootError = ERROR_SUCCESS;
    const std::wstring pluginRoot = ResolvePluginRoot(pluginRootOverride_, &rootError);
    if (pluginRoot.empty()) {
        for (auto& font : fonts_) {
            if (!font.status.registered) {
                SetFailure(
                    font.status,
                    "PLUGIN_ROOT_UNAVAILABLE",
                    "The packaged font root could not be resolved from the addon location.",
                    rootError);
            }
        }
        RebuildSummaryLocked(false);
        return status_;
    }

    bool changed = false;
    bool transactionFailed = false;
    bool rollbackFailed = false;
    std::size_t failureIndex = fonts_.size();
    std::vector<std::size_t> newlyRegistered;
    const std::filesystem::path fontDirectory =
        std::filesystem::path(pluginRoot) / L"assets" / L"fonts";
    for (std::size_t index = 0; index < fonts_.size(); ++index) {
        auto& font = fonts_[index];
        if (font.status.registered) continue;

        const std::filesystem::path expectedPath =
            (fontDirectory / kFontDefinitions[index].fileName).lexically_normal();
        const auto inspection =
            oracle::file_identity::InspectSafeRegularFile(expectedPath.wstring());
        if (!inspection.ok) {
            SetFailure(
                font.status,
                inspection.errorCode.empty() ? "FONT_VALIDATION_FAILED" : inspection.errorCode,
                inspection.errorMessage.empty()
                    ? "A packaged font did not pass regular-file validation."
                    : inspection.errorMessage,
                inspection.win32Error);
            transactionFailed = true;
            failureIndex = index;
            break;
        }
        if (oracle::file_identity::NormalizePathForComparison(inspection.normalizedPath) !=
            oracle::file_identity::NormalizePathForComparison(expectedPath.wstring())) {
            SetFailure(
                font.status,
                "FONT_PATH_MISMATCH",
                "A packaged font resolved outside its exact expected location.");
            transactionFailed = true;
            failureIndex = index;
            break;
        }

        auto validation = OpenValidatedFontFile(
            inspection.normalizedPath, inspection.identity);
        if (!validation.ok) {
            SetFailure(
                font.status,
                validation.errorCode,
                validation.errorMessage,
                validation.win32Error);
            transactionFailed = true;
            failureIndex = index;
            break;
        }

        SetLastError(ERROR_SUCCESS);
        const int added = AddFontResourceExW(
            inspection.normalizedPath.c_str(), kPrivateFontFlags, nullptr);
        if (added <= 0) {
            DWORD addError = GetLastError();
            if (addError == ERROR_SUCCESS) addError = ERROR_INVALID_DATA;
            SetFailure(
                font.status,
                "FONT_REGISTRATION_FAILED",
                "Windows rejected a packaged process-private font resource.",
                addError);
            transactionFailed = true;
            failureIndex = index;
            break;
        }

        font.registeredPath = inspection.normalizedPath;
        font.status.registered = true;
        font.status.faceCount = static_cast<std::uint32_t>(added);
        font.status.win32Error = ERROR_SUCCESS;
        font.status.errorCode.clear();
        font.status.errorMessage.clear();
        newlyRegistered.push_back(index);
        changed = true;
    }

    if (transactionFailed) {
        for (auto iterator = newlyRegistered.rbegin();
             iterator != newlyRegistered.rend();
             ++iterator) {
            auto& font = fonts_[*iterator];
            SetLastError(ERROR_SUCCESS);
            if (RemoveFontResourceExW(
                    font.registeredPath.c_str(), kPrivateFontFlags, nullptr)) {
                font.status.registered = false;
                font.status.faceCount = 0;
                font.status.win32Error = ERROR_SUCCESS;
                font.status.errorCode = "FONT_TRANSACTION_ROLLED_BACK";
                font.status.errorMessage =
                    "The font was removed because the packaged set did not register atomically.";
                font.registeredPath.clear();
            } else {
                DWORD removeError = GetLastError();
                if (removeError == ERROR_SUCCESS) removeError = ERROR_BUSY;
                font.status.win32Error = removeError;
                font.status.errorCode = "FONT_ROLLBACK_FAILED";
                font.status.errorMessage =
                    "Windows could not roll back a process-private font registration.";
                rollbackFailed = true;
            }
        }
        for (std::size_t index = 0; index < fonts_.size(); ++index) {
            auto& font = fonts_[index];
            if (font.status.registered || index == failureIndex ||
                font.status.errorCode == "FONT_TRANSACTION_ROLLED_BACK" ||
                font.status.errorCode == "FONT_ROLLBACK_FAILED") {
                continue;
            }
            SetFailure(
                font.status,
                "FONT_TRANSACTION_ABORTED",
                "The font was not registered because the packaged set must be atomic.");
        }
    }
    if (changed) NotifyCurrentProcessFontChange();
    RebuildSummaryLocked(false);
    if (rollbackFailed) {
        status_.ok = false;
        status_.cleanupPending = true;
        status_.state = "rollback_failed";
        status_.errorCode = "FONT_ROLLBACK_FAILED";
        status_.errorMessage =
            "A failed packaged font transaction could not be rolled back completely.";
    }
    return status_;
}

PackagedFontStatus PackagedFontRegistrationService::GetStatus() const {
    std::lock_guard lock(mutex_);
    return status_;
}

void PackagedFontRegistrationService::Shutdown() noexcept {
    std::lock_guard lock(mutex_);
    bool changed = false;
    bool removalFailed = false;
    for (auto iterator = fonts_.rbegin(); iterator != fonts_.rend(); ++iterator) {
        auto& font = *iterator;
        if (!font.status.registered || font.registeredPath.empty()) continue;
        SetLastError(ERROR_SUCCESS);
        if (RemoveFontResourceExW(
                font.registeredPath.c_str(), kPrivateFontFlags, nullptr)) {
            font.status.registered = false;
            font.status.faceCount = 0;
            font.status.win32Error = ERROR_SUCCESS;
            font.status.errorCode.clear();
            font.status.errorMessage.clear();
            font.registeredPath.clear();
            changed = true;
        } else {
            DWORD removeError = GetLastError();
            if (removeError == ERROR_SUCCESS) removeError = ERROR_BUSY;
            font.status.win32Error = removeError;
            font.status.errorCode = "FONT_REMOVE_FAILED";
            font.status.errorMessage =
                "Windows could not remove a packaged process-private font resource.";
            removalFailed = true;
        }
    }
    if (changed) NotifyCurrentProcessFontChange();
    RebuildSummaryLocked(false);
    if (removalFailed) {
        status_.ok = false;
        status_.cleanupPending = true;
        status_.state = "cleanup_failed";
        status_.errorCode = "FONT_CLEANUP_FAILED";
        status_.errorMessage =
            "One or more process-private packaged fonts could not be removed.";
    } else if (status_.registeredFileCount == 0) {
        status_.ok = false;
        status_.cleanupPending = false;
        status_.state = attempted_ ? "unregistered" : "not_registered";
        status_.errorCode.clear();
        status_.errorMessage.clear();
    }
}

void PackagedFontRegistrationService::RebuildSummaryLocked(bool alreadyRegistered) {
    status_.attempted = attempted_;
    status_.processPrivate = true;
    status_.sessionVisible = false;
    status_.registrationFlags = "FR_PRIVATE";
    status_.alreadyRegistered = alreadyRegistered;
    status_.cleanupPending = false;
    status_.totalFileCount = static_cast<std::uint32_t>(fonts_.size());
    status_.registeredFileCount = 0;
    status_.registeredFaceCount = 0;
    status_.items.clear();
    status_.items.reserve(fonts_.size());

    for (const auto& font : fonts_) {
        status_.items.push_back(font.status);
        if (font.status.registered) {
            ++status_.registeredFileCount;
            status_.registeredFaceCount += font.status.faceCount;
        }
        if (font.status.errorCode == "FONT_REMOVE_FAILED" ||
            font.status.errorCode == "FONT_ROLLBACK_FAILED") {
            status_.cleanupPending = true;
        }
    }

    status_.ok = status_.totalFileCount != 0 &&
        status_.registeredFileCount == status_.totalFileCount;
    if (status_.ok) {
        status_.state = "registered";
        status_.errorCode.clear();
        status_.errorMessage.clear();
    } else if (!attempted_) {
        status_.state = "not_registered";
        status_.errorCode.clear();
        status_.errorMessage.clear();
    } else if (status_.registeredFileCount != 0) {
        status_.state = "partial";
        status_.errorCode = "PACKAGED_FONTS_PARTIAL";
        status_.errorMessage = "Only some packaged process-private fonts were registered.";
    } else {
        status_.state = "failed";
        status_.errorCode = "PACKAGED_FONTS_UNAVAILABLE";
        status_.errorMessage = "The packaged process-private fonts could not be registered.";
    }
}

}  // namespace oracle::font_registration
