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
const { createRcBridge } = require('./rc-bridge');   // chat with a REAL terminal agent from the app

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

// Remote-control bridge. Holds an SSE stream of the Claude Code session transcript for exactly
// the sessions the app currently has a chat page open on, and posts Lloyd's replies back into
// them. The subscribed set is PUSHED to us by the relay ({type:'rcsubs'} / hello-ack), never
// polled, so a PC with no chat page open costs nothing. `log` is a hoisted function declaration
// below, so passing it here is fine.
const rc = createRcBridge({ relay: RELAY, headers, log });

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

// Base dir for dispatch scratch (mirrors scope_worker.mjs DEFAULT_RUNDIR so the paths
// we compute here line up with what cleanupScope/sweepStaleScratch actually delete).
const DISPATCH_RUNDIR = path.join(os.homedir(), '.dispatch-runs');

// Canonicalize a path for cross-form comparison: C:\X, C:/X and /c/X all collapse to
// "c:/x" (lowercase drive + path, forward slashes, no trailing slash). Live-session
// cwds and scratch paths can be recorded in any of those forms.
function canonPath(p) {
  let s = String(p || '').replace(/\\/g, '/');
  const msys = /^\/([A-Za-z])\/(.*)$/.exec(s); // /c/Users/x -> C:/Users/x
  if (msys) s = msys[1] + ':/' + msys[2];
  return s.replace(/\/+$/, '').toLowerCase();
}

// Canon set of cwds for every LIVE Claude session (alive pid) from ~/.claude/sessions.
// A dispatch scratch dir that one of these sits inside is in active use and must not be
// swept or reaped. (alivePid is a hoisted function declaration defined further down.)
function liveSessionCwds() {
  const out = new Set();
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files = [];
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return out; }
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (!d || !d.pid || !alivePid(d.pid) || !d.cwd) continue;
    out.add(canonPath(d.cwd));
  }
  return out;
}

