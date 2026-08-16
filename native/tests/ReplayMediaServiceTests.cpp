#include "ReplayMediaService.h"

#include <Windows.h>

#include <chrono>
#include <condition_variable>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <iterator>
#include <mutex>
#include <optional>
#include <string>
#include <vector>

namespace {

std::wstring Quote(const std::wstring& value) {
    return L"\"" + value + L"\"";
}

bool Run(const std::filesystem::path& executable, const std::wstring& arguments) {
    std::wstring command = Quote(executable.native()) + L" " + arguments;
    STARTUPINFOW startup{sizeof(startup)};
    PROCESS_INFORMATION process{};
    if (!CreateProcessW(
            executable.c_str(), command.data(), nullptr, nullptr, FALSE,
            CREATE_NO_WINDOW, nullptr, executable.parent_path().c_str(),
            &startup, &process)) return false;
    WaitForSingleObject(process.hProcess, INFINITE);
    DWORD exitCode = 1;
    GetExitCodeProcess(process.hProcess, &exitCode);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return exitCode == 0;
}

bool ContainsAscii(const std::filesystem::path& path, const std::string& needle) {
    std::ifstream stream(path, std::ios::binary);
    const std::string value((std::istreambuf_iterator<char>(stream)), std::istreambuf_iterator<char>());
    return value.find(needle) != std::string::npos;
}

bool IsJpeg(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    unsigned char header[2]{};
    stream.read(reinterpret_cast<char*>(header), sizeof(header));
    return stream.gcount() == 2 && header[0] == 0xff && header[1] == 0xd8;
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
    if (argc != 2) {
        std::wcerr << L"Expected the packaged FFmpeg runtime directory.\n";
        return 2;
    }
    const std::filesystem::path runtime(argv[1]);
    const std::filesystem::path ffmpeg = runtime / L"ffmpeg.exe";
    const auto unique = std::to_wstring(GetCurrentProcessId());
    const std::filesystem::path root = std::filesystem::temp_directory_path() /
        (L"oracle-replay-media-tests-" + unique);
    std::filesystem::remove_all(root);
    std::filesystem::create_directories(root);
    const std::filesystem::path source = root / L"source-prores.mov";
    const std::wstring generate =
        L"-hide_banner -loglevel error -y -f lavfi -i testsrc2=size=320x180:rate=30 "
        L"-f lavfi -i sine=frequency=440:sample_rate=48000 -t 0.75 "
        L"-c:v prores_ks -profile:v 4 -c:a aac " + Quote(source.native());
    if (!Run(ffmpeg, generate)) {
        std::wcerr << L"Could not generate the deterministic ProRes test fixture.\n";
        return 3;
    }

    oracle::replay_media::ReplayMediaService service(runtime);
    if (!service.IsAvailable()) {
        std::wcerr << L"Replay media service did not find the packaged runtime.\n";
        return 4;
    }
    oracle::replay_media::ReplayMediaRequest request;
    request.sourcePath = source.native();
    request.cacheDirectory = root.native();
    request.cacheKey = "0123456789abcdef0123456789abcdef";
    request.includePreview = true;
    request.thumbnailPositionSeconds = 0.3;
    request.cacheLimitMb = 128;

    std::mutex mutex;
    std::condition_variable ready;
    std::optional<oracle::replay_media::ReplayMediaResult> completed;
    const auto requestId = service.PrepareAsync(request, [&](auto result) {
        {
            std::lock_guard lock(mutex);
            completed = std::move(result);
        }
        ready.notify_one();
    });
    {
        std::unique_lock lock(mutex);
        if (!ready.wait_for(lock, std::chrono::seconds(30), [&] { return completed.has_value(); })) {
            service.CancelRequest(requestId);
            std::wcerr << L"Replay media preparation timed out.\n";
            return 5;
        }
    }
    const auto& result = *completed;
    if (!result.ok || result.cancelled || !result.thumbnailReady || !result.previewReady) {
        std::cerr << "Replay media preparation failed: " << result.errorCode << " " << result.errorMessage << "\n";
        return 6;
    }
    if (result.sourceVideoCodec != "prores" || result.sourceAudioCodec != "aac" || !result.hasAudio) {
        std::cerr << "Source media probe did not report ProRes plus AAC.\n";
        return 7;
    }
    if (!std::filesystem::is_regular_file(result.thumbnailPath) ||
        !IsJpeg(result.thumbnailPath)) {
        std::cerr << "The generated thumbnail is not a readable JPEG.\n";
        return 8;
    }
    if (!std::filesystem::is_regular_file(result.previewPath) ||
        !ContainsAscii(result.previewPath, "avc1") ||
        !ContainsAscii(result.previewPath, "mp4a")) {
        std::cerr << "The generated preview is not H.264 plus AAC MP4.\n";
        return 9;
    }

    std::optional<oracle::replay_media::ReplayMediaResult> reused;
    service.PrepareAsync(request, [&](auto resultValue) {
        {
            std::lock_guard lock(mutex);
            reused = std::move(resultValue);
        }
        ready.notify_one();
    });
    {
        std::unique_lock lock(mutex);
        if (!ready.wait_for(lock, std::chrono::seconds(10), [&] { return reused.has_value(); })) return 10;
    }
    if (!reused->ok || !reused->thumbnailReused || !reused->previewReused) {
        std::cerr << "The fingerprinted replay media cache was not reused.\n";
        return 11;
    }
    service.Shutdown();
    std::filesystem::remove_all(root);
    return 0;
}
