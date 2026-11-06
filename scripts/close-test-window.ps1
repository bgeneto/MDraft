param([Parameter(Mandatory = $true)][int]$ProcessId)

$process = Get-Process -Id $ProcessId -ErrorAction SilentlyContinue
if (-not $process -or $process.Path -notmatch '[\\/]mdraft-test-[^\\/]+[\\/]mdraft\.exe$') {
    throw "Refusing to close a process outside the MDraft test staging directory."
}
Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class MDraftTestClose {
  public delegate bool EnumProc(IntPtr window, IntPtr parameter);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr parameter);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr window, uint message, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr window, StringBuilder name, int size);
}
'@
[void][MDraftTestClose]::EnumWindows({
    param($window, $unused)
    $owner = 0
    [void][MDraftTestClose]::GetWindowThreadProcessId($window, [ref]$owner)
    $class = [Text.StringBuilder]::new(256)
    [void][MDraftTestClose]::GetClassName($window, $class, 256)
    if ($owner -eq $ProcessId -and $class.ToString() -eq 'Tauri Window') {
        [void][MDraftTestClose]::PostMessage($window, 0x10, [IntPtr]::Zero, [IntPtr]::Zero)
    }
    return $true
}, [IntPtr]::Zero)
