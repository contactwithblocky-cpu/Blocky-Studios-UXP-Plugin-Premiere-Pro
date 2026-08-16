#pragma once

#include <cstdint>
#include <filesystem>
#include <functional>
#include <memory>
#include <string>

namespace oracle::replay_media {

struct ReplayMediaRequest {
    std::wstring sourcePath;
    std::wstring cacheDirectory;
    std::string cacheKey;
    bool includePreview = false;
    double thumbnailPositionSeconds = 0.0;
    std::uint32_t cacheLimitMb = 1024;
};

struct ReplayMediaResult {
    std::uint64_t requestId = 0;
    bool ok = false;
    bool cancelled = false;
    bool thumbnailReady = false;
    bool previewReady = false;
    bool thumbnailReused = false;
    bool previewReused = false;
    bool hasAudio = false;
    std::wstring thumbnailPath;
    std::wstring previewPath;
    std::string cacheKey;
    std::string sourceContainer;
    std::string sourceVideoCodec;
    std::string sourceVideoProfile;
    std::string sourceAudioCodec;
    std::uint32_t sourceWidth = 0;
    std::uint32_t sourceHeight = 0;
    double durationSeconds = 0.0;
    double fps = 0.0;
    std::uint64_t thumbnailBytes = 0;
    std::uint64_t previewBytes = 0;
    std::uint32_t win32Error = 0;
    std::int32_t exitCode = 0;
    double elapsedMs = 0.0;
    std::string errorCode;
    std::string errorMessage;
};

class ReplayMediaService final {
  public:
    using Completion = std::function<void(ReplayMediaResult)>;

    explicit ReplayMediaService(std::filesystem::path runtimeDirectory = {});
    ~ReplayMediaService();

    ReplayMediaService(const ReplayMediaService&) = delete;
    ReplayMediaService& operator=(const ReplayMediaService&) = delete;

    bool IsAvailable() const noexcept;
    std::filesystem::path RuntimeDirectory() const;
    std::uint64_t PrepareAsync(ReplayMediaRequest request, Completion completion);
    bool CancelRequest(std::uint64_t requestId);
    void Shutdown() noexcept;

  private:
    struct Impl;
    std::unique_ptr<Impl> impl_;
};

}  // namespace oracle::replay_media
