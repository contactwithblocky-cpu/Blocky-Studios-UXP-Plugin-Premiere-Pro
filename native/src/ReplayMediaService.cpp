#include "ReplayMediaService.h"

#include <Windows.h>

#include <algorithm>
#include <atomic>
#include <chrono>
#include <cmath>
#include <condition_variable>
#include <cwctype>
#include <deque>
#include <fstream>
#include <iomanip>
#include <limits>
#include <mutex>
#include <optional>
#include <sstream>
#include <stdexcept>
#include <system_error>
#include <thread>
#include <unordered_map>
#include <utility>
#include <vector>

namespace oracle::replay_media {
namespace {

constexpr std::uint64_t kMinimumThumbnailBytes = 1024;
constexpr std::uint64_t kMinimumPreviewBytes = 4096;
constexpr std::uint32_t kMinimumCacheLimitMb = 128;
constexpr std::uint32_t kMaximumCacheLimitMb = 4096;
constexpr wchar_t kThumbnailPrefix[] = L"oracle-thumbnail-v2-";
constexpr wchar_t kPreviewPrefix[] = L"oracle-preview-v1-";

std::filesystem::path DefaultRuntimeDirectory() {
    HMODULE module = nullptr;
    if (!GetModuleHandleExW(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
                GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCWSTR>(&DefaultRuntimeDirectory),
            &module)) {
        return {};
    }
    std::wstring buffer(32768, L'\0');
    const DWORD length = GetModuleFileNameW(module, buffer.data(), static_cast<DWORD>(buffer.size()));
    if (length == 0 || length >= buffer.size()) return {};
    buffer.resize(length);
    return std::filesystem::path(buffer).parent_path() / L"media";
}

bool IsAbsoluteLocalPath(const std::filesystem::path& path) {
    const std::wstring value = path.native();
    return value.size() >= 3 && std::iswalpha(value[0]) && value[1] == L':' &&
        (value[2] == L'\\' || value[2] == L'/') && path.is_absolute();
}

bool IsHexKey(const std::string& value) {
    if (value.size() < 32 || value.size() > 64) return false;
    return std::all_of(value.begin(), value.end(), [](unsigned char character) {
        return (character >= '0' && character <= '9') ||
            (character >= 'a' && character <= 'f') ||
            (character >= 'A' && character <= 'F');
    });
}

std::wstring QuoteArgument(const std::wstring& value) {
    if (value.empty()) return L"\"\"";
    if (value.find_first_of(L" \t\n\v\"") == std::wstring::npos) return value;
    std::wstring output = L"\"";
    std::size_t backslashes = 0;
    for (const wchar_t character : value) {
        if (character == L'\\') {
            ++backslashes;
            continue;
        }
        if (character == L'\"') {
            output.append(backslashes * 2 + 1, L'\\');
            output.push_back(L'\"');
            backslashes = 0;
            continue;
        }
        output.append(backslashes, L'\\');
        backslashes = 0;
        output.push_back(character);
    }
    output.append(backslashes * 2, L'\\');
    output.push_back(L'\"');
    return output;
}

std::wstring BuildCommandLine(
    const std::filesystem::path& executable,
    const std::vector<std::wstring>& arguments) {
    std::wstring command = QuoteArgument(executable.native());
    for (const auto& argument : arguments) {
        command.push_back(L' ');
        command.append(QuoteArgument(argument));
    }
    return command;
}

bool IsUsableFile(const std::filesystem::path& path, std::uint64_t minimumBytes) {
    std::error_code error;
    if (!std::filesystem::is_regular_file(path, error) || error) return false;
    const auto size = std::filesystem::file_size(path, error);
    return !error && size >= minimumBytes;
}

std::uint64_t FileBytes(const std::filesystem::path& path) {
    std::error_code error;
    const auto size = std::filesystem::file_size(path, error);
    return error ? 0 : static_cast<std::uint64_t>(size);
}

void RemoveIfPresent(const std::filesystem::path& path) noexcept {
    std::error_code ignored;
    std::filesystem::remove(path, ignored);
}

void Touch(const std::filesystem::path& path) noexcept {
    std::error_code ignored;
    std::filesystem::last_write_time(path, std::filesystem::file_time_type::clock::now(), ignored);
}

double ParseFraction(const std::string& value) {
    const auto slash = value.find('/');
    try {
        if (slash == std::string::npos) return std::stod(value);
        const double numerator = std::stod(value.substr(0, slash));
        const double denominator = std::stod(value.substr(slash + 1));
        return denominator == 0.0 ? 0.0 : numerator / denominator;
    } catch (...) {
        return 0.0;
    }
}

std::unordered_map<std::string, std::string> ParseCompactLine(const std::string& line) {
    std::unordered_map<std::string, std::string> values;
    std::size_t start = 0;
    while (start < line.size()) {
        const std::size_t end = line.find('|', start);
        const std::string part = line.substr(start, end == std::string::npos ? end : end - start);
        const std::size_t equals = part.find('=');
        if (equals != std::string::npos) values[part.substr(0, equals)] = part.substr(equals + 1);
        if (end == std::string::npos) break;
        start = end + 1;
    }
    return values;
}

void ParseProbeFile(const std::filesystem::path& path, ReplayMediaResult& result) {
    std::ifstream stream(path, std::ios::binary);
    std::string line;
    while (std::getline(stream, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back();
        const auto values = ParseCompactLine(line);
        const auto type = values.find("codec_type");
        if (type != values.end() && type->second == "video") {
            if (const auto item = values.find("codec_name"); item != values.end()) result.sourceVideoCodec = item->second;
            if (const auto item = values.find("profile"); item != values.end()) result.sourceVideoProfile = item->second;
            if (const auto item = values.find("width"); item != values.end()) {
                try { result.sourceWidth = static_cast<std::uint32_t>(std::stoul(item->second)); } catch (...) {}
            }
            if (const auto item = values.find("height"); item != values.end()) {
                try { result.sourceHeight = static_cast<std::uint32_t>(std::stoul(item->second)); } catch (...) {}
            }
            if (const auto item = values.find("r_frame_rate"); item != values.end()) result.fps = ParseFraction(item->second);
        } else if (type != values.end() && type->second == "audio") {
            result.hasAudio = true;
            if (const auto item = values.find("codec_name"); item != values.end()) result.sourceAudioCodec = item->second;
        }
        if (const auto item = values.find("format_name"); item != values.end()) result.sourceContainer = item->second;
        if (const auto item = values.find("duration"); item != values.end()) {
            try { result.durationSeconds = std::max(0.0, std::stod(item->second)); } catch (...) {}
        }
    }
}

void CommitFile(const std::filesystem::path& temporary, const std::filesystem::path& destination) {
    if (!MoveFileExW(
            temporary.c_str(),
            destination.c_str(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH)) {
        const DWORD error = GetLastError();
        RemoveIfPresent(temporary);
        throw std::system_error(static_cast<int>(error), std::system_category(), "media cache commit failed");
    }
}

void EnforceCacheLimit(
    const std::filesystem::path& directory,
    std::uint32_t limitMb,
    const std::string& currentKey) noexcept {
    struct Entry {
        std::filesystem::path path;
        std::filesystem::file_time_type writeTime;
        std::uint64_t bytes = 0;
        bool current = false;
    };
    try {
        const std::uint64_t limit = static_cast<std::uint64_t>(std::clamp(
            limitMb, kMinimumCacheLimitMb, kMaximumCacheLimitMb)) * 1024ull * 1024ull;
        std::vector<Entry> entries;
        std::uint64_t total = 0;
        for (const auto& item : std::filesystem::directory_iterator(directory)) {
            if (!item.is_regular_file()) continue;
            const std::wstring name = item.path().filename().native();
            const bool managed = name.starts_with(kThumbnailPrefix) || name.starts_with(kPreviewPrefix);
            if (!managed || name.find(L".tmp.") != std::wstring::npos) continue;
            const std::uint64_t bytes = static_cast<std::uint64_t>(item.file_size());
            total += bytes;
            const std::wstring wideKey(currentKey.begin(), currentKey.end());
            entries.push_back({item.path(), item.last_write_time(), bytes, name.find(wideKey) != std::wstring::npos});
        }
        std::sort(entries.begin(), entries.end(), [](const Entry& left, const Entry& right) {
            if (left.current != right.current) return !left.current;
            return left.writeTime < right.writeTime;
        });
        for (const auto& entry : entries) {
            if (total <= limit) break;
            if (entry.current) continue;
            std::error_code error;
            if (std::filesystem::remove(entry.path, error) && !error) total -= entry.bytes;
        }
    } catch (...) {
        // Cache pressure cleanup is best-effort and never invalidates a valid result.
    }
}

}  // namespace

struct ReplayMediaService::Impl {
    struct Job {
        std::uint64_t requestId = 0;
        ReplayMediaRequest request;
        Completion completion;
        std::atomic<bool> cancelled{false};
    };

    explicit Impl(std::filesystem::path runtime)
        : runtimeDirectory(runtime.empty() ? DefaultRuntimeDirectory() : std::move(runtime)),
          ffmpegPath(runtimeDirectory / L"ffmpeg.exe"),
          ffprobePath(runtimeDirectory / L"ffprobe.exe") {
        available = IsUsableFile(ffmpegPath, 1024) && IsUsableFile(ffprobePath, 1024);
        if (available) worker = std::thread([this] { WorkerLoop(); });
    }

    ~Impl() { Shutdown(); }

    std::uint64_t PrepareAsync(ReplayMediaRequest request, Completion completion) {
        if (!completion) throw std::invalid_argument("Replay media completion callback is required");
        if (!available) throw std::runtime_error("The packaged replay media worker is unavailable");
        auto job = std::make_shared<Job>();
        job->requestId = nextRequestId.fetch_add(1, std::memory_order_relaxed);
        job->request = std::move(request);
        job->completion = std::move(completion);
        {
            std::lock_guard lock(mutex);
            if (stopping) throw std::runtime_error("The replay media worker is shutting down");
            jobs.emplace(job->requestId, job);
            queue.push_back(job);
        }
        wake.notify_one();
        return job->requestId;
    }

    bool CancelRequest(std::uint64_t requestId) {
        std::lock_guard lock(mutex);
        const auto found = jobs.find(requestId);
        if (found == jobs.end()) return false;
        found->second->cancelled.store(true, std::memory_order_release);
        if (runningRequestId == requestId && runningProcess) TerminateProcess(runningProcess, ERROR_CANCELLED);
        wake.notify_all();
        return true;
    }

    void Shutdown() noexcept {
        {
            std::lock_guard lock(mutex);
            if (stopping) return;
            stopping = true;
            for (auto& [id, job] : jobs) job->cancelled.store(true, std::memory_order_release);
            if (runningProcess) TerminateProcess(runningProcess, ERROR_CANCELLED);
        }
        wake.notify_all();
        if (worker.joinable()) worker.join();
    }

    void WorkerLoop() noexcept {
        for (;;) {
            std::shared_ptr<Job> job;
            {
                std::unique_lock lock(mutex);
                wake.wait(lock, [this] { return stopping || !queue.empty(); });
                if (queue.empty()) {
                    if (stopping) break;
                    continue;
                }
                job = queue.front();
                queue.pop_front();
            }
            ReplayMediaResult result = Execute(job);
            try { job->completion(std::move(result)); } catch (...) {}
            {
                std::lock_guard lock(mutex);
                jobs.erase(job->requestId);
            }
        }
    }

    std::int32_t RunProcess(
        const std::shared_ptr<Job>& job,
        const std::filesystem::path& executable,
        const std::vector<std::wstring>& arguments,
        const std::filesystem::path& logPath,
        std::uint32_t& win32Error) {
        RemoveIfPresent(logPath);
        SECURITY_ATTRIBUTES security{sizeof(security), nullptr, TRUE};
        HANDLE log = CreateFileW(
            logPath.c_str(), GENERIC_WRITE, FILE_SHARE_READ, &security,
            CREATE_ALWAYS, FILE_ATTRIBUTE_TEMPORARY, nullptr);
        if (log == INVALID_HANDLE_VALUE) {
            win32Error = GetLastError();
            return -1;
        }
        HANDLE input = CreateFileW(
            L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security,
            OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
        STARTUPINFOW startup{};
        startup.cb = sizeof(startup);
        startup.dwFlags = STARTF_USESTDHANDLES;
        startup.hStdInput = input == INVALID_HANDLE_VALUE ? nullptr : input;
        startup.hStdOutput = log;
        startup.hStdError = log;
        PROCESS_INFORMATION process{};
        std::wstring command = BuildCommandLine(executable, arguments);
        const BOOL started = CreateProcessW(
            executable.c_str(), command.data(), nullptr, nullptr, TRUE,
            CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT, nullptr,
            runtimeDirectory.c_str(), &startup, &process);
        if (input != INVALID_HANDLE_VALUE) CloseHandle(input);
        CloseHandle(log);
        if (!started) {
            win32Error = GetLastError();
            return -1;
        }
        {
            std::lock_guard lock(mutex);
            runningProcess = process.hProcess;
            runningRequestId = job->requestId;
        }
        if (job->cancelled.load(std::memory_order_acquire)) TerminateProcess(process.hProcess, ERROR_CANCELLED);
        WaitForSingleObject(process.hProcess, INFINITE);
        DWORD exitCode = 1;
        if (!GetExitCodeProcess(process.hProcess, &exitCode)) {
            win32Error = GetLastError();
            exitCode = 1;
        }
        {
            std::lock_guard lock(mutex);
            if (runningRequestId == job->requestId) {
                runningProcess = nullptr;
                runningRequestId = 0;
            }
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return static_cast<std::int32_t>(exitCode);
    }

    ReplayMediaResult Execute(const std::shared_ptr<Job>& job) noexcept {
        const auto started = std::chrono::steady_clock::now();
        ReplayMediaResult result;
        result.requestId = job->requestId;
        result.cacheKey = job->request.cacheKey;
        std::filesystem::path thumbnailTemporary;
        std::filesystem::path previewTemporary;
        std::filesystem::path probeLog;
        std::filesystem::path workerLog;
        try {
            const auto& request = job->request;
            const std::filesystem::path source(request.sourcePath);
            const std::filesystem::path cache(request.cacheDirectory);
            if (!IsAbsoluteLocalPath(source) || !IsUsableFile(source, 1)) {
                throw std::invalid_argument("Replay source must be an existing absolute local file");
            }
            if (!IsAbsoluteLocalPath(cache)) throw std::invalid_argument("Replay cache must be an absolute local directory");
            if (!IsHexKey(request.cacheKey)) throw std::invalid_argument("Replay media cache key is invalid");
            if (!std::isfinite(request.thumbnailPositionSeconds) || request.thumbnailPositionSeconds < 0.0) {
                throw std::invalid_argument("Replay thumbnail position must be a finite non-negative number");
            }
            std::filesystem::create_directories(cache);
            if (job->cancelled.load(std::memory_order_acquire)) throw std::runtime_error("cancelled");

            result.thumbnailPath = (cache / (std::wstring(kThumbnailPrefix) +
                std::wstring(request.cacheKey.begin(), request.cacheKey.end()) + L".jpg")).native();
            result.previewPath = (cache / (std::wstring(kPreviewPrefix) +
                std::wstring(request.cacheKey.begin(), request.cacheKey.end()) + L".mp4")).native();
            const std::wstring suffix = L"-" + std::to_wstring(job->requestId);
            probeLog = cache / (L"oracle-media-probe" + suffix + L".tmp.txt");
            workerLog = cache / (L"oracle-media-worker" + suffix + L".tmp.txt");
            thumbnailTemporary = cache / (std::wstring(kThumbnailPrefix) +
                std::wstring(request.cacheKey.begin(), request.cacheKey.end()) + suffix + L".tmp.jpg");
            previewTemporary = cache / (std::wstring(kPreviewPrefix) +
                std::wstring(request.cacheKey.begin(), request.cacheKey.end()) + suffix + L".tmp.mp4");

            std::uint32_t win32Error = 0;
            result.exitCode = RunProcess(job, ffprobePath, {
                L"-v", L"error",
                L"-show_entries",
                L"stream=codec_type,codec_name,profile,width,height,r_frame_rate,sample_rate,channels:format=format_name,duration",
                L"-of", L"compact=p=0:nk=0",
                source.native(),
            }, probeLog, win32Error);
            result.win32Error = win32Error;
            if (job->cancelled.load(std::memory_order_acquire)) throw std::runtime_error("cancelled");
            if (result.exitCode != 0) {
                result.errorCode = "MEDIA_PROBE_FAILED";
                throw std::runtime_error("Blocky Studios could not inspect this replay's media streams");
            }
            ParseProbeFile(probeLog, result);
            if (result.sourceVideoCodec.empty()) {
                result.errorCode = "VIDEO_STREAM_MISSING";
                throw std::runtime_error("The replay does not contain a readable video stream");
            }

            const std::filesystem::path thumbnail(result.thumbnailPath);
            result.thumbnailReused = IsUsableFile(thumbnail, kMinimumThumbnailBytes);
            if (!result.thumbnailReused) {
                std::ostringstream position;
                position << std::fixed << std::setprecision(3) << request.thumbnailPositionSeconds;
                const std::string positionText = position.str();
                result.exitCode = RunProcess(job, ffmpegPath, {
                    L"-hide_banner", L"-nostdin", L"-loglevel", L"error", L"-y",
                    L"-ss", std::wstring(positionText.begin(), positionText.end()),
                    L"-i", source.native(),
                    L"-map", L"0:v:0", L"-frames:v", L"1",
                    L"-vf", L"scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black",
                    L"-q:v", L"3", L"-update", L"1", thumbnailTemporary.native(),
                }, workerLog, result.win32Error);
                if (job->cancelled.load(std::memory_order_acquire)) throw std::runtime_error("cancelled");
                if (result.exitCode != 0 || !IsUsableFile(thumbnailTemporary, kMinimumThumbnailBytes)) {
                    result.errorCode = "THUMBNAIL_EXTRACTION_FAILED";
                    throw std::runtime_error("Blocky Studios could not extract a replay preview image");
                }
                CommitFile(thumbnailTemporary, thumbnail);
            }
            Touch(thumbnail);
            result.thumbnailReady = true;
            result.thumbnailBytes = FileBytes(thumbnail);

            if (request.includePreview) {
                const std::filesystem::path preview(result.previewPath);
                result.previewReused = IsUsableFile(preview, kMinimumPreviewBytes);
                if (!result.previewReused) {
                    result.exitCode = RunProcess(job, ffmpegPath, {
                        L"-hide_banner", L"-nostdin", L"-loglevel", L"error", L"-y",
                        L"-i", source.native(),
                        L"-map", L"0:v:0", L"-map", L"0:a:0?",
                        L"-vf", L"scale=1280:-2:flags=lanczos,format=yuv420p",
                        L"-c:v", L"libopenh264", L"-b:v", L"6000k",
                        L"-maxrate", L"8000k", L"-bufsize", L"12000k",
                        L"-c:a", L"aac", L"-b:a", L"192k", L"-ac", L"2",
                        L"-movflags", L"+faststart", previewTemporary.native(),
                    }, workerLog, result.win32Error);
                    if (job->cancelled.load(std::memory_order_acquire)) throw std::runtime_error("cancelled");
                    if (result.exitCode != 0 || !IsUsableFile(previewTemporary, kMinimumPreviewBytes)) {
                        result.errorCode = "PREVIEW_TRANSCODE_FAILED";
                        throw std::runtime_error("Blocky Studios could not prepare an internal replay preview");
                    }
                    CommitFile(previewTemporary, preview);
                }
                Touch(preview);
                result.previewReady = true;
                result.previewBytes = FileBytes(preview);
            }

            EnforceCacheLimit(cache, request.cacheLimitMb, request.cacheKey);
            result.ok = true;
        } catch (const std::invalid_argument& error) {
            result.errorCode = result.errorCode.empty() ? "INVALID_MEDIA_REQUEST" : result.errorCode;
            result.errorMessage = error.what();
        } catch (const std::system_error& error) {
            result.win32Error = static_cast<std::uint32_t>(error.code().value());
            result.errorCode = result.errorCode.empty() ? "MEDIA_CACHE_COMMIT_FAILED" : result.errorCode;
            result.errorMessage = "Blocky Studios could not commit the managed replay preview cache";
        } catch (const std::exception& error) {
            result.cancelled = job->cancelled.load(std::memory_order_acquire) ||
                std::string(error.what()) == "cancelled";
            result.errorCode = result.cancelled
                ? "MEDIA_PREPARATION_CANCELLED"
                : result.errorCode.empty() ? "MEDIA_PREPARATION_FAILED" : result.errorCode;
            result.errorMessage = result.cancelled
                ? "Replay preview preparation was cancelled"
                : error.what();
        } catch (...) {
            result.errorCode = "MEDIA_PREPARATION_FAILED";
            result.errorMessage = "Blocky Studios could not prepare replay media";
        }
        RemoveIfPresent(thumbnailTemporary);
        RemoveIfPresent(previewTemporary);
        RemoveIfPresent(probeLog);
        RemoveIfPresent(workerLog);
        result.elapsedMs = std::chrono::duration<double, std::milli>(
            std::chrono::steady_clock::now() - started).count();
        return result;
    }

    std::filesystem::path runtimeDirectory;
    std::filesystem::path ffmpegPath;
    std::filesystem::path ffprobePath;
    bool available = false;
    std::atomic<std::uint64_t> nextRequestId{1};
    mutable std::mutex mutex;
    std::condition_variable wake;
    std::deque<std::shared_ptr<Job>> queue;
    std::unordered_map<std::uint64_t, std::shared_ptr<Job>> jobs;
    std::thread worker;
    bool stopping = false;
    HANDLE runningProcess = nullptr;
    std::uint64_t runningRequestId = 0;
};

ReplayMediaService::ReplayMediaService(std::filesystem::path runtimeDirectory)
    : impl_(std::make_unique<Impl>(std::move(runtimeDirectory))) {}

ReplayMediaService::~ReplayMediaService() = default;

bool ReplayMediaService::IsAvailable() const noexcept {
    return impl_ && impl_->available;
}

std::filesystem::path ReplayMediaService::RuntimeDirectory() const {
    return impl_ ? impl_->runtimeDirectory : std::filesystem::path{};
}

std::uint64_t ReplayMediaService::PrepareAsync(
    ReplayMediaRequest request,
    Completion completion) {
    if (!impl_) throw std::runtime_error("The replay media service is unavailable");
    return impl_->PrepareAsync(std::move(request), std::move(completion));
}

bool ReplayMediaService::CancelRequest(std::uint64_t requestId) {
    return impl_ && impl_->CancelRequest(requestId);
}

void ReplayMediaService::Shutdown() noexcept {
    if (impl_) impl_->Shutdown();
}

}  // namespace oracle::replay_media
