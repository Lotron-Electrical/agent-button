// agent-button PC poller
// Runs on Lloyd's Windows machine. Polls the Render relay for tasks the phone sent,
// and spawns N real Claude Code tabs via ~/scripts/claude-tab.sh, then acks back.
//
// Config: ~/.agent-button.env  (RELAY_URL, BUTTON_TOKEN, DEFAULT_CWD, CLAUDE_TAB)
// Run:    node pc/poller.js
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { closeSuperseded } = require('./solve-reap'); // reap superseded solve-relay tabs

// ---------- config ----------
const cfgPath = process.env.AGENT_BUTTON_ENV || path.join(os.homedir(), '.agent-button.env');
if (!fs.existsSync(cfgPath)) {
  console.error('Missing config: ' + cfgPath + '\nCopy pc/agent-button.env.example to it and fill in RELAY_URL + BUTTON_TOKEN.');
  process.exit(1);
}
const cfg = {};
for (const line of fs.readFileSync(cfgPath, 'utf8').split(/\r?\n/)) {
  const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*)$/);
  if (m) cfg[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
}
const RELAY = (cfg.RELAY_URL || '').replace(/\/$/, '');
const TOKEN = cfg.BUTTON_TOKEN || '';
const DEFAULT_CWD = cfg.DEFAULT_CWD || toMsys(os.homedir());
const CLAUDE_TAB = cfg.CLAUDE_TAB || '/c/Users/' + os.userInfo().username + '/scripts/claude-tab.sh';
const POLL_MS = parseInt(cfg.POLL_MS, 10) || 4000;
if (!RELAY || !TOKEN) { console.error('RELAY_URL and BUTTON_TOKEN are required in ' + cfgPath); process.exit(1); }

const SPAWN_DIR = path.join(os.homedir(), '.agent-button-spawns');
fs.mkdirSync(SPAWN_DIR, { recursive: true });
const LOG = path.join(SPAWN_DIR, 'poller.log');
const headers = { Authorization: 'Bearer ' + TOKEN };

// When Task Scheduler launches the poller it only inherits the minimal SYSTEM PATH,
// so Git's bash, wt.exe (WindowsApps), npm and ~/.local/bin/claude are all missing.
// Rebuild a full PATH from the registry + known dirs, and spawn bash by absolute path.
function registryPath() {
  try {
    return execSync(
      'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'Machine\') + \';\' + [Environment]::GetEnvironmentVariable(\'Path\',\'User\')"',
      { encoding: 'utf8', timeout: 8000 }
    ).trim();
  } catch (_) { return ''; }
}
const EXTRA_DIRS = [
  'C:\\Program Files\\Git\\bin',
  'C:\\Program Files\\Git\\usr\\bin',
  path.join(os.homedir(), '.local', 'bin'),
  path.join(os.homedir(), 'AppData', 'Local', 'Microsoft', 'WindowsApps'),
  path.join(os.homedir(), 'AppData', 'Roaming', 'npm'),
  'C:\\Program Files\\nodejs',
  'C:\\Windows\\System32',
  'C:\\Windows'
];
const SPAWN_ENV = { ...process.env, PATH: [...EXTRA_DIRS, registryPath(), process.env.PATH || ''].filter(Boolean).join(';') };
const BASH = (cfg.BASH_PATH && fs.existsSync(cfg.BASH_PATH)) ? cfg.BASH_PATH
  : ['C:\\Program Files\\Git\\bin\\bash.exe', 'C:\\Program Files\\Git\\usr\\bin\\bash.exe'].find((p) => fs.existsSync(p)) || 'bash';

