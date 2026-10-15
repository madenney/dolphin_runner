@echo off
REM Build the experimental Windows hidden-desktop launcher on Windows itself.
REM EXPERIMENTAL - see hidden_launcher.c. Use the MSVC x64 Native Tools prompt.
if not exist "%~dp0dist" mkdir "%~dp0dist"
cl /nologo /O2 /DUNICODE /D_UNICODE "%~dp0hidden_launcher.c" /Fe"%~dp0dist\lunar-hidden-launcher.exe" user32.lib advapi32.lib
