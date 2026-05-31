Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public class WinEnum {
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr h, StringBuilder sb, int max);
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    public delegate bool EnumProc(IntPtr h, IntPtr lp);
    [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lp);
    public static List<IntPtr> GetWTHandles() {
        var list = new List<IntPtr>();
        EnumWindows(delegate(IntPtr h, IntPtr lp) {
            if (!IsWindowVisible(h)) return true;
            uint pid; GetWindowThreadProcessId(h, out pid);
            try {
                var p = System.Diagnostics.Process.GetProcessById((int)pid);
                if (p.ProcessName.Equals("WindowsTerminal", StringComparison.OrdinalIgnoreCase))
                    list.Add(h);
            } catch {}
            return true;
        }, IntPtr.Zero);
        return list;
    }
}
"@

$organizer = 'C:\Users\Lloyd Gibbs\scripts\organize-native.exe'

$beforeHandles = [WinEnum]::GetWTHandles()

# agent-button spawn queue: if a spawn is pending, run its launcher (this wrapper already runs
# at Highest, so the window is truly elevated); otherwise open a blank admin session for manual use.
$adminQueue = "C:\Users\Lloyd Gibbs\.agent-button-spawns\admin-queue"
$bashExe = "C:\Program Files\Git\bin\bash.exe"
$pending = $null
if (Test-Path $adminQueue) {
    $pending = Get-ChildItem -Path $adminQueue -Filter '*.sh' -File -ErrorAction SilentlyContinue |
        Where-Object { ((Get-Date) - $_.LastWriteTime).TotalMinutes -lt 5 } |
        Sort-Object LastWriteTime | Select-Object -First 1
}
if ($pending -and (Test-Path $bashExe)) {
    $lm = $pending.FullName
    $launcherMsys = '/' + $lm.Substring(0, 1).ToLower() + ($lm.Substring(2) -replace '\\', '/')
    & $bashExe $launcherMsys 2>$null
    Remove-Item -LiteralPath $pending.FullName -Force -ErrorAction SilentlyContinue
    Remove-Item -LiteralPath ($pending.FullName -replace '\.sh$', '.prompt.txt') -Force -ErrorAction SilentlyContinue
} else {
    Start-Process wt.exe -ArgumentList '--window new -p "Claude Code (Admin)"'
}

# Find the new WT window handle, then organize with its PID in slot 0
$newHandle = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Milliseconds 300
    $nowHandles = [WinEnum]::GetWTHandles()
    foreach ($h in $nowHandles) {
        if ($h -notin $beforeHandles) { $newHandle = $h; break }
    }
    if ($newHandle) { break }
}

if ($newHandle) {
    Start-Process -FilePath $organizer -ArgumentList "auto $($newHandle.ToInt64())" -NoNewWindow
} else {
    Start-Process -FilePath $organizer -ArgumentList 'auto' -NoNewWindow
}

# Poll until that window handle is gone
if ($newHandle) {
    while ([WinEnum]::IsWindow($newHandle)) {
        Start-Sleep -Seconds 2
    }
    Start-Sleep -Milliseconds 300
    Start-Process -FilePath $organizer -ArgumentList 'auto' -NoNewWindow
}
