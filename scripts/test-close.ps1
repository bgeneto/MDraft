# Close the release build and prove the process actually exits.
#
#   .\scripts\test-close.ps1 [-Exe <path>] [-Doc <path>] [-TimeoutSeconds 12]
#
# Why this exists: the X button sends WM_CLOSE, Tauri delivers CloseRequested to
# the frontend, and the frontend's `onCloseRequested` wrapper then calls
# `window.destroy()`. That command is gated by the capability set, so a missing
# `core:window:allow-destroy` makes every close attempt fail silently: the
# window stays open and the only way out is killing the process. Nothing else in
# the test suite exercises this path, so it regressed unnoticed once already.
#
# Also checks that a clean exit writes the window-state file, which is how the
# app remembers its position and size.

param(
    [string]$Exe = "src-tauri\target\release\mdraft.exe",
    [string]$Doc = "samples\feature-tour.md",
    [int]$TimeoutSeconds = 12
)

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
$exePath = if ([IO.Path]::IsPathRooted($Exe)) { $Exe } else { Join-Path $root $Exe }
$docPath = if ([IO.Path]::IsPathRooted($Doc)) { $Doc } else { Join-Path $root $Doc }
$configDir = Join-Path $env:APPDATA "io.github.bernh.mdraft"
$stateFile = Join-Path $configDir ".window-state.json"

if (-not (Test-Path $exePath)) {
    Write-Error "not built: $exePath  (run: npm run dist)"
}

# A stale state file would make the position check pass for the wrong reason.
Remove-Item $stateFile -Force -ErrorAction SilentlyContinue

Get-Process mdraft -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 500

$failures = 0
function Check($label, $ok) {
    if ($ok) { Write-Host "  PASS  $label" -ForegroundColor Green }
    else { Write-Host "  FAIL  $label" -ForegroundColor Red; $script:failures++ }
}

Write-Host "launching $([IO.Path]::GetFileName($exePath))"
$proc = Start-Process -FilePath $exePath -ArgumentList "`"$docPath`"" -PassThru

# A launched copy holds target/release/mdraft.exe open, so leaving one
# behind makes the *next* `npm run dist` fail with "Access is denied" on a file
# it cannot replace. Every exit path from here has to go through the finally.
try {
    Start-Sleep -Seconds 15
    $live = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if (-not $live) {
        Write-Host "  FAIL  the application did not stay running" -ForegroundColor Red
        $failures++
    } else {
        $live.Refresh()
        Write-Host "  window title: '$($live.MainWindowTitle)'"

        # WM_CLOSE is exactly what the title-bar X and the taskbar Close send.
        $sent = $live.CloseMainWindow()
        Check "WM_CLOSE was delivered" ($sent -eq $true)

        $exited = $false
        for ($i = 1; $i -le ($TimeoutSeconds * 2); $i++) {
            Start-Sleep -Milliseconds 500
            if (-not (Get-Process -Id $proc.Id -ErrorAction SilentlyContinue)) {
                Write-Host "  exited after $($i * 500) ms"
                $exited = $true
                break
            }
        }
        Check "the process exits within $TimeoutSeconds s" $exited

        Check "a clean exit wrote .window-state.json" (Test-Path $stateFile)
        if (Test-Path $stateFile) {
            $state = Get-Content $stateFile -Raw | ConvertFrom-Json
            $entry = $state.main
            if ($entry) {
                Write-Host "  saved position/size: x=$($entry.x) y=$($entry.y) w=$($entry.width) h=$($entry.height)"
                Check "the saved size is sane" ($entry.width -gt 200 -and $entry.height -gt 200)
            } else {
                Write-Host "  state file has no 'main' window entry" -ForegroundColor Yellow
            }
        }
    }
} finally {
    $leftover = Get-Process -Id $proc.Id -ErrorAction SilentlyContinue
    if ($leftover) {
        Write-Host "  force-killing the leftover process" -ForegroundColor Yellow
        $leftover | Stop-Process -Force
        Start-Sleep -Milliseconds 300
    }
}

Write-Host ""
if ($failures -eq 0) { Write-Host "close test passed" -ForegroundColor Green; exit 0 }
Write-Host "$failures check(s) failed" -ForegroundColor Red
exit 1
