/*
 * lunar-hidden-launcher — EXPERIMENTAL, UNVERIFIED (no Windows rig).
 *
 * Launches one child (a recording Dolphin) on a SEPARATE Win32 desktop, so it
 * can never show a window, take focus, or put a button on the taskbar — the
 * input desktop is the only visible one, and a taskbar is Explorer per desktop.
 * It is gated behind `hide: "desktop"` in the runner and is NOT the default; the
 * default Windows hiding is `windowsHide: true` on a RenderToMain window
 * (needs no native code). See docs/background-and-mute.md ("Windows").
 *
 * The runner spawns THIS with normal pipes and the child's argv, so Dolphin's
 * `--cout` frames flow straight back through our stdout into the runner's
 * readline. Node sees a normal child; all the desktop machinery is in here.
 *
 * What it does:
 *   1. CreateDesktop("LunarClipper-Recording") in the current window station.
 *   2. CreateProcess with STARTUPINFO.lpDesktop set to it, inheriting OUR std
 *      handles (STARTF_USESTDHANDLES), so stdout/stderr/stdin pass through.
 *   3. Put the child in a Job object with KILL_ON_JOB_CLOSE, so if this launcher
 *      dies (or Clipper does), Dolphin dies with it — no orphan holding the GPU.
 *   4. Opt the child out of power-QoS throttling (HighQoS): a hidden, muted
 *      process otherwise drops to the Low tier and E-cores at ~half speed.
 *   5. On a line "CLOSE" on OUR stdin, post WM_CLOSE to the child's windows on
 *      that desktop (the graceful stop that lets AVIDump finalise the .avi —
 *      taskkill from the default desktop cannot reach another desktop's windows).
 *   6. Exit with the child's exit code.
 *
 * Build (not run here; no cross-compiler installed): see build.sh / build.bat.
 * Keep the binary name and version resource stable and sign it with the
 * installer's certificate — a new unsigned CreateDesktop+CreateProcess exe is
 * the thing most likely to trip AV heuristics (HVNC pattern). Transparent name,
 * open source in this repo.
 */
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const wchar_t *DESKTOP_NAME = L"LunarClipper-Recording";

static volatile LONG g_closing = 0;
static DWORD g_child_pid = 0;
static HDESK g_desk = NULL;

/* Post WM_CLOSE to every top-level window of our child on the record desktop. */
static BOOL CALLBACK close_enum(HWND hwnd, LPARAM desk) {
    DWORD pid = 0;
    GetWindowThreadProcessId(hwnd, &pid);
    if (pid == g_child_pid) PostMessageW(hwnd, WM_CLOSE, 0, 0);
    (void)desk;
    return TRUE;
}

/* Reads our stdin; on a "CLOSE" line, graceful-stops the child. */
static DWORD WINAPI stdin_thread(LPVOID arg) {
    HANDLE in = (HANDLE)arg;
    char buf[256];
    DWORD got = 0;
    char line[512];
    size_t len = 0;
    while (ReadFile(in, buf, sizeof(buf), &got, NULL) && got > 0) {
        for (DWORD i = 0; i < got; i++) {
            char c = buf[i];
            if (c == '\n' || len + 1 >= sizeof(line)) {
                line[len] = 0;
                len = 0;
                /* trim CR */
                size_t n = strlen(line);
                if (n && line[n - 1] == '\r') line[n - 1] = 0;
                if (_stricmp(line, "CLOSE") == 0) {
                    InterlockedExchange(&g_closing, 1);
                    /* Act on the record desktop from a thread with no windows. */
                    HDESK d = g_desk;
                    if (d) {
                        SetThreadDesktop(d);
                        EnumDesktopWindows(d, close_enum, 0);
                    }
                }
            } else {
                line[len++] = c;
            }
        }
    }
    return 0;
}

