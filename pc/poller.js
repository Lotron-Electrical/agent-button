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
const MAX_CHAT = 2;
let chatInFlight = 0;
const bq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'"; // single-quote for bash

function runClaudeTurn(job) {
  return new Promise((resolve) => {
    let msgFile;
    try {
      msgFile = path.join(CHAT_DIR, 'msg-' + job.agentId + '-' + process.hrtime.bigint() + '.txt');
      fs.writeFileSync(msgFile, String(job.message || ''));
    } catch (e) { return resolve({ error: 'write failed: ' + e.message }); }
    const cwdMsys = job.cwd && String(job.cwd).trim() ? toMsys(String(job.cwd).trim()) : DEFAULT_CWD;
    const resume = job.sessionId ? ('--resume ' + bq(job.sessionId) + ' ') : '';
    const cmd = 'cd ' + bq(cwdMsys) + ' && claude -p "$(cat ' + bq(toMsys(msgFile)) + ')" ' + resume +
                '--output-format json --dangerously-skip-permissions';
    let out = '', err = '', child;
    try { child = spawn(BASH, ['-c', cmd], { env: SPAWN_ENV, stdio: ['ignore', 'pipe', 'pipe'] }); }
    catch (e) { return resolve({ error: 'spawn: ' + e.message }); }
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => resolve({ error: 'spawn: ' + e.message }));
    child.on('close', (code) => {
      try { fs.unlinkSync(msgFile); } catch (_) {}
      let j = null; try { j = JSON.parse(out); } catch (_) {}
      if (j && typeof j.result === 'string' && !j.is_error) resolve({ reply: j.result, sessionId: j.session_id || job.sessionId });
      else if (j && typeof j.result === 'string') resolve({ error: 'agent: ' + j.result.slice(0, 400), sessionId: j.session_id || job.sessionId });
      else resolve({ error: (err.trim().slice(0, 300) || ('claude exited ' + code + ' with no JSON')) });
    });
  });
}

async function pollChat() {
  if (chatInFlight >= MAX_CHAT) return;
  let job = null;
  try {
    const r = await fetch(RELAY + '/chat/jobnext', { headers });
    if (r.ok) { const j = await r.json(); if (!j.empty) job = j; }
  } catch (_) { return; }
  if (!job) return;
  chatInFlight++;
  log('chat turn -> ' + job.agentId + (job.sessionId ? ' (resume)' : ' (new session)'));
  const res = await runClaudeTurn(job);
  try {
    await fetch(RELAY + '/chat/result', {
      method: 'POST', headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({ agentId: job.agentId, sessionId: res.sessionId || job.sessionId, reply: res.reply, error: res.error })
    });
  } catch (_) {}
  chatInFlight--;
  log('chat turn done -> ' + job.agentId + (res.error ? (' ERROR: ' + res.error) : ''));
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

async function loop() {
  log('poller online -> ' + RELAY + ' (every ' + POLL_MS + 'ms, default cwd ' + DEFAULT_CWD + ', reporting live agents)');
  for (;;) {
    try {
      const r = await fetch(RELAY + '/next', { headers });
      if (r.ok) {
        const j = await r.json();
        if (!j.empty) await handle(j);
      }
    } catch (e) {
      // network blips are normal (relay cold start etc.) — log sparsely
      if (!loop._q) { log('poll error:', e.message); loop._q = 1; setTimeout(() => (loop._q = 0), 60000); }
    }
    pollChat(); // fire-and-forget; guarded by chatInFlight
    reportStats(); // fire-and-forget; reports RAM/CPU to the dashboard
    await sleep(POLL_MS);
  }
}
loop();