// True if scratchPath is the cwd of (or an ancestor of) any live session, i.e. a session
// is still working inside it, so tearing it down would yank scope from a live tab.
function scratchInUse(scratchPath, cwds = liveSessionCwds()) {
  const norm = canonPath(scratchPath);
  if (!norm) return false;
  for (const c of cwds) {
    if (c === norm || c.startsWith(norm + '/')) return true;
  }
  return false;
}

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
      // `chat` stays: it is the permanent "Open in Claude" fallback for when the bridge is
      // unavailable. `bridgeSessionId` is the raw session_<ULID> the in-app chat page addresses
      // through /rc/*, and `waitingFor` (e.g. "permission prompt") tells the app WHY a session
      // is sitting on 'waiting' so it can say so instead of just looking stalled.
      chat: d.bridgeSessionId ? ('https://claude.ai/code/' + d.bridgeSessionId) : null,
      bridgeSessionId: d.bridgeSessionId || null,
      waitingFor: d.waitingFor || null,
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
  chatInFlight++; // claim the slot BEFORE any await so concurrent finishers can't overshoot MAX_CHAT (TOCTOU)
  let job = null;
  try {
    const r = await fetch(RELAY + '/chat/jobnext', { headers });
    if (r.ok) { const j = await r.json(); if (!j.empty) job = j; }
  } catch (_) { chatInFlight--; return false; }
  if (!job) { chatInFlight--; return false; }
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
  // The agent's DISPLAY name (s.name) is whatever the user typed — it can hold spaces, capitals
  // and punctuation, and it goes through to --title / --remote-control untouched. Filenames need
  // the tame form: the relay sends it as s.slug, and the fallback keeps an already-queued record
  // (minted before slug existed) launching. Solve generations have no slug and don't need one —
  // 'sv<id>-g<N>' is already ASCII, and the wrapper's reap matches on exactly that BaseName.
  const fsName = String(s.slug || s.name || 'agent').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+/, '') || 'agent';
  const promptFile = path.join(ADMIN_QUEUE, fsName + '.prompt.txt');
  const launcherFile = path.join(ADMIN_QUEUE, fsName + '.sh');
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
      // fsName, not s.name: workerName becomes a scratch DIRECTORY under DISPATCH_RUNDIR/workers
      // (and junction targets inside it), so it has to be the tame form.
      const { scope, decision } = await mod.prepareDispatchScope({ goal: String(s.goal), workerName: fsName });
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
      // Reap the scratch from two generations back. Gen N-2 is normally dead by the time
      // gen N spawns, but a slow solver can leave 3 generations overlapping, so we guard
      // with scratchInUse (skip if a live session is still cwd'd inside it) instead of
      // assuming it's dead. cleanupScope routes through Node rmSync(recursive, force),
      // which UNLINKS junctions rather than following them (a shell rm -rf could follow a
      // junction into the real skill dir, but that path is never used). The final gen of a
      // finished relay is left for the time-based pollDispatchSweep to collect.
      const gm = /^(sv[0-9a-z]+)-g(\d+)$/i.exec(String(s.name));
      if (gm) {
        const old = parseInt(gm[2], 10) - 2;
        if (old >= 1) {
          const victimName = gm[1] + '-g' + old;
          const victimPath = path.join(DISPATCH_RUNDIR, 'workers', victimName);
          if (scratchInUse(victimPath)) {
            log('solve reap: skipped live gen ' + victimName + ' (still a live session cwd)');
          } else {
            try { mod.cleanupScope(undefined, victimName); } catch (_) {}
          }
        }
      }
    } catch (e) {
      log('solve dispatch scope failed for ' + s.name + ' (' + e.message + '); falling back to full inheritance');
    }
  }

  // --new-window: every button agent gets its OWN WindowsTerminal.exe process. In WT each window
  // is a separate process, so a tab added to an existing window shares that process's fate. On
  // 2026-08-28 07:51 the one elevated window hosting Dense-5, Shopify 2-3 and Getgodmode went
  // down during a spawn (box wedged by a C: defrag+VSS stall) and all three agents died at once.
  // One window per agent means a wedge or close can only ever take that one agent.
  const launcher =
    'export PATH="' + pathDirs + ':$PATH"\n' +
    bq(CLAUDE_TAB) + ' --title ' + bq(s.name) + ' --remote-control ' + bq(s.name) +
    ' --cwd ' + bq(cwdArg) + ' --no-auto-close --new-window' + scopeArgs +
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
// ---------- which Claude subscription is logged in ----------
// Three files, none of them authoritative on its own:
//   ~/.claude.json                     -> oauthAccount (email, display name, rate-limit tier)
//   ~/.claude/.credentials.json        -> the live token's subscriptionType (max / pro / ...)
//   ~/.claude/account-profiles/*.json  -> the captured profiles /swap-account rotates between,
//                                         so the app can name the ACTIVE one ("lotron") rather
//                                         than only showing an email.
// Read cheaply and never throw: this is a nice-to-have on a telemetry push, not a dependency.
const PROFILE_DIR = path.join(os.homedir(), '.claude', 'account-profiles');
function readJson(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch (_) { return null; } }
function readAccount() {
  const main = readJson(path.join(os.homedir(), '.claude.json'));
  const oa = (main && main.oauthAccount) || {};
  const cred = readJson(path.join(os.homedir(), '.claude', '.credentials.json'));
  const co = (cred && cred.claudeAiOauth) || {};
  const email = oa.emailAddress || co.email || null;
  if (!email && !co.subscriptionType) return null;
  // Name the profile by matching the live email against the captured profiles.
  let profile = null;
  const others = [];
  try {
    for (const f of fs.readdirSync(PROFILE_DIR)) {
      if (!f.endsWith('.json') || f.startsWith('.')) continue;
      const j = readJson(path.join(PROFILE_DIR, f));
      if (!j || !j.email) continue;
      const nm = j.name || f.replace(/\.json$/, '');
      if (email && j.email === email) profile = nm; else others.push({ name: nm, email: j.email });
    }
  } catch (_) {}
  return {
    email,
    profile,                                   // e.g. "lotron" - null when it matches no capture
    displayName: oa.displayName || oa.fullName || null,
    plan: co.subscriptionType || null,         // "max" | "pro" | ...
    tier: co.rateLimitTier || oa.organizationRateLimitTier || null, // "default_claude_max_20x"
    org: oa.organizationName || null,
    tokenExpiresAt: co.expiresAt || null,
    others,                                    // the other captured profiles, for context
    ts: Date.now()
  };
}

