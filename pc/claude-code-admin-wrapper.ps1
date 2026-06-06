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

    # --- Solve-relay generation reap (runs ELEVATED here) ---
    # A Solve relay spawns one tab per generation (sv<id>-g<N>). On each hand-off the
    # predecessor stops working but its interactive tab keeps running idle, so finished
    # generations pile up (g3+g4+g5 while only the newest works). The poller's reaper
    # can't fix this: it runs medium-integrity and a non-elevated taskkill on these
    # elevated tabs gets Access Denied. THIS wrapper runs at RunLevel Highest, and it
    # fires at exactly the moment a successor is born — so when the new spawn is a solve
    # generation, close every OLDER live generation (g<M>, M < N) of the SAME relay here.
    # Fully guarded: a reap failure must never block the spawn it just launched.
    try {
        $sm = [regex]::Match($pending.BaseName, '^(sv[0-9a-z]+)-g(\d+)$')
        if ($sm.Success) {
            $relayId = $sm.Groups[1].Value
            $newGen  = [int]$sm.Groups[2].Value
            $closer  = 'C:\Users\Lloyd Gibbs\Claude Projects\agent-button\pc\close-tab-for-pid.ps1'
            $sessDir = Join-Path $env:USERPROFILE '.claude\sessions'
            if ((Test-Path $closer) -and (Test-Path $sessDir)) {
                Get-ChildItem -Path $sessDir -Filter '*.json' -File -ErrorAction SilentlyContinue | ForEach-Object {
                    try { $d = Get-Content -LiteralPath $_.FullName -Raw -ErrorAction Stop | ConvertFrom-Json } catch { return }
                    if (-not $d.pid) { return }
                    $nm = ($d.name -replace '^claude-tab:', '') -replace '_$', ''
                    $gm = [regex]::Match($nm, ('^' + [regex]::Escape($relayId) + '-g(\d+)$'))
                    if (-not $gm.Success) { return }
                    if ([int]$gm.Groups[1].Value -ge $newGen) { return }          # never the newest / the gen we just spawned
                    if (-not (Get-Process -Id ([int]$d.pid) -ErrorAction SilentlyContinue)) { return }  # already gone
                    & powershell -NoProfile -ExecutionPolicy Bypass -File $closer -TargetPid ([int]$d.pid) 2>$null
                }
            }
        }
    } catch {}
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
