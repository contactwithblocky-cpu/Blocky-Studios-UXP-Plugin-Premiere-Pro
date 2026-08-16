#include "PackagedFontRegistrationService.h"

#include <Windows.h>

#include <algorithm>
#include <array>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>

using oracle::font_registration::PackagedFontRegistrationService;
using oracle::font_registration::PackagedFontStatus;

namespace {

void Require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

int CALLBACK CountFontFamily(
    const LOGFONTW*, const TEXTMETRICW*, DWORD, LPARAM countValue) {
    auto* count = reinterpret_cast<int*>(countValue);
    ++(*count);
    return 1;
}

bool IsFontFamilyVisible(const wchar_t* familyName) {
    HDC deviceContext = GetDC(nullptr);
    if (!deviceContext) return false;
    LOGFONTW query{};
    query.lfCharSet = DEFAULT_CHARSET;
    wcscpy_s(query.lfFaceName, familyName);
    int count = 0;
    EnumFontFamiliesExW(
        deviceContext,
        &query,
        reinterpret_cast<FONTENUMPROCW>(CountFontFamily),
        reinterpret_cast<LPARAM>(&count),
        0);
    ReleaseDC(nullptr, deviceContext);
    return count > 0;
}

void RequireNoPrivatePathLeak(
    const PackagedFontStatus& status,
    const std::filesystem::path& pluginRoot) {
    const std::string rootName = pluginRoot.filename().string();
    const auto pathFree = [&](const std::string& value) {
        return value.find(":\\") == std::string::npos &&
            value.find(":/") == std::string::npos &&
            (rootName.empty() || value.find(rootName) == std::string::npos);
    };
    Require(pathFree(status.errorMessage), "summary leaked a private absolute path");
    for (const auto& item : status.items) {
        Require(pathFree(item.errorMessage), "font status leaked a private absolute path");
        Require(item.fileName.find('\\') == std::string::npos, "font name exposed a path");
        Require(item.fileName.find('/') == std::string::npos, "font name exposed a path");
    }
}

void TestRegistrationIdempotenceAndCleanup(const std::filesystem::path& pluginRoot) {
    PackagedFontRegistrationService service(pluginRoot.wstring());
    const auto initial = service.GetStatus();
    Require(!initial.ok && !initial.attempted, "fresh font service was already attempted");
    Require(initial.state == "not_registered", "fresh font state was not explicit");
    Require(initial.totalFileCount == 3, "unexpected packaged font contract size");

    const auto registered = service.RegisterPackagedFonts();
    Require(registered.ok, "packaged process-private font registration failed");
    Require(
        registered.attempted && registered.processPrivate && !registered.sessionVisible &&
            registered.registrationFlags == "FR_PRIVATE",
        "font registration scope is not accurately reported");
    Require(registered.state == "registered", "font state did not become registered");
    Require(registered.registeredFileCount == 3, "not every packaged font registered");
    Require(registered.registeredFaceCount >= 3, "registered face count is incomplete");
    Require(registered.items.size() == 3, "font item status count changed");
    const std::array<std::string, 3> expectedIds{
        "samsungSharpSansRegular", "samsungSharpSansMedium", "samsungSharpSansBold"};
    const std::array<std::string, 3> expectedFamilies{
        "Samsung Sharp Sans", "Samsung Sharp Sans", "Samsung Sharp Sans"};
    const std::array<std::string, 3> expectedFiles{
        "samsung_sharp_sans_regular.otf",
        "samsung_sharp_sans_medium.otf",
        "samsung_sharp_sans_bold.otf"};
    for (std::size_t index = 0; index < registered.items.size(); ++index) {
        const auto& item = registered.items[index];
        Require(item.id == expectedIds[index], "registered font id changed");
        Require(item.familyName == expectedFamilies[index], "registered family name changed");
        Require(item.fileName == expectedFiles[index], "registered font file changed");
        Require(item.registered && item.faceCount >= 1, "exact packaged font was not registered");
    }
    RequireNoPrivatePathLeak(registered, pluginRoot);
    Require(
        IsFontFamilyVisible(L"Samsung Sharp Sans"),
        "Samsung Sharp Sans family is not process-visible");

    const auto repeated = service.RegisterPackagedFonts();
    Require(repeated.ok && repeated.alreadyRegistered, "repeat registration was not idempotent");
    Require(
        repeated.registeredFaceCount == registered.registeredFaceCount,
        "repeat registration duplicated process-private font resources");

    std::vector<std::thread> callers;
    std::vector<PackagedFontStatus> results(8);
    for (std::size_t index = 0; index < results.size(); ++index) {
        callers.emplace_back([&service, &results, index]() {
            results[index] = service.RegisterPackagedFonts();
        });
    }
    for (auto& caller : callers) caller.join();
    Require(
        std::all_of(results.begin(), results.end(), [&](const auto& result) {
            return result.ok && result.alreadyRegistered &&
                result.registeredFaceCount == registered.registeredFaceCount;
        }),
        "concurrent registration was not reference-safe");

    service.Shutdown();
    const auto stopped = service.GetStatus();
    Require(!stopped.ok && stopped.state == "unregistered", "font shutdown state is wrong");
    Require(!stopped.cleanupPending, "font shutdown left cleanup pending");
    Require(stopped.registeredFileCount == 0, "font shutdown retained registrations");

    const auto restarted = service.RegisterPackagedFonts();
    Require(restarted.ok, "font service could not register after clean shutdown");
    Require(restarted.registeredFileCount == 3, "re-registration was incomplete");
}

void TestAtomicRollbackAndRetry(const std::filesystem::path& pluginRoot) {
    const auto disposable = std::filesystem::temp_directory_path() /
        (L"oracle packaged font transaction " + std::to_wstring(GetCurrentProcessId()));
    const auto fontDirectory = disposable / L"assets" / L"fonts";
    std::filesystem::remove_all(disposable);
    std::filesystem::create_directories(fontDirectory);
    const auto sourceDirectory = pluginRoot / L"assets" / L"fonts";
    std::filesystem::copy_file(
        sourceDirectory / L"samsung_sharp_sans_regular.otf",
        fontDirectory / L"samsung_sharp_sans_regular.otf");
    std::filesystem::copy_file(
        sourceDirectory / L"samsung_sharp_sans_bold.otf",
        fontDirectory / L"samsung_sharp_sans_bold.otf");
    {
        std::ofstream invalid(
            fontDirectory / L"samsung_sharp_sans_medium.otf", std::ios::binary);
        invalid.write("OTTO", 4);
    }

    PackagedFontRegistrationService service(disposable.wstring());
    const auto failed = service.RegisterPackagedFonts();
    Require(!failed.ok && failed.state == "failed", "invalid font transaction succeeded");
    Require(failed.registeredFileCount == 0, "failed font transaction left a partial set");
    Require(
        failed.items[0].errorCode == "FONT_TRANSACTION_ROLLED_BACK",
        "font registered before failure was not rolled back");
    Require(
        failed.items[1].errorCode == "FONT_SIZE_OUT_OF_RANGE",
        "bounded byte-size guard did not reject the invalid font");
    Require(
        failed.items[2].errorCode == "FONT_TRANSACTION_ABORTED",
        "font transaction continued after the first failure");
    RequireNoPrivatePathLeak(failed, disposable);

    {
        std::ofstream invalid(
            fontDirectory / L"samsung_sharp_sans_medium.otf",
            std::ios::binary | std::ios::trunc);
        const std::string invalidSfnt(2048, 'X');
        invalid.write(invalidSfnt.data(), static_cast<std::streamsize>(invalidSfnt.size()));
    }
    const auto invalidSignature = service.RegisterPackagedFonts();
    Require(
        !invalidSignature.ok && invalidSignature.registeredFileCount == 0,
        "invalid SFNT transaction left a partial set");
    Require(
        invalidSignature.items[0].errorCode == "FONT_TRANSACTION_ROLLED_BACK" &&
            invalidSignature.items[1].errorCode == "FONT_SIGNATURE_INVALID" &&
            invalidSignature.items[2].errorCode == "FONT_TRANSACTION_ABORTED",
        "SFNT signature guard or rollback was not exact");

    std::filesystem::copy_file(
        sourceDirectory / L"samsung_sharp_sans_medium.otf",
        fontDirectory / L"samsung_sharp_sans_medium.otf",
        std::filesystem::copy_options::overwrite_existing);
    const auto retried = service.RegisterPackagedFonts();
    Require(retried.ok && retried.registeredFileCount == 3, "corrected font set did not retry");
    service.Shutdown();
    const auto stopped = service.GetStatus();
    Require(
        stopped.state == "unregistered" && stopped.registeredFileCount == 0,
        "explicit font unregister did not clean the corrected set");
    std::filesystem::remove_all(disposable);
}

void TestDestructorCleanup(const std::filesystem::path& pluginRoot) {
    {
        PackagedFontRegistrationService service(pluginRoot.wstring());
        Require(service.RegisterPackagedFonts().ok, "destructor cleanup fixture did not register");
    }

    const auto fontDirectory = pluginRoot / L"assets" / L"fonts";
    bool leaked = false;
    for (const auto* fileName : {
             L"samsung_sharp_sans_regular.otf",
             L"samsung_sharp_sans_medium.otf",
             L"samsung_sharp_sans_bold.otf"}) {
        if (RemoveFontResourceExW(
                (fontDirectory / fileName).c_str(), FR_PRIVATE, nullptr)) {
            leaked = true;
        }
    }
    Require(!leaked, "font service destructor left a process-private registration");
}

void TestMultipleOwnersRemainBalanced(const std::filesystem::path& pluginRoot) {
    PackagedFontRegistrationService first(pluginRoot.wstring());
    PackagedFontRegistrationService second(pluginRoot.wstring());
    Require(first.RegisterPackagedFonts().ok, "first private font owner did not register");
    Require(second.RegisterPackagedFonts().ok, "second private font owner did not register");
    first.Shutdown();
    Require(
        second.GetStatus().ok && IsFontFamilyVisible(L"Samsung Sharp Sans"),
        "one owner removed another owner's private registration");
    second.Shutdown();

    const auto fontDirectory = pluginRoot / L"assets" / L"fonts";
    bool unbalanced = false;
    for (const auto* fileName : {
             L"samsung_sharp_sans_regular.otf",
             L"samsung_sharp_sans_medium.otf",
             L"samsung_sharp_sans_bold.otf"}) {
        if (RemoveFontResourceExW(
                (fontDirectory / fileName).c_str(), FR_PRIVATE, nullptr)) {
            unbalanced = true;
        }
    }
    Require(!unbalanced, "multiple private registrations were not removed exactly once each");
}

void TestMissingAndReparseRootsFailClosed(const std::filesystem::path& pluginRoot) {
    const auto disposable = std::filesystem::temp_directory_path() /
        (L"oracle packaged font guards " + std::to_wstring(GetCurrentProcessId()));
    std::filesystem::remove_all(disposable);
    std::filesystem::create_directories(disposable);
    {
        PackagedFontRegistrationService missing(disposable.wstring());
        const auto status = missing.RegisterPackagedFonts();
        Require(!status.ok && status.state == "failed", "missing font root did not fail closed");
        Require(status.registeredFileCount == 0, "missing root registered a resource");
        Require(
            !status.items[0].registered && status.items[0].errorCode == "PATH_NOT_FOUND" &&
                status.items[1].errorCode == "FONT_TRANSACTION_ABORTED" &&
                status.items[2].errorCode == "FONT_TRANSACTION_ABORTED",
            "missing font status was not exact");
        RequireNoPrivatePathLeak(status, disposable);
    }

    const auto assets = disposable / L"linked-case" / L"assets";
    std::filesystem::create_directories(assets);
    const auto linkedFonts = assets / L"fonts";
    const auto realFonts = pluginRoot / L"assets" / L"fonts";
    Require(
        CreateSymbolicLinkW(
            linkedFonts.c_str(),
            realFonts.c_str(),
            SYMBOLIC_LINK_FLAG_DIRECTORY | SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE) != FALSE,
        "could not create disposable font reparse fixture");
    {
        PackagedFontRegistrationService reparse((disposable / L"linked-case").wstring());
        const auto status = reparse.RegisterPackagedFonts();
        Require(!status.ok && status.registeredFileCount == 0, "reparse font root was accepted");
        Require(
            status.items[0].errorCode == "REPARSE_POINT_NOT_ALLOWED" &&
                status.items[1].errorCode == "FONT_TRANSACTION_ABORTED" &&
                status.items[2].errorCode == "FONT_TRANSACTION_ABORTED",
            "reparse font failure was not explicit");
        RequireNoPrivatePathLeak(status, disposable);
    }
    std::filesystem::remove_all(disposable);
}

}  // namespace

int wmain(int argumentCount, wchar_t** arguments) {
    try {
        Require(argumentCount == 2, "font tests require the plugin root argument");
        const std::filesystem::path pluginRoot(arguments[1]);
        TestRegistrationIdempotenceAndCleanup(pluginRoot);
        TestAtomicRollbackAndRetry(pluginRoot);
        TestDestructorCleanup(pluginRoot);
        TestMultipleOwnersRemainBalanced(pluginRoot);
        TestMissingAndReparseRootsFailClosed(pluginRoot);
        std::wcout << L"oracle packaged font registration service tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "oracle packaged font registration test failure: " << error.what() << '\n';
        return 1;
    }
}