async function reportStats() {
  const total = os.totalmem() / 1073741824, free = os.freemem() / 1073741824;
  const stats = {
    host: os.hostname(),
    account: readAccount(),
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
    const byPid = {};
    try {
      const dir = path.join(os.homedir(), '.claude', 'sessions');
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) {
        let d; try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
        if (!d.pid || !alivePid(d.pid)) continue;
        byPid[d.pid] = d;
        const nm = String(d.name || '').replace(/^claude-tab:/, '').replace(/_$/, '');
        if (nm) sess[nm] = d;
      }
    } catch (_) {}
    // Second join key. A session started WITHOUT --remote-control keeps a derived name
    // ("lloyd-gibbs-db") that will never equal its tab title, and `/rc <name>` connects the
    // bridge without renaming it — so name matching alone leaves those cards permanently
    // chat-less. rc-watchdog records the pairing it observes when it arms a tab; read it.
    let tabmap = {};
    try { tabmap = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'logs', 'rc-tabmap.json'), 'utf8')); } catch (_) {}
    const external = names.map((name) => {
      const mapped = tabmap[name] && byPid[tabmap[name].pid];
      const d = sess[name] || mapped;
      return {
        name,
        status: d && d.status ? d.status : 'live',
        // See reportAgents for why all three of chat / bridgeSessionId / waitingFor are sent.
        // This is the list the dashboard actually renders, so the in-app chat page reads
        // bridgeSessionId from here.
        chat: d && d.bridgeSessionId ? ('https://claude.ai/code/' + d.bridgeSessionId) : null,
        bridgeSessionId: (d && d.bridgeSessionId) || null,
        waitingFor: (d && d.waitingFor) || null,
        cwd: d ? d.cwd : null
      };
    });
    await fetch(RELAY + '/external', { method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ external, ts: Date.now() }) });
  } catch (_) {} finally { externalBusy = false; }
}

// ---------- remote-control arming ("Connect RC" in the app) ----------
// Typing `/rc <name>` into a Claude tab needs UIA + SendKeys against that terminal window, and
// the tabs are spawned ELEVATED (ClaudeCodeAdmin) — a medium-integrity process like this poller
// literally cannot send them a keystroke. So the poller never touches the window: it drops a
// request file that the ELEVATED rc-watchdog daemon (~/scripts/rc-watchdog.js) executes, and
// waits for the result file it writes back.
const RC_ARM_DIR = path.join(os.homedir(), '.claude', 'logs', 'rc-arm');
const RC_ARM_TIMEOUT_MS = 150000;   // the daemon polls every few seconds; /rc itself takes ~10s
const armInFlight = new Set();
async function drainRcArm() {
  let items = [];
  try {
    const r = await fetch(RELAY + '/rc/armnext', { headers });
    if (!r.ok) return;
    items = (await r.json()).items || [];
  } catch (_) { return; }
  for (const it of items) {
    if (!it || !it.tab || armInFlight.has(it.tab)) continue;
    armInFlight.add(it.tab);
    runArm(it).finally(() => armInFlight.delete(it.tab));
  }
}
async function runArm(it) {
  const id = String(it.id || Date.now()).replace(/[^a-z0-9-]/gi, '');
  const req = path.join(RC_ARM_DIR, 'req-' + id + '.json');
  const res = path.join(RC_ARM_DIR, 'res-' + id + '.json');
  let out = { ok: false, detail: 'no response from the RC daemon' };
  try {
    fs.mkdirSync(RC_ARM_DIR, { recursive: true });
    fs.writeFileSync(req, JSON.stringify({ id, tab: it.tab, name: it.name || it.tab, ts: Date.now() }));
    log('rc-arm: requested "' + it.tab + '" as "' + (it.name || it.tab) + '"');
    const until = Date.now() + RC_ARM_TIMEOUT_MS;
    while (Date.now() < until) {
      await new Promise((r) => setTimeout(r, 1500));
      if (!fs.existsSync(res)) continue;
      const j = JSON.parse(fs.readFileSync(res, 'utf8'));
      out = { ok: !!j.ok, detail: String(j.detail || '') };
      break;
    }
  } catch (e) {
    out = { ok: false, detail: e.message };
  }
  try { fs.unlinkSync(req); } catch (_) {}
  try { fs.unlinkSync(res); } catch (_) {}
  log('rc-arm: "' + it.tab + '" -> ' + (out.ok ? 'CONNECTED' : 'FAILED') + ' (' + out.detail + ')');
  try {
    await fetch(RELAY + '/rc/armresult', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ tab: it.tab, ok: out.ok, detail: out.detail })
    });
  } catch (_) {}
  // Refresh the card straight away so the new bridge id shows without waiting for a nudge.
  reportExternal();
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

