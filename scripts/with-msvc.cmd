@echo off
rem Run any command inside a Visual Studio x64 developer environment.
rem
rem Rust discovers the MSVC toolchain and the Windows SDK through the registry.
rem On this machine that discovery does not resolve the SDK include/lib folders
rem (the SDK registers ProductVersion 10.0.26100 while the folder on disk is
rem 10.0.26100.0), so cl.exe cannot find windows.h and link.exe cannot find
rem kernel32.lib. Loading vcvars64.bat exports INCLUDE/LIB/PATH explicitly and
rem both problems disappear.
rem
rem NOTE: every "if" below is deliberately a single line. Wrapping them in a
rem parenthesised block breaks because the Visual Studio paths contain "(x86)".
rem
rem Usage: scripts\with-msvc.cmd npm run tauri build

setlocal

set "VSROOT=%ProgramFiles(x86)%\Microsoft Visual Studio"
set "VSROOT64=%ProgramFiles%\Microsoft Visual Studio"

set "VCVARS="
if not defined VCVARS if exist "%VSROOT%\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%VSROOT%\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "%VSROOT%\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%VSROOT%\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "%VSROOT%\18\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%VSROOT%\18\Community\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "%VSROOT%\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%VSROOT%\2022\Community\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "%VSROOT64%\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%VSROOT64%\18\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "%VSROOT64%\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%VSROOT64%\2022\BuildTools\VC\Auxiliary\Build\vcvars64.bat"
if not defined VCVARS if exist "%VSROOT64%\2022\Community\VC\Auxiliary\Build\vcvars64.bat" set "VCVARS=%VSROOT64%\2022\Community\VC\Auxiliary\Build\vcvars64.bat"

if not defined VCVARS goto :novcvars
if "%TYT_QUIET%"=="" echo [with-msvc] "%VCVARS%"

call "%VCVARS%" >nul
if errorlevel 1 goto :vcvarsfailed

%*
exit /b %ERRORLEVEL%

:novcvars
echo [with-msvc] Could not find vcvars64.bat. Install the Visual Studio C++ build tools. 1>&2
exit /b 1

:vcvarsfailed
echo [with-msvc] vcvars64.bat failed: "%VCVARS%" 1>&2
exit /b 1