// ---------- helpers ----------
function toMsys(p) {
  // C:\Users\x -> /c/Users/x  (claude-tab.sh / wt expect MSYS-style paths)
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(p);
  if (m) return '/' + m[1].toLowerCase() + '/' + m[2].replace(/\\/g, '/');
  return p.replace(/\\/g, '/');
}
function toNode(p) {
  // C:\Users\x or /c/Users/x -> C:/Users/x  (drive-lettered, forward slashes). claude is a
  // Node program and reads "/c/Users/.." as drive-relative "C:\c\..", so its path flags
  // (--mcp-config, --add-dir) need this form, not the MSYS one toMsys produces.
  const s = String(p);
  const m = /^\/([A-Za-z])\/(.*)$/.exec(s);
  if (m) return m[1].toUpperCase() + ':/' + m[2];
  return s.replace(/\\/g, '/');
}
function log(...a) {
  const line = '[' + new Date().toISOString() + '] ' + a.join(' ');
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function buildPrompt(task, i, count, id, cwd) {
  const lane = count > 1
    ? `You are agent ${i} of ${count} spawned together for this same task. Peers are working in parallel — if the task is splittable, take a distinct slice based on your number.\n`
    : '';
  const doneFlag = (SPAWN_DIR.replace(/\\/g, '/')) + `/agent-${id}-${i}.done`;
  const report = (SPAWN_DIR.replace(/\\/g, '/')) + `/report-${id}-${i}.md`;
  return `You are a worker agent spawned from Lloyd's phone "SPAWN AGENTS" button.
${lane}
# YOUR TASK
${task}

# HOW TO WORK
- Work autonomously and thoroughly. Don't ask clarifying questions — make sensible calls and proceed.
- Follow Lloyd's global CLAUDE.md conventions (no em-dashes, no name-drops, direct path, do the follow-up steps).
- Working directory: ${cwd}

# WHEN DONE
1. Write a short summary of what you did to:
   ${report}
2. Then signal completion so this tab can close:
   echo DONE > "${doneFlag}"
`;
}

function spawnTab({ id, i, count, cwd, autoClose, promptText }) {
  return new Promise((resolve) => {
    const title = `PhoneAgent-${id.slice(-5)}-${i}`;
    const doneFlag = path.join(SPAWN_DIR, `agent-${id}-${i}.done`);
    try { fs.unlinkSync(doneFlag); } catch (_) {}
    // --remote-control makes the session chat-drivable from the phone and gives it a
    // clean name in the session registry, so it shows up in the agent dashboard.
    const args = [CLAUDE_TAB, '--title', title, '--cwd', cwd, '--prompt', promptText, '--remote-control', title];
    if (autoClose) args.push('--done-flag', toMsys(doneFlag), '--grace-sec', '120');
    else args.push('--no-auto-close');
    let settled = false;
    const finish = (ok, why) => {
      if (settled) return; settled = true;
      log((ok ? 'spawned ' : 'spawn FAILED ') + title + (why ? ' (' + why + ')' : '') + ' [autoClose=' + autoClose + ']');
      resolve(ok);
    };
    let child;
    try { child = spawn(BASH, args, { detached: true, stdio: 'ignore', env: SPAWN_ENV }); }
    catch (e) { return finish(false, e.message); }
    child.on('error', (e) => finish(false, e.message));
    child.on('spawn', () => { try { child.unref(); } catch (_) {} finish(true); });
    setTimeout(() => { try { child.unref(); } catch (_) {} finish(true, 'assumed-ok'); }, 2000);
  });
}

// ---------- live-agent reporting (for the dashboard) ----------
// Claude Code writes ~/.claude/sessions/<pid>.json per live session, with name,
// status, cwd, and bridgeSessionId (-> claude.ai/code/<id> chat URL). We read it,
// keep only sessions whose PID is still alive, and push the list to the relay.
function alivePid(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}
async function reportAgents() {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return 0; }
  const agents = [];
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (!d || !d.pid || !alivePid(d.pid)) continue;
    const name = String(d.name || ('pid ' + d.pid)).replace(/^claude-tab:/, '').replace(/_$/, '');
    agents.push({
      name,
      pid: d.pid,
      status: d.status || 'unknown',
      chat: d.bridgeSessionId ? ('https://claude.ai/code/' + d.bridgeSessionId) : null,
      cwd: d.cwd || null,
      startedAt: d.startedAt || null,
      updatedAt: d.updatedAt || null,
      kind: d.kind || null
    });
  }
  agents.sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0));
  try {
    await fetch(RELAY + '/agents', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agents, host: os.hostname(), ts: Date.now() })
    });
  } catch (_) {}
  return agents.length;
}