// ---------- Dispatch scratch sweep ----------
// Time-based backstop for LEAKED dispatch scratch dirs under ~/.dispatch-runs/workers/.
// The N-2 reaper above only matches relay (sv<id>-g<N>) names, so non-relay chat/dispatch
// spawns and the final 1-2 gens of every relay are never reaped; a leaked mcp-config.json
// also holds real MCP creds. sweepStaleScratch removes anything older than its default age
// UNLESS a live session is still cwd'd inside it. Throttled to once every 30 min.
let sweepBusy = false, lastSweep = 0;
async function pollDispatchSweep() {
  const now = Date.now();
  if (sweepBusy || now - lastSweep < 30 * 60 * 1000) return;
  sweepBusy = true; lastSweep = now;
  try {
    const mod = await loadDispatch();
    const cwds = liveSessionCwds();
    mod.sweepStaleScratch({ runDir: DISPATCH_RUNDIR, isProtected: (name, p) => scratchInUse(p, cwds), log });
  } catch (e) { log('dispatch sweep error: ' + e.message); }
  finally { sweepBusy = false; }
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
// Liveness. The 'ping' we send is auto-answered at the edge, so an arriving 'pong' is proof the
// socket still carries traffic in both directions. Nothing used to READ that pong: a half-open
// TCP (phone/NAT/Wi-Fi drop) leaves readyState===1 forever while the DO's wake pushes fall into
// the void, and Node's built-in WebSocket has no keepalive of its own to notice. A spawn then sat
// in the queue until the 5-minute safety drain happened to run. Observed 2026-07-10: a button
// press waited ~2 min for an accidental reconnect, and the log shows the socket dropping a dozen
// times a day. So: treat pong silence as a dead socket and force a reconnect, which drains on open.
const PING_MS = parseInt(cfg.PING_MS, 10) || 15000;
const PONG_TIMEOUT_MS = parseInt(cfg.PONG_TIMEOUT_MS, 10) || 45000;
let ws = null, wsBackoffMs = 1000, keepalive = null, lastPong = 0, reconnectTimer = null;
let draining = false, drainAgain = false;

// Deliver messages Lloyd typed on the in-app chat page into the real terminal agent.
//
// Guarded so an idle PC costs nothing extra: with no chat page open there is nothing queued and
// nothing to ask about, and 'wake' is the relay telling us a message was JUST queued. 'connect'
// is in there because a message queued while the socket was down had its wake pushed into the
// void — without it that message would sit until the 90s safety drain. Reconnects run about a
// dozen times a day, so the cost is noise.
//
// The response also carries the authoritative subscription list, which is the backstop for an
// {type:'rcsubs'} push that went down with a dropped socket.
async function drainRcOut(reason) {
  if (!rc.hasSubs() && reason !== 'wake' && reason !== 'connect') return;
  let j = null;
  try {
    const r = await fetch(RELAY + '/rc/outnext', { headers });
    if (!r.ok) return;
    j = await r.json();
  } catch (_) { return; }
  if (!j) return;
  setRcSubs(j.subs);
  for (const item of (Array.isArray(j.items) ? j.items : [])) {
    const res = await rc.send(item);
    if (res.ok) continue;
    // A send that fails is the one thing the app cannot detect on its own: the message just
    // never appears. Write the reason back into the transcript as a system line so it is
    // visible, and the user can fall back to the "Open in Claude" link. The uuid is derived
    // from the message's own, so a retried failure dedupes instead of stacking up.
    log('rc send failed -> ' + item.sessionId + ': ' + res.error);
    try {
      await fetch(RELAY + '/rc/push', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: item.sessionId,
          messages: [{ role: 'system', text: 'Could not deliver that message: ' + res.error, ts: Date.now(), uuid: item.uuid + ':err' }],
          ts: Date.now()
        })
      });
    } catch (_) {}
  }
}