/* Opt the child out of EXECUTION_SPEED / timer-resolution throttling. */
static void set_high_qos(HANDLE proc) {
    PROCESS_POWER_THROTTLING_STATE s;
    ZeroMemory(&s, sizeof(s));
    s.Version = PROCESS_POWER_THROTTLING_CURRENT_VERSION;
    s.ControlMask = PROCESS_POWER_THROTTLING_EXECUTION_SPEED | PROCESS_POWER_THROTTLING_IGNORE_TIMER_RESOLUTION;
    s.StateMask = 0; /* 0 = opt OUT of throttling (HighQoS) */
    SetProcessInformation(proc, ProcessPowerThrottling, &s, sizeof(s));
}

int wmain(int argc, wchar_t **argv) {
    if (argc < 2) {
        fwprintf(stderr, L"usage: lunar-hidden-launcher <exe> [args...]\n");
        return 2;
    }

    /* Rebuild a command line from argv[1..], quoting each argument. */
    size_t cap = 1;
    for (int i = 1; i < argc; i++) cap += wcslen(argv[i]) * 2 + 4;
    wchar_t *cmd = (wchar_t *)calloc(cap, sizeof(wchar_t));
    if (!cmd) return 3;
    for (int i = 1; i < argc; i++) {
        if (i > 1) wcscat(cmd, L" ");
        wcscat(cmd, L"\"");
        /* naive escaping of embedded quotes */
        for (const wchar_t *p = argv[i]; *p; p++) {
            if (*p == L'"') wcscat(cmd, L"\\");
            wchar_t two[2] = {*p, 0};
            wcscat(cmd, two);
        }
        wcscat(cmd, L"\"");
    }

    g_desk = CreateDesktopW(DESKTOP_NAME, NULL, NULL, 0, GENERIC_ALL, NULL);
    if (!g_desk) {
        fwprintf(stderr, L"CreateDesktop failed: %lu\n", GetLastError());
        return 4;
    }

    HANDLE job = CreateJobObjectW(NULL, NULL);
    if (job) {
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION jl;
        ZeroMemory(&jl, sizeof(jl));
        jl.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        SetInformationJobObject(job, JobObjectExtendedLimitInformation, &jl, sizeof(jl));
    }

    STARTUPINFOW si;
    ZeroMemory(&si, sizeof(si));
    si.cb = sizeof(si);
    wchar_t deskmut[64];
    swprintf(deskmut, 64, L"WinSta0\\%ls", DESKTOP_NAME);
    si.lpDesktop = deskmut;
    si.dwFlags = STARTF_USESTDHANDLES;
    si.hStdInput = GetStdHandle(STD_INPUT_HANDLE);
    si.hStdOutput = GetStdHandle(STD_OUTPUT_HANDLE);
    si.hStdError = GetStdHandle(STD_ERROR_HANDLE);

    PROCESS_INFORMATION pi;
    ZeroMemory(&pi, sizeof(pi));
    BOOL ok = CreateProcessW(NULL, cmd, NULL, NULL, TRUE,
                             CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT,
                             NULL, NULL, &si, &pi);
    free(cmd);
    if (!ok) {
        fwprintf(stderr, L"CreateProcess failed: %lu\n", GetLastError());
        return 5;
    }
    g_child_pid = pi.dwProcessId;
    if (job) AssignProcessToJobObject(job, pi.hProcess);
    set_high_qos(pi.hProcess);
    ResumeThread(pi.hThread);

    HANDLE th = CreateThread(NULL, 0, stdin_thread, GetStdHandle(STD_INPUT_HANDLE), 0, NULL);

    WaitForSingleObject(pi.hProcess, INFINITE);
    DWORD code = 0;
    GetExitCodeProcess(pi.hProcess, &code);

    if (th) { CloseHandle(th); }
    CloseHandle(pi.hThread);
    CloseHandle(pi.hProcess);
    if (job) CloseHandle(job);
    CloseHandle(g_desk);
    return (int)code;
}