// ---------- in-app chat: run one Claude Code turn per message, headless ----------
const CHAT_DIR = path.join(SPAWN_DIR, 'chat');
try { fs.mkdirSync(CHAT_DIR, { recursive: true }); } catch (_) {}
const MAX_CHAT = 3;
const TURN_TIMEOUT_MS = 15 * 60 * 1000; // kill a chat turn that runs longer than this so a hang can't jam a slot forever
let chatInFlight = 0;
const bq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // single-quote for bash

// ---------- lean dispatch: each chat turn = deterministic search -> ONE scoped worker ----------
// Replaces the old fat `claude -p` (which inherited every global skill + MCP server) with the
// pipeline at ~/.claude/skills/dispatch: capindex search -> decide() -> a disposable worker scoped
// to ONLY the chosen skill(s)/MCP, which tears itself down. dispatch.mjs is ESM, so this CommonJS
// poller loads it lazily via dynamic import. DISPATCH_BASH must be set before that import because
// scope_worker.mjs reads it at module-eval time to locate Git bash.
const DISPATCH_DIR = path.join(os.homedir(), '.claude', 'skills', 'dispatch', 'scripts');
const CHAT_MODEL = cfg.CHAT_MODEL || 'claude-sonnet-4-6'; // worker model for chat turns (fast + capable)
let _dispatchPromise = null;
function loadDispatch() {
  if (!_dispatchPromise) {
    process.env.DISPATCH_BASH = BASH;
    const href = require('url').pathToFileURL(path.join(DISPATCH_DIR, 'dispatch.mjs')).href;
    _dispatchPromise = import(href);
  }
  return _dispatchPromise;
}

// Compact transcript (last ~10 turns) for conversational continuity. Drops the trailing user turn:
// that's the current message, passed separately as the task, so we don't duplicate it.
function buildHistory(messages, max = 10) {
  let msgs = Array.isArray(messages) ? messages.slice() : [];
  if (msgs.length && msgs[msgs.length - 1].role === 'user') msgs = msgs.slice(0, -1);
  return msgs.slice(-max).map((m) => {
    const who = m.role === 'agent' ? 'assistant' : (m.role === 'system' ? 'system' : 'user');
    return who + ': ' + String(m.text || '').slice(0, 1500);
  }).join('\n');
}

// One chat turn as a lean dispatch. Returns {reply} or {error}. No sessionId: the worker is
// disposable, continuity comes from the injected transcript (Option A), not --resume.
async function runDispatchTurn(job) {
  let history = '';
  try {
    const r = await fetch(RELAY + '/chat/get?id=' + encodeURIComponent(job.agentId), { headers });
    if (r.ok) { const j = await r.json(); history = buildHistory(j.messages); }
  } catch (_) {}
  // The scoped worker runs in a scratch dir, so name the user's project so it can reach files there
  // via absolute paths (it isn't confined to scratch; it just starts there for the scoping to bind).
  const cwd = job.cwd && String(job.cwd).trim() ? String(job.cwd).trim() : '';
  const ctx = cwd ? ('Working directory: ' + cwd + ' (use absolute paths to read or write files there).\n\n') : '';

  let mod;
  try { mod = await loadDispatch(); }
  catch (e) { return { error: 'dispatch load failed: ' + e.message }; }
  const workerName = 'chat-' + job.agentId + '-' + process.hrtime.bigint(); // disjoint scratch per turn
  try {
    const out = await mod.runDispatch({
      message: String(job.message || ''),
      history: ctx + history,
      model: CHAT_MODEL,
      workerName,
      timeoutMs: TURN_TIMEOUT_MS, // the scoped worker tree-kills itself (taskkill /T) past this
      env: SPAWN_ENV,
    });
    const d = out.decision || {};
    log('dispatch ' + job.agentId + ' mode=' + (d.mode || '?') + ' skills=[' + (d.skills || []).join(',') + '] mcps=[' + (d.mcps || []).join(',') + ']');
    if (out.error) return { error: String(out.error).slice(0, 500) };
    return { reply: out.reply };
  } catch (e) {
    return { error: 'dispatch error: ' + e.message };
  }
}

