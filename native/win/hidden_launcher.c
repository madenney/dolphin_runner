/*
 * lunar-hidden-launcher: start one program (a recording Dolphin) on a SEPARATE,
 * never-shown Win32 desktop, so it cannot put a window on screen, take the
 * foreground or keyboard focus, or show a taskbar button. Used by
 * dolphin_runner's `hide: "desktop"` (docs/background-and-mute.md, "Windows").
 *
 *   lunar-hidden-launcher.exe "C:\...\Slippi Dolphin.exe" -u ... -e ... -i ... --cout
 *
 * Everything after our own argv[0] goes to CreateProcess UNTOUCHED (the raw
 * command-line tail), so the caller's quoting survives exactly as Node wrote it.
 *
 *   1. CreateDesktop(<name>) in the current window station (WinSta0). The name is
 *      LUNAR_HIDDEN_DESKTOP if set, else "LunarRec-<launcher pid>": one per launch,
 *      so parallel recordings never share (or close) each other's desktop.
 *   2. CreateProcess with STARTUPINFO.lpDesktop = WinSta0\<name>, inheriting our std
 *      handles, so Dolphin's --cout frames flow straight back to the caller's pipe.
 *   3. A Job object with KILL_ON_JOB_CLOSE: if the launcher dies (taskkill /F, the
 *      host app crashing), Dolphin dies with it.
 *   4. HighQoS for the child: Windows moves a process with no visible window and
 *      no audio to the low-QoS tier (E-cores on hybrid CPUs).
 *   5. Graceful stop: `taskkill /pid <launcher> /T` (no /F) posts WM_CLOSE to the
 *      tree's top-level windows, but cannot see windows on another desktop. So the
 *      launcher owns an invisible top-level window on the caller's desktop and
 *      relays its WM_CLOSE to the child's windows on the hidden desktop: Dolphin
 *      stops and AVIDump finalises the .avi. A "CLOSE" line on stdin does the same.
 *   6. Exits with the child's exit code once the child is gone; the desktop goes
 *      away with its last handle.
 *
 * Own exit codes: 90 bad usage, 91 CreateDesktop failed, 92 CreateProcess failed.
 * One stderr line at start: "lunar-hidden-launcher: pid <n> desktop <name>".
 *
 * Build: build.sh (zig cc or mingw-w64, cross from Linux) or build.bat (MSVC).
 * Antivirus: CreateDesktop + CreateProcess(lpDesktop) is also what "hidden VNC"
 * malware does, so an unsigned copy can trip heuristics. Ship it signed with the
 * host app's certificate, under a stable name, with this source beside it.
 */
#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

typedef struct {
    ULONG Version, ControlMask, StateMask;
} LUNAR_POWER_THROTTLING_STATE;
#define LUNAR_THROTTLE_VERSION 1
#define LUNAR_THROTTLE_EXECUTION_SPEED 0x1
#define LUNAR_THROTTLE_IGNORE_TIMER_RESOLUTION 0x4
#define LUNAR_ProcessPowerThrottling 4 /* PROCESS_INFORMATION_CLASS */

typedef BOOL(WINAPI *SetProcessInformationFn)(HANDLE, int, LPVOID, DWORD);

static HDESK g_desk = NULL;
static DWORD g_child_pid = 0;
static volatile LONG g_relays = 0;
static HANDLE g_err = NULL;

static void say(const char *fmt, ...) {
    char msg[512];
    va_list ap;
    va_start(ap, fmt);
    int n = _vsnprintf(msg, sizeof(msg) - 1, fmt, ap);
    va_end(ap);
    if (n < 0) n = (int)sizeof(msg) - 1;
    msg[n] = 0;
    DWORD wrote;
    if (g_err && g_err != INVALID_HANDLE_VALUE) WriteFile(g_err, msg, (DWORD)n, &wrote, NULL);
}

