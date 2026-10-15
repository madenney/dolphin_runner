@echo off
REM Build lunar-hidden-launcher.exe on Windows with MSVC (x64 Native Tools prompt).
REM From Linux, build.sh cross-compiles the same source with zig or mingw-w64.
if not exist "%~dp0bin" mkdir "%~dp0bin"
rc /nologo /fo "%~dp0bin\hidden_launcher.res" "%~dp0hidden_launcher.rc" || exit /b 1
cl /nologo /O2 /DUNICODE /D_UNICODE "%~dp0hidden_launcher.c" "%~dp0bin\hidden_launcher.res" /Fe"%~dp0bin\lunar-hidden-launcher.exe" /link /SUBSYSTEM:WINDOWS user32.lib kernel32.lib
del "%~dp0bin\hidden_launcher.res" "%~dp0hidden_launcher.obj" 2>nul