// Pull one queued chat turn and run it (without blocking the drain). Returns true if a turn was
// started. When the turn finishes it frees its slot and pulls the next queued turn itself, so a
// backlog drains without busy-looping.
async function tryStartChat() {
  if (chatInFlight >= MAX_CHAT) return false;
  let job = null;
  try {
    const r = await fetch(RELAY + '/chat/jobnext', { headers });
    if (r.ok) { const j = await r.json(); if (!j.empty) job = j; }
  } catch (_) { return false; }
  if (!job) return false;
  chatInFlight++;
  log('chat turn -> ' + job.agentId + ' (dispatch)');
  (async () => {
    const res = await runDispatchTurn(job);
    try {
      await fetch(RELAY + '/chat/result', {
        method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
        // sessionId intentionally omitted: disposable scoped workers have no resumable session.
        body: JSON.stringify({ agentId: job.agentId, reply: res.reply, error: res.error })
      });
    } catch (_) {}
    chatInFlight--;
    log('chat turn done -> ' + job.agentId + (res.error ? (' ERROR: ' + res.error) : ''));
    tryStartChat(); // a slot freed; pick up the next queued turn if there is one
  })();
  return true;
}

// ---------- spawn real ELEVATED interactive terminal agents via the ClaudeCodeAdmin task ----------
// We DON'T spawn directly (the poller is non-elevated). Instead we drop a launcher into the
// admin-queue and trigger the ClaudeCodeAdmin scheduled task (= the "Claude Code (Admin).lnk").
// Its elevated wrapper (claude-code-admin-wrapper.ps1) runs our launcher, so the window is
// truly elevated, identical to launching the shortcut by hand.
const ADMIN_QUEUE = path.join(SPAWN_DIR, 'admin-queue');
// Pull one queued elevated-terminal spawn and open it. Returns true if one was opened (or pulled but
// failed to write), false if the queue was empty — so the drain knows when to stop.
async function pollSpawnOnce() {
  let s = null;
  try {
    const r = await fetch(RELAY + '/spawn-next', { headers });
    if (r.ok) { const j = await r.json(); if (!j.empty) s = j; }
  } catch (_) { return false; }
  if (!s) return false;
  try { fs.mkdirSync(ADMIN_QUEUE, { recursive: true }); } catch (_) {}
  const promptFile = path.join(ADMIN_QUEUE, s.name + '.prompt.txt');
  const launcherFile = path.join(ADMIN_QUEUE, s.name + '.sh');
  const user = os.userInfo().username;
  const pathDirs = [
    '/c/Users/' + user + '/AppData/Local/Microsoft/WindowsApps',
    '/c/Program Files/Git/bin', '/c/Program Files/Git/usr/bin',
    '/c/Windows/System32', '/c/Windows', '/c/Program Files/nodejs',
    '/c/Users/' + user + '/.local/bin', '/c/Users/' + user + '/AppData/Roaming/npm'
  ].join(':');

  // Default: a full-inheritance interactive tab opened in the project dir.
  let cwdArg = s.cwd && String(s.cwd).trim() ? toMsys(String(s.cwd).trim()) : DEFAULT_CWD;
  let scopeArgs = '';      // extra claude scope flags, appended through claude-tab.sh
  let promptPrefix = '';   // scoped-run note prepended to the prompt
  let scopeInfo = '';      // log suffix

  // Solve+Dispatch (or a dispatch-toggled single spawn): scope THIS generation to only the
  // capabilities its goal needs. The search + scratch must be built here on the PC (the
  // Cloudflare Worker can't run fastembed). It launches the SAME watchable tab, just pointed
  // at the scratch with strict scope flags so only the chosen skills/MCP load. Any failure
  // falls back to the fat launch below, so a never-give-up relay never dies on a scope hiccup.
  if (s.dispatch && s.goal) {
    try {
      const mod = await loadDispatch();
      const { scope, decision } = await mod.prepareDispatchScope({ goal: String(s.goal), workerName: s.name });
      cwdArg = toMsys(scope.cwd);
      if (scope.mcpConfigPath) {
        scopeArgs += ' --mcp-config ' + bq(scope.mcpConfigPath);
        if (scope.strict) scopeArgs += ' --strict-mcp-config';
      }
      if (scope.settingSources) scopeArgs += ' --setting-sources ' + bq(scope.settingSources);
      const projNode = s.cwd && String(s.cwd).trim() ? toNode(String(s.cwd).trim()) : '';
      if (projNode) scopeArgs += ' --add-dir ' + bq(projNode);
      promptPrefix =
        '[SCOPED RUN] You are running in a disposable scratch sandbox, scoped by lean dispatch to only '
        + 'the capabilities this problem needs'
        + (scope.skills.length ? ' (skills: ' + scope.skills.join(', ') + ')' : ' (no extra skills matched)')
        + (scope.mcps.length ? ' (MCP: ' + scope.mcps.join(', ') + ')' : '')
        + '.\n'
        + (projNode ? ('The project to work on lives at ' + projNode + '. Your working directory is a scratch '
            + 'dir that binds the scoped skills, so use ABSOLUTE paths to read and edit the project files there.\n') : '')
        + '\n';
      scopeInfo = ' [dispatch ' + (decision.mode || '?') + ' skills=' + scope.skills.length + ' mcp=' + scope.mcps.length + ']';
      // Reap the scratch from two generations back. It is guaranteed dead by now (gen
      // N-1 may still be closing), so this never pulls skills out from under a live
      // session. cleanupScope unlinks the skill JUNCTIONS safely — never a raw rm -rf
      // that could follow a junction into the real skill dir. Bounds scratch to ~2 live
      // dirs per relay; the final gen of a finished relay is left behind (trivial).
      const gm = /^(sv[0-9a-z]+)-g(\d+)$/i.exec(String(s.name));
      if (gm) {
        const old = parseInt(gm[2], 10) - 2;
        if (old >= 1) { try { mod.cleanupScope(undefined, gm[1] + '-g' + old); } catch (_) {} }
      }
    } catch (e) {
      log('solve dispatch scope failed for ' + s.name + ' (' + e.message + '); falling back to full inheritance');
    }
  }

  const launcher =
    'export PATH="' + pathDirs + ':$PATH"\n' +
    bq(CLAUDE_TAB) + ' --title ' + bq(s.name) + ' --remote-control ' + bq(s.name) +
    ' --cwd ' + bq(cwdArg) + ' --no-auto-close' + scopeArgs +
    ' --prompt "$(cat ' + bq(toMsys(promptFile)) + ')"\n';
  try {
    fs.writeFileSync(promptFile, promptPrefix + String(s.prompt || ''));
    fs.writeFileSync(launcherFile, launcher);
  } catch (e) { log('admin spawn write failed ' + s.name + ': ' + e.message); return true; }
  log('admin spawn -> ' + s.name + ' (queued; triggering ClaudeCodeAdmin task)' + scopeInfo);
  try { execSync('schtasks /run /tn ClaudeCodeAdmin', { stdio: 'ignore', timeout: 12000 }); }
  catch (e) { log('schtasks trigger failed for ' + s.name + ': ' + e.message); }
  return true;
}