static BOOL CALLBACK close_enum(HWND hwnd, LPARAM unused) {
    DWORD pid = 0;
    (void)unused;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == g_child_pid) PostMessageW(hwnd, WM_CLOSE, 0, 0);
    return TRUE;
}

/* WM_CLOSE to every top-level window of the child on the hidden desktop. */
static void relay_close(void) {
    InterlockedIncrement(&g_relays);
    if (g_desk) EnumDesktopWindows(g_desk, close_enum, 0);
}

static LRESULT CALLBACK catcher_proc(HWND h, UINT msg, WPARAM w, LPARAM l) {
    if (msg == WM_CLOSE) {
        relay_close();
        return 0; /* never destroyed by a close: we exit with the child */
    }
    if (msg == WM_QUERYENDSESSION) {
        relay_close();
        return TRUE;
    }
    return DefWindowProcW(h, msg, w, l);
}

static DWORD WINAPI stdin_thread(LPVOID arg) {
    HANDLE in = (HANDLE)arg;
    char buf[256], line[64];
    DWORD got = 0;
    size_t len = 0;
    while (ReadFile(in, buf, sizeof(buf), &got, NULL) && got > 0) {
        for (DWORD i = 0; i < got; i++) {
            char c = buf[i];
            if (c == '\n') {
                while (len && (line[len - 1] == '\r' || line[len - 1] == ' ')) len--;
                line[len] = 0;
                if (lstrcmpiA(line, "CLOSE") == 0) relay_close();
                len = 0;
            } else if (len + 1 < sizeof(line)) {
                line[len++] = c;
            }
        }
    }
    return 0;
}

/* The raw command line after argv[0], exactly as the caller quoted it. */
static const wchar_t *arg_tail(const wchar_t *cl) {
    const wchar_t *p = cl;
    if (*p == L'"') {
        p++;
        while (*p && *p != L'"') p++;
        if (*p == L'"') p++;
    } else {
        while (*p && *p != L' ' && *p != L'\t') p++;
    }
    while (*p == L' ' || *p == L'\t') p++;
    return p;
}

/* The child's folder (its first, possibly quoted, token minus the file name). */
static void child_dir(const wchar_t *cmd, wchar_t *out, size_t cap) {
    size_t k = 0;
    const wchar_t *p = cmd;
    if (*p == L'"') {
        p++;
        while (*p && *p != L'"' && k + 1 < cap) out[k++] = *p++;
    } else {
        while (*p && *p != L' ' && *p != L'\t' && k + 1 < cap) out[k++] = *p++;
    }
    out[k] = 0;
    wchar_t *slash = wcsrchr(out, L'\\');
    if (slash) *slash = 0;
    else out[0] = 0;
}