// ---------- remote-control: a session whose terminal has closed ----------
// rc-bridge only learns a session is dead when the Anthropic API 404s its event stream, and
// that does NOT happen when a terminal tab closes: the cloud session record outlives the local
// process, so the stream keeps returning 200 and the bridge keeps reporting 'live'. An open
// chat page would therefore sit on "live" forever with a composer that accepts messages nobody
// will ever read. The local session registry is the real source of truth - a bridgeSessionId
// with no alive pid behind it is gone - so we detect it here and push status:'gone' once.
const RC_GONE_GRACE_MS = 20000;      // absent this long before we call it: covers a session that
                                     // registers itself a moment after its chat page was opened
const rcGone = new Set();            // ids already reported gone; push once, and stop streaming them
const rcMissingSince = new Map();    // id -> when we first saw it absent from the registry
let lastRelaySubs = [];              // the relay's authoritative "pages currently open" list

// Every subscription update goes through here so a gone session can never be re-streamed: the
// relay keeps listing it (the page is still open), but re-attaching would let a stream reconnect
// push status:'live' straight back over our 'gone' and flip the page back to a live composer.
function setRcSubs(ids) {
  lastRelaySubs = (ids || []).filter(Boolean).map(String);
  rc.setSubs(lastRelaySubs.filter((id) => !rcGone.has(id)));
}

// bridgeSessionIds of every session with a live pid. Returns null (not an empty set) if the
// registry cannot be read, so an unreadable directory is never mistaken for "everything died".
function liveBridgeIds() {
  const dir = path.join(os.homedir(), '.claude', 'sessions');
  let files;
  try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) { return null; }
  const out = new Set();
  for (const f of files) {
    let d;
    try { d = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); } catch (_) { continue; }
    if (!d || !d.pid || !alivePid(d.pid) || !d.bridgeSessionId) continue;
    out.add(String(d.bridgeSessionId));
  }
  return out;
}

async function reapGoneRcSessions() {
  if (!lastRelaySubs.length) return;
  const live = liveBridgeIds();
  if (!live) return;                                  // registry unreadable: never guess
  const now = Date.now();
  let changed = false;
  for (const id of lastRelaySubs) {
    if (live.has(id)) {                               // alive (or back from the dead after a resume)
      rcMissingSince.delete(id);
      if (rcGone.delete(id)) changed = true;
      continue;
    }
    if (!rcMissingSince.has(id)) { rcMissingSince.set(id, now); continue; }
    if (now - rcMissingSince.get(id) < RC_GONE_GRACE_MS || rcGone.has(id)) continue;
    rcGone.add(id);
    changed = true;
    log('rc: session gone (no live pid) -> ' + id);
    try {
      await fetch(RELAY + '/rc/push', {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: id, messages: [], status: 'gone', activity: null, ts: Date.now() })
      });
    } catch (_) { rcGone.delete(id); }                // relay unreachable: retry on the next tick
  }
  for (const id of [...rcMissingSince.keys()]) {
    if (!lastRelaySubs.includes(id)) { rcMissingSince.delete(id); rcGone.delete(id); }
  }
  if (changed) setRcSubs(lastRelaySubs);              // start/stop streaming to match
}

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
    await drainRcOut(reason);                                             // messages typed at the in-app chat page
    await drainRcArm();                                                   // "Connect RC" presses from the app
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

function startKeepalive(sock) {
  stopKeepalive();
  // 'ping' is matched by the DO's auto-response pair, so it never wakes the DO or counts as a
  // request — pinging often is free. If the matching pong stops coming back, this socket is dead
  // regardless of what readyState claims; close it so the 'close' handler reconnects and re-drains.
  keepalive = setInterval(() => {
    if (ws !== sock || sock.readyState !== 1) return;   // superseded or already closing
    const silent = Date.now() - lastPong;
    if (silent > PONG_TIMEOUT_MS) {
      log('WS stale (no pong for ' + Math.round(silent / 1000) + 's); forcing reconnect');
      stopKeepalive();
      try { sock.close(); } catch (_) {}
      scheduleReconnect(); // don't rely on 'close' firing promptly on a half-open socket
      return;
    }
    try { sock.send('ping'); } catch (_) {}
  }, PING_MS);
}
function stopKeepalive() { if (keepalive) { clearInterval(keepalive); keepalive = null; } }