// ---------- PC stats (RAM / CPU) for the dashboard ----------
let prevCpu = os.cpus();
function cpuPercent() {
  const cur = os.cpus();
  let idle = 0, total = 0;
  for (let i = 0; i < cur.length && i < prevCpu.length; i++) {
    const a = prevCpu[i].times, b = cur[i].times;
    idle += (b.idle - a.idle);
    total += (b.user - a.user) + (b.nice - a.nice) + (b.sys - a.sys) + (b.irq - a.irq) + (b.idle - a.idle);
  }
  prevCpu = cur;
  return total > 0 ? Math.max(0, Math.min(100, Math.round(100 * (1 - idle / total)))) : 0;
}
async function reportStats() {
  const total = os.totalmem() / 1073741824, free = os.freemem() / 1073741824;
  const stats = {
    host: os.hostname(),
    cpuPct: cpuPercent(),
    cores: os.cpus().length,
    ramUsedGB: +(total - free).toFixed(1),
    ramTotalGB: +total.toFixed(1),
    ramPct: total > 0 ? Math.round(100 * (total - free) / total) : 0,
    uptimeH: +(os.uptime() / 3600).toFixed(1),
    ts: Date.now()
  };
  try {
    await fetch(RELAY + '/stats', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify(stats) });
  } catch (_) {}
}

