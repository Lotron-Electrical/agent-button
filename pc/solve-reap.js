// solve-reap.js — reap superseded agent-button solve-relay tabs.
//
// A "never give up" solve relay (sv<id>) spawns one Windows Terminal tab per
// generation, named sv<id>-g<N>. On every hand-off the previous generation stops
// working, but its interactive Claude session keeps running idle in its own tab — so
// finished tabs pile up. This closes a superseded generation's tab once a strictly
// NEWER generation of the same relay is confirmed RUNNING.
//
// "Confirmed running" = a live session named sv<id>-g<M> (M > N) exists in the
// ~/.claude/sessions registry AND has been up > NEWEST_MIN_AGE_MS (long enough to have
// read the shared handover and started). We key on the live session registry (not the
// worker's generation counter) on purpose: it guarantees the successor is actually
// alive before we close the predecessor, so a failed/crashed spawn never breaks the chain.
//
// Closing walks up to the WindowsTerminal tab-root via scripts/close-tab-for-pid.ps1 and
// taskkills it (tab + shell + claude + MCP). The WT profile has closeOnExit:"always",
// so the tab closes cleanly — no "process exited" husk.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const SESS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const CLOSER = path.join(__dirname, 'close-tab-for-pid.ps1');
const NEWEST_MIN_AGE_MS = 30 * 1000;   // a successor must be up this long before we reap older gens
const STARTUP_GRACE_MS = 60 * 1000;    // never reap in the first minute after this module loads (poller restart settle window)
const RETRY_MS = 15 * 1000;            // don't re-issue a close for the same pid more often than this

const START = Date.now();

function alivePid(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

// Scan the live session registry; return which superseded solve gens are reapable.
// { bySolve: {solveId:[{gen,pid,...}]}, reap: [{pid,name,gen,supersededBy}] }
function findSuperseded(now) {
  now = now || Date.now();
  let files = [];
  try { files = fs.readdirSync(SESS_DIR).filter((f) => f.endsWith('.json')); } catch (_) { return { bySolve: {}, reap: [] }; }
  const bySolve = {};
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(SESS_DIR, f), 'utf8')); } catch (_) { continue; }
    if (!d || !d.pid || !alivePid(d.pid)) continue;
    const nm = String(d.name || '').replace(/^claude-tab:/, '').replace(/_$/, '');
    const m = nm.match(/^(sv[0-9a-z]+)-g(\d+)$/i);
    if (!m) continue;
    let startedAt = typeof d.startedAt === 'number' ? d.startedAt : null;
    if (!startedAt) { try { startedAt = fs.statSync(path.join(SESS_DIR, f)).mtimeMs; } catch (_) { startedAt = 0; } }
    (bySolve[m[1]] = bySolve[m[1]] || []).push({ solveId: m[1], gen: parseInt(m[2], 10), pid: d.pid, name: nm, startedAt, status: d.status || null });
  }
  const reap = [];
  for (const sid of Object.keys(bySolve)) {
    const list = bySolve[sid];
    if (list.length < 2) continue;
    const maxGen = Math.max.apply(null, list.map((s) => s.gen));
    const newest = list.find((s) => s.gen === maxGen);
    if ((now - newest.startedAt) < NEWEST_MIN_AGE_MS) continue;   // successor not established yet — leave predecessors alone
    for (const s of list) {
      if (s.gen === maxGen) continue;                            // never close the newest (current worker)
      reap.push({ pid: s.pid, name: s.name, gen: s.gen, supersededBy: maxGen });
    }
  }
  return { bySolve, reap };
}

const _lastTry = new Map(); // pid -> last close attempt ms (avoid spamming taskkill on a slow close)

function closeSuperseded(opts) {
  opts = opts || {};
  const dryRun = !!opts.dryRun;
  const log = opts.log || console.log;
  const now = Date.now();
  if (!dryRun && (now - START) < STARTUP_GRACE_MS) return [];     // settle window after (re)start
  const { reap } = findSuperseded(now);
  for (const s of reap) {
    if (!dryRun) {
      if ((now - (_lastTry.get(s.pid) || 0)) < RETRY_MS) continue;
      _lastTry.set(s.pid, now);
    }
    log('solve cleanup: ' + (dryRun ? 'WOULD close' : 'closing') + ' superseded ' + s.name +
        ' (pid ' + s.pid + '; superseded by g' + s.supersededBy + ')');
    const args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', CLOSER, '-TargetPid', String(s.pid)];
    if (dryRun) args.push('-DryRun');
    try { const c = spawn('powershell', args, { stdio: 'ignore', detached: true }); c.unref(); }
    catch (e) { log('solve cleanup: spawn failed for pid ' + s.pid + ': ' + e.message); }
  }
  for (const pid of [..._lastTry.keys()]) if (!alivePid(pid)) _lastTry.delete(pid);
  return reap;
}

module.exports = { findSuperseded, closeSuperseded };

// CLI: `node solve-reap.js --dry-run` (report only) | `node solve-reap.js` (close for real)
if (require.main === module) {
  const dry = process.argv.includes('--dry-run') || process.argv.includes('-n');
  const { bySolve, reap } = findSuperseded();
  const ids = Object.keys(bySolve);
  console.log('live solve sessions by relay:' + (ids.length ? '' : ' (none)'));
  for (const sid of ids) {
    console.log('  ' + sid + ': ' + bySolve[sid]
      .sort((a, b) => a.gen - b.gen)
      .map((s) => 'g' + s.gen + '(pid ' + s.pid + ', up ' + Math.round((Date.now() - s.startedAt) / 1000) + 's, ' + (s.status || '?') + ')')
      .join(', '));
  }
  if (!reap.length) { console.log('nothing reapable right now.'); process.exit(0); }
  console.log((dry ? 'WOULD reap: ' : 'reaping: ') + reap.map((s) => s.name + '(pid ' + s.pid + ')').join(', '));
  if (!dry) { _lastTry.clear(); /* allow immediate CLI close */ const r = require('child_process');
    for (const s of reap) {
      try { const c = r.spawn('powershell', ['-NoProfile','-ExecutionPolicy','Bypass','-File',CLOSER,'-TargetPid',String(s.pid)], { stdio:'inherit', detached:true }); }
      catch (e) { console.log('close failed pid '+s.pid+': '+e.message); }
    }
  }
}
