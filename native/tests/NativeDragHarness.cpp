#include "NativeDragCore.h"

#include <ShlObj.h>
#include <Shellapi.h>
#include <windowsx.h>

#include <cmath>
#include <string>

namespace {

struct HarnessState {
    std::wstring path;
    POINT dragOrigin{};
    bool pressed = false;
    bool dragStarted = false;
    std::wstring result = L"Hold the left button here, move 5 px, then drop on Premiere's Timeline.";
};

void BeginShellDrag(HWND window, HarnessState& state) {
    state.dragStarted = true;
    state.pressed = false;
    ReleaseCapture();

    IDataObject* dataObject = nullptr;
    const HRESULT objectResult = oracle::native_drag::CreateShellFileDataObject(state.path, &dataObject);
    if (FAILED(objectResult) || !dataObject) {
        state.result = L"Shell IDataObject failed: 0x" + std::to_wstring(static_cast<unsigned long>(objectResult));
        InvalidateRect(window, nullptr, TRUE);
        return;
    }

    DWORD effect = DROPEFFECT_NONE;
    const HRESULT dragResult = SHDoDragDrop(window, dataObject, nullptr, DROPEFFECT_COPY, &effect);
    dataObject->Release();
    state.result = L"SHDoDragDrop returned HRESULT=" +
        std::to_wstring(static_cast<long>(dragResult)) +
        L" effect=" + std::to_wstring(effect);
    InvalidateRect(window, nullptr, TRUE);
}

LRESULT CALLBACK HarnessWindowProcedure(HWND window, UINT message, WPARAM wParam, LPARAM lParam) {
    auto* state = reinterpret_cast<HarnessState*>(GetWindowLongPtrW(window, GWLP_USERDATA));
    switch (message) {
    case WM_NCCREATE: {
        const auto* create = reinterpret_cast<CREATESTRUCTW*>(lParam);
        SetWindowLongPtrW(window, GWLP_USERDATA, reinterpret_cast<LONG_PTR>(create->lpCreateParams));
        return TRUE;
    }
    case WM_LBUTTONDOWN:
        if (state) {
            state->pressed = true;
            state->dragStarted = false;
            state->dragOrigin = {GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam)};
            SetCapture(window);
        }
        return 0;
    case WM_MOUSEMOVE:
        if (state && state->pressed && !state->dragStarted && (wParam & MK_LBUTTON) != 0) {
            const int deltaX = GET_X_LPARAM(lParam) - state->dragOrigin.x;
            const int deltaY = GET_Y_LPARAM(lParam) - state->dragOrigin.y;
            if (deltaX * deltaX + deltaY * deltaY >= 25) {
                BeginShellDrag(window, *state);
            }
        }
        return 0;
    case WM_LBUTTONUP:
        if (state) {
            state->pressed = false;
            ReleaseCapture();
        }
        return 0;
    case WM_PAINT:
        if (state) {
            PAINTSTRUCT paint{};
            HDC context = BeginPaint(window, &paint);
            RECT bounds{};
            GetClientRect(window, &bounds);
            SetBkMode(context, TRANSPARENT);
            DrawTextW(context, state->path.c_str(), -1, &bounds, DT_CENTER | DT_TOP | DT_END_ELLIPSIS | DT_SINGLELINE);
            bounds.top += 42;
            DrawTextW(context, state->result.c_str(), -1, &bounds, DT_CENTER | DT_WORDBREAK);
            EndPaint(window, &paint);
        }
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    default:
        return DefWindowProcW(window, message, wParam, lParam);
    }
}

}  // namespace

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE, PWSTR, int showCommand) {
    int argumentCount = 0;
    LPWSTR* arguments = CommandLineToArgvW(GetCommandLineW(), &argumentCount);
    if (!arguments || argumentCount != 2) {
        MessageBoxW(nullptr, L"Usage: oracle-native-drag-harness.exe <absolute-file-path>", L"Blocky Studios native drag harness", MB_ICONERROR);
        if (arguments) LocalFree(arguments);
        return 2;
    }
    HarnessState state;
    state.path = arguments[1];
    LocalFree(arguments);

    const auto validation = oracle::native_drag::ValidateAbsoluteFilePath(state.path);
    if (!validation.ok) {
        MessageBoxA(nullptr, validation.errorMessage.c_str(), "Blocky Studios native drag harness", MB_ICONERROR);
        return 3;
    }

    const HRESULT oleResult = OleInitialize(nullptr);
    if (FAILED(oleResult)) {
        MessageBoxW(nullptr, L"OleInitialize failed.", L"Blocky Studios native drag harness", MB_ICONERROR);
        return 4;
    }

    const wchar_t* className = L"OracleNativeDragHarnessWindow";
    WNDCLASSW windowClass{};
    windowClass.hInstance = instance;
    windowClass.lpfnWndProc = HarnessWindowProcedure;
    windowClass.lpszClassName = className;
    windowClass.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    windowClass.hbrBackground = reinterpret_cast<HBRUSH>(COLOR_WINDOW + 1);
    RegisterClassW(&windowClass);

    HWND window = CreateWindowExW(
        WS_EX_TOOLWINDOW,
        className,
        L"Blocky Studios native drag isolation harness (development only)",
        WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU,
        CW_USEDEFAULT,
        CW_USEDEFAULT,
        560,
        180,
        nullptr,
        nullptr,
        instance,
        &state);
    if (!window) {
        OleUninitialize();
        return 5;
    }
    ShowWindow(window, showCommand);
    UpdateWindow(window);

    MSG message{};
    while (GetMessageW(&message, nullptr, 0, 0) > 0) {
        TranslateMessage(&message);
        DispatchMessageW(&message);
    }
    OleUninitialize();
    return static_cast<int>(message.wParam);
}