// ---------- other live agents (any Claude Code terminal tab, not just app ones) ----------
const SCREENSHOT_EXE = path.join(os.homedir(), '.claude', 'screenshot.exe');
let externalBusy = false;
function listAgentTabs() {
  return new Promise((resolve) => {
    if (!fs.existsSync(SCREENSHOT_EXE)) return resolve([]);
    let out = '', child;
    try { child = spawn(SCREENSHOT_EXE, ['--list'], { env: SPAWN_ENV, stdio: ['ignore', 'pipe', 'ignore'] }); }
    catch (_) { return resolve([]); }
    child.stdout.on('data', (d) => { out += d; });
    child.on('error', () => resolve([]));
    child.on('close', () => {
      const names = [];
      for (const line of out.split(/\r?\n/)) {
        // "N. ? <name>" or "N. Administrator: ? <name>" marks a Windows Terminal (Claude) tab
        const m = line.match(/^\s*\d+\.\s*(?:Administrator:\s*)?\?\s*(.+?)\s*$/);
        if (m && m[1]) names.push(m[1].replace(/^claude-tab:/, '').replace(/_$/, '').trim());
      }
      resolve([...new Set(names)]);
    });
  });
}
async function reportExternal() {
  if (externalBusy) return;
  externalBusy = true;
  try {
    const names = await listAgentTabs();
    // enrich from the session registry where a live session matches the tab name
    const sess = {};
    try {
      const dir = path.join(os.homedir(), '.claude', 'sessions');
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
        if (!d.pid || !alivePid(d.pid)) continue;
        const nm = String(d.name || '').replace(/^claude-tab:/, '').replace(/_$/, '');
        if (nm) sess[nm] = d;
      }
    } catch (_) {}
    const external = names.map((name) => {
      const d = sess[name];
      return {
        name,
        status: d && d.status ? d.status : 'live',
        chat: d && d.bridgeSessionId ? ('https://claude.ai/code/' + d.bridgeSessionId) : null,
        cwd: d ? d.cwd : null
      };
    });
    await fetch(RELAY + '/external', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ external, ts: Date.now() }) });
  } catch (_) {} finally { externalBusy = false; }
}

