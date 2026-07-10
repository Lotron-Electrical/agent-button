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
#
# The task is registered MultipleInstances=Parallel and the poller fires one trigger per queued
# spawn, so several copies of this script can be running at once. Picking a launcher by listing
# the queue and then using the result is a check-then-use race: two instances both select the
# oldest file, both run it, and the second launcher is never claimed (observed 2026-07-10 — one
# button press produced two identical agents plus one orphaned launcher).
#
# Claiming is therefore an exclusive create of a <name>.claim marker. FileMode::CreateNew maps to
# NTFS FILE_CREATE, which fails if the name already exists, so exactly one instance can win a
# given launcher and the losers fall through to the next one. Do NOT "claim" by renaming the
# launcher instead: File::Move is not exclusive here — measured on this box, two processes racing
# 400 renames both reported success on 61 of them, which is precisely the duplicate-agent bug.
$adminQueue = "C:\Users\Lloyd Gibbs\.agent-button-spawns\admin-queue"
$claimDir = Join-Path $adminQueue 'claimed'
$bashExe = "C:\Program Files\Git\bin\bash.exe"
$pending = $null       # the launcher this instance claimed (still in the queue dir)
$promptSrc = $null     # its prompt file — the launcher cats it by absolute path
$sawCandidate = $false # a launcher was there, even if a sibling instance won the race for it
if (Test-Path $adminQueue) {
    if (-not (Test-Path $claimDir)) { New-Item -ItemType Directory -Path $claimDir -Force | Out-Null }

    # A launcher past the 5-minute freshness window can never run again, and a marker left behind
    # by a crashed instance would block its launcher's name forever. Collect both.
    Get-ChildItem -Path $adminQueue -File -ErrorAction SilentlyContinue |
        Where-Object { ($_.Name -like '*.sh' -or $_.Name -like '*.prompt.txt') -and ((Get-Date) - $_.LastWriteTime).TotalMinutes -gt 60 } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }
    Get-ChildItem -Path $claimDir -File -ErrorAction SilentlyContinue |
        Where-Object { ((Get-Date) - $_.LastWriteTime).TotalMinutes -gt 60 } |
        ForEach-Object { Remove-Item -LiteralPath $_.FullName -Force -ErrorAction SilentlyContinue }

    $cands = @(Get-ChildItem -Path $adminQueue -File -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -like '*.sh' -and ((Get-Date) - $_.LastWriteTime).TotalMinutes -lt 5 } |
        Sort-Object LastWriteTime)
    $sawCandidate = ($cands.Count -gt 0)
    foreach ($c in $cands) {
        try {
            $h = [System.IO.File]::Open((Join-Path $claimDir ($c.Name + '.claim')),
                 [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
            $h.Close()
        } catch { continue }   # a sibling instance owns this launcher
        $pending = $c
        $promptSrc = Join-Path $adminQueue ($c.BaseName + '.prompt.txt')
        break
    }
}
if (-not $pending) {
    # Two ways to arrive here with nothing to run, and only one of them wants a blank window.
    # $sawCandidate means a sibling won every launcher we saw. But a sibling that claims BETWEEN
    # our scan and its own claim leaves us seeing an empty queue instead, so an empty queue alone
    # does not prove this was a manual launch: a marker written seconds ago means a spawn just
    # happened and we are a surplus trigger. Only a genuinely quiet queue opens a blank session.
    $justClaimed = @(Get-ChildItem -Path $claimDir -File -ErrorAction SilentlyContinue |
        Where-Object { ((Get-Date) - $_.LastWriteTime).TotalSeconds -lt 20 }).Count -gt 0
    if ($sawCandidate -or $justClaimed) { exit 0 }
}
if ($pending -and (Test-Path $bashExe)) {
    $lm = $pending.FullName
    $launcherMsys = '/' + $lm.Substring(0, 1).ToLower() + ($lm.Substring(2) -replace '\\', '/')
    & $bashExe $launcherMsys 2>$null
    # Launcher and prompt have both been consumed by now; the .claim marker stays behind so a
    # concurrent scan can't re-run this launcher, and the age purge above collects it later.
    Remove-Item -LiteralPath $pending.FullName -Force -ErrorAction SilentlyContinue
    if ($promptSrc) { Remove-Item -LiteralPath $promptSrc -Force -ErrorAction SilentlyContinue }

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
