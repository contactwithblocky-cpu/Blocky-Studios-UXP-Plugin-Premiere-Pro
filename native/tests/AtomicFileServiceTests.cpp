#include "AtomicFileService.h"

#include <Windows.h>

#include <filesystem>
#include <fstream>
#include <iostream>
#include <stdexcept>
#include <string>

using oracle::atomic_file::WriteOracleStateAtomically;

namespace {

void Require(bool condition, const char* message) {
    if (!condition) throw std::runtime_error(message);
}

std::string Read(const std::filesystem::path& path) {
    std::ifstream stream(path, std::ios::binary);
    return std::string(std::istreambuf_iterator<char>(stream), std::istreambuf_iterator<char>());
}

void TestDurableReplaceAndBackup() {
    const auto directory = std::filesystem::temp_directory_path() /
        (L"oracle atomic state 雪 " + std::to_wstring(GetCurrentProcessId()));
    std::filesystem::remove_all(directory);
    std::filesystem::create_directories(directory);
    const auto primary = directory / L"oracle-state.v3.json";
    const auto temporary = directory / L"oracle-state.v3.tmp.json";
    const auto backup = directory / L"oracle-state.v3.backup.json";
    const std::string first = R"({"revision":1,"name":"Unicode \u96ea"})";
    const std::string second = R"({"revision":2,"favorite":true})";

    const auto firstResult = WriteOracleStateAtomically(
        primary.wstring(), temporary.wstring(), backup.wstring(), first);
    Require(firstResult.ok, "first atomic state write failed");
    Require(!firstResult.backupCreated, "first write unexpectedly created a backup");
    Require(Read(primary) == first, "first primary content changed");
    Require(!std::filesystem::exists(temporary), "first write left a staged file");

    const auto secondResult = WriteOracleStateAtomically(
        primary.wstring(), temporary.wstring(), backup.wstring(), second);
    Require(secondResult.ok, "replacement atomic state write failed");
    Require(secondResult.backupCreated, "replacement did not create a last-known-good backup");
    Require(Read(primary) == second, "replacement primary content changed");
    Require(Read(backup) == first, "backup is not the prior committed primary");
    Require(!std::filesystem::exists(temporary), "replacement left a staged file");
    std::filesystem::remove_all(directory);
}

void TestValidationAndFailurePreservePrimary() {
    const auto directory = std::filesystem::temp_directory_path() /
        (L"oracle atomic state guards " + std::to_wstring(GetCurrentProcessId()));
    std::filesystem::remove_all(directory);
    std::filesystem::create_directories(directory);
    const auto primary = directory / L"oracle-state.v3.json";
    const auto temporary = directory / L"oracle-state.v3.tmp.json";
    const auto backup = directory / L"oracle-state.v3.backup.json";
    Require(WriteOracleStateAtomically(
        primary.wstring(), temporary.wstring(), backup.wstring(), "{\"revision\":1}").ok,
        "guard baseline write failed");

    const auto wrongName = WriteOracleStateAtomically(
        primary.wstring(), (directory / L"other.tmp").wstring(), backup.wstring(), "{}");
    Require(!wrongName.ok && wrongName.errorCode == "INVALID_STATE_PATH", "unexpected file name was accepted");
    Require(Read(primary) == "{\"revision\":1}", "validation failure changed the primary");

    HANDLE lock = CreateFileW(
        primary.c_str(),
        GENERIC_READ,
        FILE_SHARE_READ,
        nullptr,
        OPEN_EXISTING,
        FILE_ATTRIBUTE_NORMAL,
        nullptr);
    Require(lock != INVALID_HANDLE_VALUE, "could not lock primary for failure test");
    const auto locked = WriteOracleStateAtomically(
        primary.wstring(), temporary.wstring(), backup.wstring(), "{\"revision\":2}");
    CloseHandle(lock);
    Require(!locked.ok, "locked primary replacement unexpectedly succeeded");
    Require(Read(primary) == "{\"revision\":1}", "failed replacement lost the committed primary");
    Require(!std::filesystem::exists(temporary), "failed replacement left staged bytes");
    std::filesystem::remove_all(directory);
}

}  // namespace

int wmain() {
    try {
        TestDurableReplaceAndBackup();
        TestValidationAndFailurePreservePrimary();
        std::wcout << L"oracle atomic file service tests passed\n";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "oracle atomic file service test failure: " << error.what() << '\n';
        return 1;
    }
}