// ---------- Solve-mode watchdog ----------
// Ask the relay to keep never-give-up relays alive: any 'solving' relay that has gone
// silent for 30 min gets its successor auto-spawned from the handover (the respawn lands
// in the normal spawn queue, so pollSpawn opens it via the ClaudeCodeAdmin task). A relay
// that escalates to 'awaiting' or is Stopped is left alone. Throttled to once a minute.
let watchBusy = false, lastWatch = 0;
async function pollSolveWatch() {
  const now = Date.now();
  if (watchBusy || now - lastWatch < 60000) return;
  watchBusy = true; lastWatch = now;
  try {
    const r = await fetch(RELAY + '/solve/watch', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' } });
    if (r.ok) {
      const j = await r.json();
      if (j.respawned && j.respawned.length) log('solve watchdog: respawned ' + j.respawned.join(', '));
      if (j.paused && j.paused.length) log('solve watchdog: paused (needs human) ' + j.paused.join(', '));
    }
  } catch (_) {} finally { watchBusy = false; }
}

// ---------- Solve-mode tab cleanup ----------
// Close superseded solve-relay tabs: when a NEWER generation (sv<id>-g<N>) is confirmed
// running, older generations of the same relay are finished husks. Reap them so dead
// tabs don't pile up. Safe: only closes a gen when a strictly newer gen of the SAME
// relay has a live session that's been up >30s; never closes the newest; 60s startup
// grace after a poller restart. SOLVE_REAP=off disables; SOLVE_REAP=dryrun logs only.
const SOLVE_REAP_MODE = String(cfg.SOLVE_REAP || process.env.SOLVE_REAP || 'on').toLowerCase();
let reapBusy = false, lastReap = 0;
function pollSolveReap() {
  if (SOLVE_REAP_MODE === 'off') return;
  const now = Date.now();
  if (reapBusy || now - lastReap < 12000) return;
  reapBusy = true; lastReap = now;
  try { closeSuperseded({ dryRun: SOLVE_REAP_MODE === 'dryrun', log }); }
  catch (e) { log('solve reap error: ' + e.message); }
  finally { reapBusy = false; }
}

async function handle(t) {
  const id = t.id;
  const count = Math.max(1, Math.min(4, t.count || 1));
  const cwd = t.cwd && t.cwd.trim() ? toMsys(t.cwd.trim()) : DEFAULT_CWD;
  const autoClose = t.autoClose !== false;
  log('TASK', id, 'count=' + count, 'cwd=' + cwd, JSON.stringify((t.task || '').slice(0, 70)));
  try {
    let ok = 0;
    for (let i = 1; i <= count; i++) {
      const promptText = buildPrompt(t.task, i, count, id, cwd);
      fs.writeFileSync(path.join(SPAWN_DIR, `prompt-${id}-${i}.md`), promptText);
      if (await spawnTab({ id, i, count, cwd, autoClose, promptText })) ok++;
      await sleep(2500); // stagger MCP startup so tabs don't choke
    }
    const err = ok === 0 ? 'no tabs spawned (bash/wt not found?)' : (ok < count ? `only ${ok}/${count} spawned` : null);
    await ack(id, ok, err);
  } catch (e) {
    log('handle error', e.message);
    await ack(id, 0, e.message);
  }
}

async function ack(id, spawned, error) {
  try {
    await fetch(RELAY + '/ack', {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, spawned, error })
    });
  } catch (e) { log('ack failed', e.message); }
}

// ============================================================================
// Push transport (replaces the old busy-poll loop). The poller holds ONE WebSocket
// open to the relay's Durable Object. While nothing is happening the DO hibernates and
// we burn ~zero requests; the instant the phone queues work the DO pushes {type:'wake'}
// and we drain once. ping/pong keepalive is auto-answered at the edge (free) and holds
// the socket open through NAT. A 5-minute safety drain catches any missed wake, and the
// Solve watchdog rides along on it. Telemetry is sent only when the dashboard asks.
// ============================================================================
const WS_URL = RELAY.replace(/^http/, 'ws') + '/ws?s=' + encodeURIComponent(TOKEN);
let ws = null, wsBackoffMs = 1000, keepalive = null;
let draining = false, drainAgain = false;

