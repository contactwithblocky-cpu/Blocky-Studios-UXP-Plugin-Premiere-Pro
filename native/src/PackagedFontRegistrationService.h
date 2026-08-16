#pragma once

#include <cstdint>
#include <mutex>
#include <string>
#include <vector>

namespace oracle::font_registration {

struct PackagedFontItemStatus {
    std::string id;
    std::string familyName;
    std::string fileName;
    bool registered = false;
    std::uint32_t faceCount = 0;
    unsigned long win32Error = 0;
    std::string errorCode;
    std::string errorMessage;
};

struct PackagedFontStatus {
    bool ok = false;
    bool attempted = false;
    bool processPrivate = true;
    bool sessionVisible = false;
    bool alreadyRegistered = false;
    bool cleanupPending = false;
    std::uint32_t totalFileCount = 0;
    std::uint32_t registeredFileCount = 0;
    std::uint32_t registeredFaceCount = 0;
    std::string state = "not_registered";
    std::string registrationFlags = "FR_PRIVATE";
    std::string errorCode;
    std::string errorMessage;
    std::vector<PackagedFontItemStatus> items;
};

// Owns the exact AddFontResourceExW(FR_PRIVATE) registrations made by this
// addon instance. The fonts are non-persistent and process-private: this
// service never copies into the Windows Fonts directory and never writes the
// font registry. RegisterPackagedFonts is idempotent: an already registered
// file is never added a second time, while a previously failed file may be
// retried. Shutdown removes every successful registration exactly once with
// the same flags.
class PackagedFontRegistrationService final {
  public:
    explicit PackagedFontRegistrationService(std::wstring pluginRootOverride = {});
    ~PackagedFontRegistrationService();

    PackagedFontRegistrationService(const PackagedFontRegistrationService&) = delete;
    PackagedFontRegistrationService& operator=(const PackagedFontRegistrationService&) = delete;

    PackagedFontStatus RegisterPackagedFonts();
    PackagedFontStatus GetStatus() const;
    void Shutdown() noexcept;

  private:
    struct FontEntry {
        PackagedFontItemStatus status;
        std::wstring registeredPath;
    };

    void RebuildSummaryLocked(bool alreadyRegistered);

    mutable std::mutex mutex_;
    std::wstring pluginRootOverride_;
    bool attempted_ = false;
    PackagedFontStatus status_;
    std::vector<FontEntry> fonts_;
};

}  // namespace oracle::font_registration