function scheduleReconnect() {
  if (ws && ws.readyState === 1) return;
  // Idempotent: a forced close from the keepalive AND the socket's own 'close' event both land
  // here, and a stale socket's late 'error' can add a third. Without this guard each would queue
  // its own connect() and we'd fan out into several live sockets.
  if (reconnectTimer) return;
  const ms = wsBackoffMs;
  wsBackoffMs = Math.min(wsBackoffMs * 2, 30000);
  if (!scheduleReconnect._q) { log('WS down; reconnecting (backoff up to 30s)'); scheduleReconnect._q = 1; setTimeout(() => (scheduleReconnect._q = 0), 60000); }
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, ms);
}

function connect() {
  let sock;
  try { sock = new WebSocket(WS_URL); }
  catch (e) { log('WS construct failed: ' + e.message); return scheduleReconnect(); }
  ws = sock;
  sock.addEventListener('open', () => {
    wsBackoffMs = 1000;
    lastPong = Date.now(); // a fresh socket starts its liveness window now
    log('connected (push mode) -> ' + RELAY);
    try { sock.send(JSON.stringify({ type: 'hello', host: os.hostname(), ts: Date.now() })); } catch (_) {}
    drainOnce('connect'); // catch anything queued while we were disconnected
    startKeepalive(sock);
  });
  sock.addEventListener('message', (ev) => {
    lastPong = Date.now(); // any inbound frame, not just a pong, proves the socket still carries traffic
    const data = typeof ev.data === 'string' ? ev.data : '';
    if (data === 'pong') return;
    let m = null; try { m = JSON.parse(data); } catch (_) { return; }
    if (!m) return;
    if (m.type === 'wake') drainOnce('wake');
    else if (m.type === 'wantStats') pushStats();
    // Which sessions currently have a chat page open. Pushed the moment one opens or closes, so
    // we start/stop the SSE stream immediately without ever polling for the list.
    else if (m.type === 'rcsubs') setRcSubs(m.ids);
    // A reconnect re-syncs off the hello ack, for free, on a socket that drops a dozen times a day.
    else if (m.type === 'hello-ack') setRcSubs(m.rcsubs || []);
  });
  sock.addEventListener('close', () => { stopKeepalive(); scheduleReconnect(); });
  sock.addEventListener('error', () => { try { sock.close(); } catch (_) {} });
}

// A death here is invisible from the outside: the scheduled task launched us through a
// wrapper that returned immediately, so nothing supervises the process. Whatever kills us
// gets written to poller.log first, so the next look at "why did the button stop working"
// starts with a reason instead of a log that just stops mid-sentence.
process.on('uncaughtException', (e) => { log('FATAL uncaughtException: ' + (e && e.stack || e)); process.exit(1); });
process.on('unhandledRejection', (e) => { log('FATAL unhandledRejection: ' + (e && e.stack || e)); process.exit(1); });
process.on('exit', (code) => { log('poller exiting (code ' + code + ')'); });

log('poller starting (push mode) -> ' + RELAY + ' (default cwd ' + DEFAULT_CWD + ')');
connect();
// Safety net for a wake that never lands. This is the hard ceiling on "I pressed START and
// nothing happened", so it is deliberately much tighter than the Solve watchdog it used to ride
// on: an idle drain is 3 Durable Object requests (/next, /spawn-next, /chat/jobnext), so 90s
// costs ~2.9k/day against the 100k/day free tier — the pong watchdog above should mean we almost
// never need it. Re-check that budget before tightening further (see COST GOTCHA in the notes).
setInterval(() => drainOnce('safety'), 90 * 1000);
// The Solve watchdog and scratch sweep stay on the slow cadence; neither is latency-sensitive.
setInterval(() => { pollSolveWatch(); pollDispatchSweep(); }, 5 * 60 * 1000);
// Local-only cleanup of superseded Solve tabs — no network, no DO cost.
setInterval(() => pollSolveReap(), 15000);
// Notice a chatted-with terminal closing. Reads the local session registry only; it costs a
// relay request just once, on the transition, so an idle tick is free.
setInterval(() => reapGoneRcSessions(), 5000);