// Pull every queue dry. Re-entrancy guarded: a wake during a drain just flags a re-run.
async function drainOnce(reason) {
  if (draining) { drainAgain = true; return; }
  draining = true;
  try {
    for (;;) { // phone-queued terminal tasks
      let t = null;
      try { const r = await fetch(RELAY + '/next', { headers }); if (r.ok) { const j = await r.json(); if (!j.empty) t = j; } }
      catch (_) { break; }
      if (!t) break;
      await handle(t);
    }
    for (;;) { if (!(await pollSpawnOnce())) break; }                     // elevated terminal spawns (button / solve)
    while (chatInFlight < MAX_CHAT) { if (!(await tryStartChat())) break; } // in-app chat turns
  } finally {
    draining = false;
    if (drainAgain) { drainAgain = false; setTimeout(() => drainOnce('again'), 50); }
  }
}

// Telemetry (RAM/CPU + live tabs) is pushed only when the dashboard nudges us, throttled so a
// fast-polling dashboard can't spam it. When no one is watching, nothing is sent.
let lastStatsPush = 0;
function pushStats() {
  const now = Date.now();
  if (now - lastStatsPush < 2000) return;
  lastStatsPush = now;
  reportStats();    // fire-and-forget; RAM/CPU
  reportExternal(); // fire-and-forget; other live Claude tabs
}

function startKeepalive() {
  stopKeepalive();
  // 'ping' is matched by the DO's auto-response pair, so it never wakes the DO or counts as a request.
  keepalive = setInterval(() => { try { if (ws && ws.readyState === 1) ws.send('ping'); } catch (_) {} }, 30000);
}
function stopKeepalive() { if (keepalive) { clearInterval(keepalive); keepalive = null; } }

function scheduleReconnect() {
  if (ws && ws.readyState === 1) return;
  const ms = wsBackoffMs;
  wsBackoffMs = Math.min(wsBackoffMs * 2, 30000);
  if (!scheduleReconnect._q) { log('WS down; reconnecting (backoff up to 30s)'); scheduleReconnect._q = 1; setTimeout(() => (scheduleReconnect._q = 0), 60000); }
  setTimeout(connect, ms);
}

function connect() {
  let sock;
  try { sock = new WebSocket(WS_URL); }
  catch (e) { log('WS construct failed: ' + e.message); return scheduleReconnect(); }
  ws = sock;
  sock.addEventListener('open', () => {
    wsBackoffMs = 1000;
    log('connected (push mode) -> ' + RELAY);
    try { sock.send(JSON.stringify({ type: 'hello', host: os.hostname(), ts: Date.now() })); } catch (_) {}
    drainOnce('connect'); // catch anything queued while we were disconnected
    startKeepalive();
  });
  sock.addEventListener('message', (ev) => {
    const data = typeof ev.data === 'string' ? ev.data : '';
    if (data === 'pong') return;
    let m = null; try { m = JSON.parse(data); } catch (_) { return; }
    if (!m) return;
    if (m.type === 'wake') drainOnce('wake');
    else if (m.type === 'wantStats') pushStats();
  });
  sock.addEventListener('close', () => { stopKeepalive(); scheduleReconnect(); });
  sock.addEventListener('error', () => { try { sock.close(); } catch (_) {} });
}

log('poller starting (push mode) -> ' + RELAY + ' (default cwd ' + DEFAULT_CWD + ')');
connect();
// Safety net: catch any missed wake + run the Solve watchdog every 5 min (the old loop's other duties).
setInterval(() => { drainOnce('safety'); pollSolveWatch(); }, 5 * 60 * 1000);
// Local-only cleanup of superseded Solve tabs — no network, no DO cost.
setInterval(() => pollSolveReap(), 15000);