int WINAPI wWinMain(HINSTANCE inst, HINSTANCE prev, LPWSTR unusedCmd, int show) {
    (void)prev;
    (void)unusedCmd;
    (void)show;
    g_err = GetStdHandle(STD_ERROR_HANDLE);

    const wchar_t *tail = arg_tail(GetCommandLineW());
    if (!*tail) {
        say("usage: lunar-hidden-launcher <exe> [args...]\n");
        return 90;
    }
    size_t tlen = wcslen(tail);
    wchar_t *cmd = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, (tlen + 1) * sizeof(wchar_t));
    if (!cmd) return 90;
    memcpy(cmd, tail, (tlen + 1) * sizeof(wchar_t));

    wchar_t name[80];
    DWORD n = GetEnvironmentVariableW(L"LUNAR_HIDDEN_DESKTOP", name, 64);
    if (n == 0 || n >= 64) _snwprintf(name, 79, L"LunarRec-%lu", (unsigned long)GetCurrentProcessId());
    name[79] = 0;

    g_desk = CreateDesktopW(name, NULL, NULL, 0, GENERIC_ALL, NULL);
    if (!g_desk) {
        say("lunar-hidden-launcher: CreateDesktop failed: %lu\n", (unsigned long)GetLastError());
        return 91;
    }

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    wchar_t deskpath[100];
    _snwprintf(deskpath, 99, L"WinSta0\\%ls", name);
    deskpath[99] = 0;
    si.lpDesktop = deskpath;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = g_err;
    HANDLE std3[3] = {si.hStdInput, si.hStdOutput, si.hStdError};
    for (int i = 0; i < 3; i++)
        if (std3[i] && std3[i] != INVALID_HANDLE_VALUE) SetHandleInformation(std3[i], HANDLE_FLAG_INHERIT, HANDLE_FLAG_INHERIT);

    wchar_t cwd[MAX_PATH];
    child_dir(cmd, cwd, MAX_PATH);

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    if (!CreateProcessW(NULL, cmd, NULL, NULL, TRUE, CREATE_SUSPENDED, NULL, cwd[0] ? cwd : NULL, &si, &pi)) {
        say("lunar-hidden-launcher: CreateProcess failed: %lu\n", (unsigned long)GetLastError());
        CloseDesktop(g_desk);
        return 92;
    }
    g_child_pid = pi.dwProcessId;

    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jl;
        ZeroMemory(&jl, sizeof(jl));
        jl.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jl, sizeof(jl));
        if (!AssignProcessToJobObject(job, pi.hProcess))
            say("lunar-hidden-launcher: no job object (%lu)\n", (unsigned long)GetLastError());
    }

    /* HighQoS, looked up at runtime (Windows 8+). */
    SetProcessInformationFn spi =
        (SetProcessInformationFn)(void *)GetProcAddress(GetModuleHandleW(L"kernel32.dll"), "SetProcessInformation");
    if (spi) {
        LUNAR_POWER_THROTTLING_STATE s;
        s.Version = LUNAR_THROTTLE_VERSION;
        s.ControlMask = LUNAR_THROTTLE_EXECUTION_SPEED | LUNAR_THROTTLE_IGNORE_TIMER_RESOLUTION;
        s.StateMask = 0; /* 0 = not throttled */
        spi(pi.hProcess, LUNAR_ProcessPowerThrottling, &s, sizeof(s));
    }

    say("lunar-hidden-launcher: pid %lu desktop %ls\n", (unsigned long)pi.dwProcessId, name);
    ResumeThread(pi.hThread);
    CloseHandle(pi.hThread);

    /* The close catcher: top-level (so taskkill finds it), never visible. */
    WNDCLASSW wc;
    ZeroMemory(&wc, sizeof(wc));
    wc.lpfnWndProc = catcher_proc;
    wc.hInstance = inst;
    wc.lpszClassName = L"LunarHiddenLauncher";
    RegisterClassW(&wc);
    CreateWindowExW(WS_EX_TOOLWINDOW, wc.lpszClassName, L"lunar-hidden-launcher", WS_OVERLAPPED, 0, 0, 0, 0, NULL, NULL,
                    inst, NULL);

    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);
    if (in && in != INVALID_HANDLE_VALUE && GetFileType(in) == FILE_TYPE_PIPE) {
        HANDLE th = CreateThread(NULL, 0, stdin_thread, in, 0, NULL);
        if (th) CloseHandle(th);
    }

    for (;;) {
        DWORD r = MsgWaitForMultipleObjects(1, &pi.hProcess, FALSE, INFINITE, QS_ALLINPUT);
        if (r != WAIT_OBJECT_0 + 1) break; /* the child exited (or the wait failed) */
        MSG m;
        while (PeekMessageW(&m, NULL, 0, 0, PM_REMOVE)) {
            TranslateMessage(&m);
            DispatchMessageW(&m);
        }
    }
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);
    if (g_relays) say("lunar-hidden-launcher: relayed WM_CLOSE %ldx\n", (long)g_relays);
    CloseHandle(pi.hProcess);
    if (job) CloseHandle(job);
    CloseDesktop(g_desk);
    return (int)code;
}
