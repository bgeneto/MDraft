@echo off
rem Convenience wrapper: cargo inside the MSVC x64 environment.
rem Usage: scripts\cargo-vcvars.cmd check --manifest-path src-tauri\Cargo.toml
call "%~dp0with-msvc.cmd" cargo %*
exit /b %ERRORLEVEL%
