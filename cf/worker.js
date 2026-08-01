// agent-button relay, Cloudflare Worker edition.
// Same contract as the Node relay (server.js), always-on and free. The queue lives in a
// single Durable Object (strongly consistent, instant read-after-write — unlike KV, which
// caches reads at the edge for up to 60s and would make the poller miss fresh tasks).
import HTML from './app.html';
import AGENTS from './agents.html';
import CHAT from './chat.html';
import RCCHAT from './rcchat.html';
import ICON192 from './icon-192.png';
import ICON512 from './icon-512.png';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const pngResp = (buf) =>
  new Response(buf, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });

// The one queue instance every request talks to.
const queueStub = (env) => env.QUEUE_DO.get(env.QUEUE_DO.idFromName('main'));

// ---- endless mode ----
const ENDLESS_PROTOCOL = '\n\n[ENDLESS MODE] Keep working autonomously until this task is fully solved. Make concrete progress every turn (read / edit / run / verify, do not just plan). When and ONLY when it is completely done and verified, include the exact marker [[SOLVED]] in your reply followed by a short summary. If it is not done yet, end your reply with the single concrete next step you will take, and you will automatically be asked to continue.';
const CONTINUE_MSG = 'Continue working on the task now. Pick up exactly where you left off and make concrete progress this turn.';
const wrapEndless = (t) => String(t || '') + ENDLESS_PROTOCOL;
const isSolved = (r) => /\[\[\s*SOLVED\s*\]\]/i.test(String(r || ''));

// ---- agent naming ----
// Auto-named agents get a readable colour word instead of the old 4 random hex chars, so an
// unnamed agent still reads like a name ("review-open-prs-crimson") rather than a serial number.
const COLOUR_WORDS = [
  'crimson', 'scarlet', 'amber', 'saffron', 'gold', 'olive', 'jade', 'emerald',
  'teal', 'cyan', 'azure', 'cobalt', 'indigo', 'violet', 'magenta', 'rose',
  'coral', 'copper', 'bronze', 'silver', 'slate', 'onyx', 'ivory', 'pearl',
  'mint', 'lime', 'moss', 'fern', 'ochre', 'rust', 'sienna', 'umber',
  'plum', 'orchid', 'lilac', 'denim', 'frost', 'ash', 'ember', 'clay'
];
// The DISPLAY name is whatever the user typed, kept verbatim — original case, spaces and
// punctuation preserved. Nothing downstream needs it sanitized: the CLI's --name /
// --remote-control take the string as-is (verified 2026-08-01 — "Name Space Test" came back
// unchanged from GET /v1/code/sessions, which is what the claude.ai Code tab header renders),
// and claude-tab.sh %q-escapes it into bash. So strip only what would break a Windows filename
// or a terminal title, and cap the length so a pasted paragraph can't become a name. A control
// char maps to a space rather than being dropped, so words cannot fuse.
const tameName = (s) => Array.from(String(s || ''))
  .map((ch) => (ch.codePointAt(0) < 32 || ch.codePointAt(0) === 127) ? ' ' : ch).join('')
  .replace(/[\\/:*?"<>|]+/g, ' ')   // illegal in a Windows filename
  .replace(/\s+/g, ' ')
  .trim().slice(0, 60).trim();
// Filesystem form of a name: the launcher/prompt/.claim filenames in the admin-queue. Kept
// plain ASCII so the elevated wrapper's `-like '*.sh'` scan and its BaseName -> .prompt.txt
// pairing keep working. Never shown to the user.
const slugify = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
// Final guard on a filesystem slug. Two things it must never be: empty (the launcher would be
// named ".sh" and the wrapper's BaseName pairing would break), or something that looks like a
// Solve generation — BOTH reapers key on ^(sv[0-9a-z]+)-g(\d+)$ (poller.js and
// claude-code-admin-wrapper.ps1), so an agent a user happens to name "Svc G2" must not be
// mistaken for relay generation 2 and have its "older generations" hunted down and closed.
const fsSlug = (s) => {
  const v = String(s || '').slice(0, 40).replace(/-+$/g, '');
  if (!v) return 'agent';
  return /^sv[0-9a-z]+-g\d+$/i.test(v) ? 'a-' + v : v;
};

// ---- Solve mode: a relay of agents that never gives up ----
const SOLVE_HANDOVER_BASE = '/c/Users/Lloyd Gibbs/.agent-button-spawns/solve/';
function buildSolvePrompt(goal, gen, solveId, relay, secret, firstGen) {
  const ho = SOLVE_HANDOVER_BASE + solveId + '/handover.md';
  const auth = "-H 'Authorization: Bearer " + secret + "' -H 'Content-Type: application/json'";
  return `You are a SOLVE-MODE agent, GENERATION ${gen} of a relay that does NOT stop until the problem is solved. If you cannot finish, you hand the problem to a fresh successor that continues exactly where you left off. No problem is ever abandoned.

# THE PROBLEM
${goal}

# SHARED HANDOVER FILE (persists across every generation)
${ho}
${firstGen ? 'You are generation 1. Run: mkdir -p "$(dirname ' + JSON.stringify(ho) + ')" and create the handover file as you work.' : 'READ THIS FILE FIRST. The previous generation stopped here. Continue from exactly where they left off; do not redo their dead-ends.'}

# HOW TO WORK
- Work relentlessly and concretely (read, edit, run, verify). Make real, verifiable progress this session.
- Continuously keep ${ho} updated: what you tried, what is ruled out, what you learned, the single most promising next step, and the exact state/files to resume from.

# HEARTBEAT (so the watchdog knows you are alive)
At the START of every turn, and again right before you launch any long-running command, send:
   curl -s -X POST '${relay}/solve/beat' ${auth} -d '{"solveId":"${solveId}"}'
A watchdog automatically spawns your successor if you go silent for 30 minutes. Beat often. If a command will run longer than that, start it in the background and keep beating while it runs.

# WHEN YOU GET STUCK OR RUN LOW ON CONTEXT (never just give up)
When you hit a wall, run low on context, or judge the problem too large to finish this session:
1. Write a thorough, honest handover to ${ho}.
2. Hand off to your successor (it reads the handover and continues):
   curl -s -X POST '${relay}/solve/next' ${auth} -d '{"solveId":"${solveId}","gen":${gen}}'
3. Then stop. The successor takes over and keeps working.

# YOU NEVER STOP AND WAIT FOR LLOYD
There is NO "pause until a human helps". If some external input only Lloyd could provide (a file, a login, a gated resource) would unlock a FASTER path, note it as an OPTIONAL hint and keep going regardless — do not stall, do not fabricate filler:
   curl -s -X POST '${relay}/solve/wants' ${auth} -d '{"solveId":"${solveId}","gen":${gen},"need":"<one line: what would help; optional>"}'
That call is NON-BLOCKING: it records the hint AND immediately hands off to a successor that keeps attacking other angles (new mechanisms, untried lanes, any external data you can fetch yourself). The relay never waits on Lloyd. It ends only on a real /solve/done, or when Lloyd presses Stop.

# WHEN GENUINELY SOLVED (and verified)
1. Write the solution + how you verified it to ${ho}.
2. Mark it done:
   curl -s -X POST '${relay}/solve/done' ${auth} -d '{"solveId":"${solveId}","summary":"<one-line result>"}'

Hand off rather than quit. The relay continues, generation after generation, until the problem is solved — or until it honestly needs Lloyd.`;
}

export default {
  async fetch(req, env) {
    const SECRET = env.BUTTON_TOKEN || '';
    const url = new URL(req.url);
    const p = url.pathname;
    const method = req.method;

    const authed = () => {
      const h = req.headers.get('authorization') || '';
      const tok = h.startsWith('Bearer ') ? h.slice(7) : (url.searchParams.get('s') || '');
      return SECRET && tok === SECRET;
    };

    // WebSocket upgrade: the PC poller's push channel. Forward to the DO, which owns the socket.
    if (p === '/ws') {
      if ((req.headers.get('Upgrade') || '').toLowerCase() !== 'websocket') return json({ error: 'expected websocket' }, 426);
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch(req);
    }

    if (p === '/health') return json({ ok: true });

    // button page (capability URL)
    if (SECRET && p === '/p/' + SECRET) {
      const html = HTML.replaceAll('__SECRET__', SECRET).replaceAll('__START__', '/p/' + SECRET);
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }
    // agent dashboard page (capability URL)
    if (SECRET && p === '/p/' + SECRET + '/agents') {
      const html = AGENTS.replaceAll('__SECRET__', SECRET).replaceAll('__START__', '/p/' + SECRET);
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }
    // in-app chat page (capability URL)
    if (SECRET && p === '/p/' + SECRET + '/chat') {
      const html = CHAT.replaceAll('__SECRET__', SECRET).replaceAll('__START__', '/p/' + SECRET);
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }
    // terminal-agent chat page: the same real agent the claude.ai Code tab talks to, over /rc/*
    if (SECRET && p === '/p/' + SECRET + '/rc') {
      const html = RCCHAT.replaceAll('__SECRET__', SECRET).replaceAll('__START__', '/p/' + SECRET);
      return new Response(html, { headers: { 'content-type': 'text/html;charset=utf-8' } });
    }
    if (SECRET && p === '/p/' + SECRET + '/manifest.webmanifest') {
      return new Response(JSON.stringify({
        name: 'Spawn Agents', short_name: 'Agents',
        start_url: '/p/' + SECRET, scope: '/p/' + SECRET,
        display: 'standalone', orientation: 'portrait',
        background_color: '#0d0d0d', theme_color: '#C15F3C',
        icons: [
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
        ]
      }), { headers: { 'content-type': 'application/manifest+json' } });
    }

    if (p === '/icon-192.png') return pngResp(ICON192);
    if (p === '/icon-512.png') return pngResp(ICON512);

    // ---- phone -> relay ----
    if (p === '/enqueue' && method === 'POST') {
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => ({}));
      let task = (typeof b.task === 'string' ? b.task : '').trim();
      if (!task) return json({ error: 'task required' }, 400);
      if (task.length > 6000) task = task.slice(0, 6000);
      const count = Math.max(1, Math.min(4, parseInt(b.count, 10) || 1));
      const cwd = (typeof b.cwd === 'string' ? b.cwd : '').trim();
      const autoClose = b.autoClose !== false;
      const item = { id: crypto.randomUUID().slice(0, 8), task, count, cwd, autoClose, ts: Date.now() };
      return queueStub(env).fetch('https://do/enqueue', { method: 'POST', body: JSON.stringify(item) });
    }

    // ---- relay -> PC poller ----
    if (p === '/next') {
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/next', { method: 'POST' });
    }

    // ---- PC poller -> relay ----
    if (p === '/ack' && method === 'POST') {
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => ({}));
      if (!b.id) return json({ error: 'id required' }, 400);
      return queueStub(env).fetch('https://do/ack', {
        method: 'POST',
        body: JSON.stringify({ id: b.id, spawned: b.spawned, error: b.error })
      });
    }

    // ---- phone polls for confirmation ----
    if (p.startsWith('/status/')) {
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const id = decodeURIComponent(p.slice('/status/'.length));
      return queueStub(env).fetch('https://do/status/' + encodeURIComponent(id), { method: 'POST' });
    }

    // ---- in-app chat agents (headless, driven by the poller via claude -p --resume) ----
    if (p === '/chat/new' && method === 'POST') {            // phone: start a new chat agent
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/chatnew', { method: 'POST', body: await req.text() });
    }
    if (p === '/chat/send' && method === 'POST') {           // phone: send a message to an agent
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/chatsend', { method: 'POST', body: await req.text() });
    }
    if (p === '/chat/close' && method === 'POST') {          // phone: close (remove) an agent
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/chatclose', { method: 'POST', body: await req.text() });
    }
    if (p === '/chat/stop' && method === 'POST') {           // phone: stop endless mode on an agent
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/chatstop', { method: 'POST', body: await req.text() });
    }
    if (p === '/spawn' && method === 'POST') {               // phone: spawn a real interactive terminal agent
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/spawnnew', { method: 'POST', body: await req.text() });
    }
    if (p === '/spawn-next') {                               // poller: pull the next terminal to open
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/spawnnext', { method: 'POST' });
    }
    if (p === '/solve/new' && method === 'POST') {           // phone: start a Solve relay (never gives up)
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => ({})); b.relay = url.origin;
      return queueStub(env).fetch('https://do/solvenew', { method: 'POST', body: JSON.stringify(b) });
    }
    if (p === '/solve/next' && method === 'POST') {          // an agent: hand off to the next generation
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => ({})); b.relay = url.origin;
      return queueStub(env).fetch('https://do/solvenext', { method: 'POST', body: JSON.stringify(b) });
    }
    if (p === '/solve/done' && method === 'POST') {          // an agent: the problem is solved
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/solvedone', { method: 'POST', body: await req.text() });
    }
    if (p === '/solve/beat' && method === 'POST') {          // an agent: heartbeat (alive + working)
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/solvebeat', { method: 'POST', body: await req.text() });
    }
    if ((p === '/solve/wants' || p === '/solve/await') && method === 'POST') { // an agent: external input would help (non-blocking, keeps going)
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => ({})); b.relay = url.origin;
      return queueStub(env).fetch('https://do/solvewants', { method: 'POST', body: JSON.stringify(b) });
    }
    if (p === '/solve/stop' && method === 'POST') {          // phone: hard-stop a relay
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/solvestop', { method: 'POST', body: await req.text() });
    }
    if (p === '/solve/watch' && method === 'POST') {         // poller: respawn stalled relays / pause crash-loops
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      const b = await req.json().catch(() => ({})); b.relay = url.origin;
      return queueStub(env).fetch('https://do/solvewatch', { method: 'POST', body: JSON.stringify(b) });
    }
    if (p === '/solve/delete' && method === 'POST') {        // phone: remove a relay from the list
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/solvedelete', { method: 'POST', body: await req.text() });
    }
    if (p === '/chat/get') {                                 // phone: fetch a conversation
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/chatget?id=' + encodeURIComponent(url.searchParams.get('id') || ''), { method: 'POST' });
    }
    if (p === '/chat/jobnext') {                             // poller: pull the next turn to run
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/jobnext', { method: 'POST' });
    }
    if (p === '/chat/result' && method === 'POST') {         // poller: post a turn's reply
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/chatresult', { method: 'POST', body: await req.text() });
    }
    if (p === '/stats' && method === 'POST') {               // poller: report PC RAM/CPU
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/statsset', { method: 'POST', body: await req.text() });
    }
    if (p === '/external' && method === 'POST') {             // poller: report other live Claude tabs
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/externalset', { method: 'POST', body: await req.text() });
    }
    if (p === '/agents') {                                   // dashboard: list chat agents + stats
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/chatlist', { method: 'POST' });
    }

    // ---- remote-control bridge: chat with a REAL terminal agent from inside this app ----
    // The poller is a second client of the same Claude Code session the claude.ai Code tab
    // talks to (see pc/rc-bridge.js). It streams the transcript in via /rc/push and sends
    // Lloyd's messages out via /rc/outnext; the phone reads with a long-poll on /rc/get.
    if (p === '/rc/sub' && method === 'POST') {               // phone: I have this session open (or closed it)
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/rcsub', { method: 'POST', body: await req.text() });
    }
    if (p === '/rc/get') {                                    // phone: long-poll the transcript
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/rcget' + url.search, { method: 'POST' });
    }
    if (p === '/rc/send' && method === 'POST') {              // phone: send a message to the agent
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/rcsend', { method: 'POST', body: await req.text() });
    }
    if (p === '/rc/push' && method === 'POST') {              // poller: new transcript frames
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/rcpush', { method: 'POST', body: await req.text() });
    }
    if (p === '/rc/outnext') {                                // poller: drain queued outbound messages
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/rcoutnext', { method: 'POST' });
    }

    return new Response('not found', { status: 404 });
  }
};

// ---- remote-control bridge tuning ----
const RC_CAP = 40;           // transcript messages kept per session (same ceiling as chatagents)
const RC_SUB_TTL = 75000;    // a subscription outlives ~3 missed 25s long-polls, then expires
const RC_WAIT_MS = 25000;    // long-poll hold. See the cost note on `rcget` before changing it.

// Strongly-consistent queue. One instance ('main') serializes all ops.
export class QueueDO {
  constructor(state, env) {
    this.state = state;
    this.storage = state.storage;
    this.env = env;
    // Parked /rc/get long-polls, in memory: sessionId -> Set of resolve callbacks. Only ever
    // populated while a request is in flight, and a DO cannot hibernate with one in flight,
    // so there is nothing to rebuild after a wake.
    this.rcWaiters = new Map();
  }

  // Nudge every connected poller that there is work to pull. Uses getWebSockets() (the live socket
  // set) rather than an in-memory list, so it still works after the DO has hibernated and woken.
  wake(what) {
    const msg = JSON.stringify({ type: 'wake', what: what || 'work', ts: Date.now() });
    for (const ws of this.state.getWebSockets()) { try { ws.send(msg); } catch (_) {} }
  }
  // Ask the poller for a fresh stats/external push. Only fired while the dashboard is open.
  nudgeStats() {
    const msg = JSON.stringify({ type: 'wantStats', ts: Date.now() });
    for (const ws of this.state.getWebSockets()) { try { ws.send(msg); } catch (_) {} }
  }
  // Tell the poller which sessions currently have a reader, so it opens an SSE stream for
  // exactly those and no others. Pushed over the existing socket rather than polled: a
  // subscription list the poller had to ask for would cost requests every drain, forever.
  pushSubs(subs) {
    const msg = JSON.stringify({ type: 'rcsubs', ids: Object.keys(subs || {}), ts: Date.now() });
    for (const ws of this.state.getWebSockets()) { try { ws.send(msg); } catch (_) {} }
  }
  async webSocketMessage(ws, message) {
    try {
      const m = typeof message === 'string' ? JSON.parse(message) : null;
      if (m && m.type === 'hello') {
        // The ack carries the live subscription list: a reconnecting poller (the socket drops
        // about a dozen times a day) re-syncs its streams without an extra request.
        const subs = (await this.storage.get('rcsubs')) || {};
        const now = Date.now();
        ws.send(JSON.stringify({ type: 'hello-ack', ts: now, rcsubs: Object.keys(subs).filter((k) => subs[k] > now) }));
      }
    } catch (_) {}
  }
  async webSocketClose(ws, code) { try { ws.close(code || 1000, 'bye'); } catch (_) {} }
  async webSocketError() {}

  // ---- remote-control bridge helpers ----
  // Drop expired subscriptions. A chat page that is closed without unsubscribing (phone
  // backgrounded, tab killed) stops renewing, so this is what eventually tears the stream down.
  async rcPrune(subs) {
    const s = subs || (await this.storage.get('rcsubs')) || {};
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(s)) if (!(s[k] > now)) { delete s[k]; changed = true; }
    if (changed) { await this.storage.put('rcsubs', s); this.pushSubs(s); }
    return s;
  }
  // Renew (or create) a lease on a session. A brand-new one is pushed to the poller straight
  // away so the SSE stream starts while the app's first long-poll is still in flight.
  async rcTouch(id) {
    if (!id) return;
    const subs = (await this.storage.get('rcsubs')) || {};
    const now = Date.now();
    let changed = !(subs[id] > now);
    for (const k of Object.keys(subs)) if (k !== id && !(subs[k] > now)) { delete subs[k]; changed = true; }
    // Skip the write while the existing lease is still fresh, so a 25s long-poll does not
    // rewrite this key on every hit for nothing.
    if (changed || subs[id] - now < RC_SUB_TTL / 2) {
      subs[id] = now + RC_SUB_TTL;
      await this.storage.put('rcsubs', subs);
      if (changed) this.pushSubs(subs);
    }
  }
  // Release every long-poll parked on this session.
  rcNotify(id) {
    const set = this.rcWaiters.get(id);
    if (!set || !set.size) return;
    const fns = [...set];
    set.clear();
    for (const fn of fns) { try { fn(); } catch (_) {} }
  }

  async fetch(request) {
    // The poller's push channel: accept a hibernatable WebSocket. While idle the DO hibernates
    // (no compute, no request billing) and ping/pong is auto-answered at the edge; producer ops
    // below call this.wake() to nudge the poller the instant work is queued. No busy-polling.
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      const pair = new WebSocketPair();
      this.state.acceptWebSocket(pair[1]);
      try { this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong')); } catch (_) {}
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    const op = new URL(request.url).pathname.slice(1); // 'enqueue' | 'next' | 'ack' | 'status/<id>'

    if (op === 'enqueue') {
      const item = await request.json();
      const q = (await this.storage.get('queue')) || [];
      q.push(item);
      while (q.length > 50) q.shift();
      await this.storage.put('queue', q);
      await this.storage.put('a:' + item.id, { id: item.id, status: 'pending', ts: Date.now() });
      this.wake('task');
      return json({ ok: true, id: item.id, queued: q.length });
    }

    if (op === 'next') {
      const q = (await this.storage.get('queue')) || [];
      if (!q.length) return json({ empty: true });
      const item = q.shift();
      await this.storage.put('queue', q);
      await this.storage.put('a:' + item.id, { id: item.id, status: 'taken', ts: Date.now() });
      return json(item);
    }

    if (op === 'ack') {
      const b = await request.json();
      await this.storage.put('a:' + b.id, {
        id: b.id, status: b.error ? 'error' : 'spawned',
        spawned: parseInt(b.spawned, 10) || 0, error: b.error || null, ts: Date.now()
      });
      return json({ ok: true });
    }

    if (op.startsWith('status/')) {
      const id = decodeURIComponent(op.slice('status/'.length));
      const a = await this.storage.get('a:' + id);
      if (a) return json(a);
      const q = (await this.storage.get('queue')) || [];
      if (q.some((x) => x.id === id)) return json({ id, status: 'pending' });
      return json({ id, status: 'unknown' });
    }

    // ---- chat agents ----
    if (op === 'chatnew') {
      const b = await request.json(); // {title, message, cwd, mode}
      const id = crypto.randomUUID().slice(0, 8);
      const now = Date.now();
      const endless = b.mode === 'endless';
      const agents = (await this.storage.get('chatagents')) || [];
      agents.unshift({ id, title: String(b.title || 'Agent').slice(0, 80), status: 'thinking', mode: endless ? 'endless' : 'chat', turns: 0, cwd: b.cwd || '', sessionId: null, createdAt: now, lastActivity: now, msgCount: 1 });
      await this.storage.put('chatagents', agents.slice(0, 40));
      await this.storage.put('msgs:' + id, [{ role: 'user', text: String(b.message || ''), ts: now }]);
      const jobs = (await this.storage.get('jobs')) || [];
      jobs.push({ agentId: id, message: endless ? wrapEndless(b.message) : String(b.message || ''), ts: now });
      await this.storage.put('jobs', jobs);
      this.wake('chat');
      return json({ ok: true, id });
    }
    if (op === 'chatsend') {
      const b = await request.json(); // {id, message}
      const agents = (await this.storage.get('chatagents')) || [];
      const ag = agents.find((a) => a.id === b.id);
      if (!ag) return json({ error: 'no such agent' }, 404);
      const now = Date.now();
      const msgs = (await this.storage.get('msgs:' + b.id)) || [];
      msgs.push({ role: 'user', text: String(b.message || ''), ts: now });
      await this.storage.put('msgs:' + b.id, msgs);
      ag.status = 'thinking'; ag.lastActivity = now; ag.msgCount = msgs.length;
      if (ag.mode === 'endless') ag.turns = 0; // a new user directive resets the turn budget
      await this.storage.put('chatagents', agents);
      const jobs = (await this.storage.get('jobs')) || [];
      jobs.push({ agentId: b.id, message: ag.mode === 'endless' ? wrapEndless(b.message) : String(b.message || ''), ts: now });
      await this.storage.put('jobs', jobs);
      this.wake('chat');
      return json({ ok: true });
    }
    if (op === 'chatget') {
      const id = new URL(request.url).searchParams.get('id');
      const agents = (await this.storage.get('chatagents')) || [];
      return json({ agent: agents.find((a) => a.id === id) || null, messages: (await this.storage.get('msgs:' + id)) || [] });
    }
    if (op === 'chatlist') {
      const stats = (await this.storage.get('stats')) || null;
      // dashboard is open and polling -> ask the poller for fresh telemetry, but only when it's stale.
      if (!stats || Date.now() - (stats.ts || 0) > 4000) this.nudgeStats();
      return json({
        agents: (await this.storage.get('chatagents')) || [],
        external: (await this.storage.get('external')) || [],
        externalTs: (await this.storage.get('externalTs')) || 0,
        solves: (await this.storage.get('solves')) || [],
        stats,
        ts: Date.now()
      });
    }
    if (op === 'statsset') {
      await this.storage.put('stats', await request.json());
      return json({ ok: true });
    }
    if (op === 'externalset') {
      const b = await request.json();
      await this.storage.put('external', b.external || []);
      await this.storage.put('externalTs', b.ts || Date.now());
      return json({ ok: true });
    }
    if (op === 'jobnext') {
      const jobs = (await this.storage.get('jobs')) || [];
      if (!jobs.length) return json({ empty: true });
      const job = jobs.shift();
      await this.storage.put('jobs', jobs);
      const agents = (await this.storage.get('chatagents')) || [];
      const ag = agents.find((a) => a.id === job.agentId) || {};
      return json({ agentId: job.agentId, message: job.message, sessionId: ag.sessionId || null, cwd: ag.cwd || '' });
    }
    if (op === 'chatresult') {
      const b = await request.json(); // {agentId, sessionId, reply, error}
      const agents = (await this.storage.get('chatagents')) || [];
      const ag = agents.find((a) => a.id === b.agentId);
      if (!ag) return json({ ok: true, dropped: true }); // agent was closed mid-turn -> discard reply
      const now = Date.now();
      const msgs = (await this.storage.get('msgs:' + b.agentId)) || [];
      msgs.push({ role: b.error ? 'system' : 'agent', text: b.error ? ('⚠ ' + b.error) : String(b.reply || '(no reply)'), ts: now });
      if (b.sessionId) ag.sessionId = b.sessionId;
      ag.lastActivity = now;
      if (ag.mode === 'endless' && !b.error) {
        if (isSolved(b.reply)) {
          ag.status = 'solved';
        } else {
          // uncapped: keep auto-continuing until [[SOLVED]], an error, or the user hits Stop
          ag.turns = (ag.turns || 0) + 1;
          ag.status = 'thinking';
          const jobs = (await this.storage.get('jobs')) || [];
          jobs.push({ agentId: ag.id, message: wrapEndless(CONTINUE_MSG), ts: now });
          await this.storage.put('jobs', jobs);
          this.wake('chat');
        }
      } else {
        ag.status = b.error ? 'error' : 'idle';
      }
      await this.storage.put('msgs:' + b.agentId, msgs);
      ag.msgCount = msgs.length;
      await this.storage.put('chatagents', agents);
      return json({ ok: true });
    }
    if (op === 'chatclose') {
      const b = await request.json(); // {id}
      await this.storage.put('chatagents', ((await this.storage.get('chatagents')) || []).filter((a) => a.id !== b.id));
      await this.storage.delete('msgs:' + b.id);
      await this.storage.put('jobs', ((await this.storage.get('jobs')) || []).filter((j) => j.agentId !== b.id));
      return json({ ok: true });
    }
    if (op === 'chatstop') {
      const b = await request.json(); // {id}  -> stop endless looping, keep the agent
      const agents = (await this.storage.get('chatagents')) || [];
      const ag = agents.find((a) => a.id === b.id);
      if (ag) { ag.mode = 'chat'; if (ag.status === 'thinking') ag.status = 'idle'; ag.lastActivity = Date.now(); await this.storage.put('chatagents', agents); }
      await this.storage.put('jobs', ((await this.storage.get('jobs')) || []).filter((j) => j.agentId !== b.id));
      const msgs = (await this.storage.get('msgs:' + b.id)) || [];
      msgs.push({ role: 'system', text: 'Endless mode stopped. The agent will wait for your next message.', ts: Date.now() });
      await this.storage.put('msgs:' + b.id, msgs);
      return json({ ok: true });
    }

    // ---- terminal-agent spawn queue (real interactive Claude Code windows) ----
    if (op === 'spawnnew') {
      const b = await request.json(); // {task, cwd, endless, reqId}
      const task = String(b.task || '').trim();
      if (!task) return json({ error: 'task required' }, 400);
      // Idempotency. Starting an agent is not a safe operation to run twice, and the phone is on
      // mobile data: a request that reaches us but whose response is lost looks identical to a
      // failure, so the user presses START again and gets a second agent (observed 2026-07-10).
      // The client sends a reqId that is stable across its retries of the same press, so a repeat
      // returns the original spawn instead of queueing another.
      const reqId = String(b.reqId || '').slice(0, 64);
      const keys = (await this.storage.get('spawnkeys')) || [];
      if (reqId) {
        const hit = keys.find((k) => k.k === reqId && Date.now() - k.ts < 15 * 60 * 1000);
        if (hit) return json({ ok: true, name: hit.name, duplicate: true });
      }
      const spawns = (await this.storage.get('spawns')) || [];
      // The name the user typed, used verbatim as the display name (see tameName above); the
      // filesystem-safe form lives on a separate `slug` field further down.
      const custom = tameName(b.name);
      let name;
      if (custom) {
        name = custom;
      } else {
        // Auto-name: <task-slug>-<colour>. No hostname prefix (that is the CLI's own default for
        // UNnamed sessions, not something we should be imitating), and a readable colour word
        // instead of the old 4 hex chars — same spirit as the FIRST/SECOND codename arrays used
        // elsewhere. Collisions re-roll the colour rather than growing a hex tail.
        const stem = slugify(task.split('\n')[0]).slice(0, 22).replace(/-+$/g, '') || 'agent';
        name = stem + '-' + COLOUR_WORDS[Math.floor(Math.random() * COLOUR_WORDS.length)];
      }
      // Suffix a collision rather than honor it: a same-named launcher still sitting in the
      // admin-queue would be overwritten before it is claimed, and a name minted <60min ago
      // (the queue's launcher purge horizon) is likely a still-live session. Compare on the SLUG,
      // not the display name — the slug is what becomes a filename, and two different display
      // names ("Rental Search" / "rental-search") can collide there while looking distinct.
      const taken = new Set();
      for (const x of spawns) taken.add(x.slug || slugify(x.name));
      for (const k of keys) if (k.name && Date.now() - k.ts < 60 * 60 * 1000) taken.add(k.slug || slugify(k.name));
      let slug = fsSlug(slugify(name));
      if (taken.has(slug)) {
        if (custom) {
          let n = 2;
          while (taken.has(fsSlug(slugify(name + ' ' + n)))) n++;
          name = name + ' ' + n;
        } else {
          const stem = name.slice(0, name.lastIndexOf('-'));
          let tries = 0;
          do { name = stem + '-' + COLOUR_WORDS[Math.floor(Math.random() * COLOUR_WORDS.length)]; }
          while (taken.has(fsSlug(slugify(name))) && ++tries < 12);
          if (taken.has(fsSlug(slugify(name)))) { let n = 2; while (taken.has(fsSlug(slugify(name + '-' + n)))) n++; name = name + '-' + n; }
        }
        slug = fsSlug(slugify(name));
      }
      const prompt = b.endless
        ? (task + '\n\nWork autonomously and keep going until this is fully solved and verified. Do not stop or wait for further input until it is done.')
        : task;
      spawns.push({ name, slug, prompt, cwd: String(b.cwd || ''), dispatch: !!b.dispatch, goal: task, ts: Date.now() });
      await this.storage.put('spawns', spawns.slice(-20));
      if (reqId) {
        keys.push({ k: reqId, name, slug, ts: Date.now() });
        await this.storage.put('spawnkeys', keys.slice(-40));
      }
      this.wake('spawn');
      return json({ ok: true, name });
    }
    if (op === 'spawnnext') {
      const spawns = (await this.storage.get('spawns')) || [];
      if (!spawns.length) return json({ empty: true });
      const s = spawns.shift();
      await this.storage.put('spawns', spawns);
      return json(s);
    }

    // ---- Solve mode (relay of never-give-up agents) ----
    if (op === 'solvenew') {
      const b = await request.json(); // {goal, cwd, relay, reqId}
      const goal = String(b.goal || '').trim();
      if (!goal) return json({ error: 'goal required' }, 400);
      // Same idempotency guard as spawnnew, and it matters more here: a duplicate Solve is two
      // never-give-up relays grinding the same goal forever, each spawning its own generations.
      const reqId = String(b.reqId || '').slice(0, 64);
      const keys = (await this.storage.get('spawnkeys')) || [];
      if (reqId) {
        const hit = keys.find((k) => k.k === reqId && Date.now() - k.ts < 15 * 60 * 1000);
        if (hit) return json({ ok: true, id: hit.name, duplicate: true });
      }
      const now = Date.now();
      const cwd = String(b.cwd || '');
      const solves = (await this.storage.get('solves')) || [];
      // The user can name the relay: its id becomes sv<slug> (hyphens stripped) so generation
      // names like svcheckhero-g2 still match the ^(sv[0-9a-z]+)-g(\d+)$ convention that BOTH
      // the poller's scratch reap and the elevated wrapper's window reap key on. Do not put
      // hyphens inside the id — the regexes would stop matching and husk tabs would pile up.
      const customId = String(b.name || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 20);
      let solveId = 'sv' + (customId || crypto.randomUUID().replace(/-/g, '').slice(0, 6));
      while (solves.some((x) => x.id === solveId)) solveId += crypto.randomUUID().replace(/-/g, '').slice(0, 2);
      // The card title is the name exactly as typed. Only the id is squashed, and only because
      // the two reapers' ^(sv[0-9a-z]+)-g(\d+)$ regexes demand it.
      const titleName = tameName(b.name);
      solves.unshift({ id: solveId, title: titleName || goal.split('\n')[0].slice(0, 70), goal: goal.slice(0, 600), cwd, dispatch: !!b.dispatch, status: 'solving', generation: 1, createdAt: now, lastActivity: now, lastBeat: now, beatSinceSpawn: false, deadSpawns: 0, autoContinues: 0 });
      await this.storage.put('solves', solves.slice(0, 30));
      const spawns = (await this.storage.get('spawns')) || [];
      spawns.push({ name: solveId + '-g1', prompt: buildSolvePrompt(goal, 1, solveId, b.relay || '', this.env.BUTTON_TOKEN, true), cwd, dispatch: !!b.dispatch, goal: goal.slice(0, 600), ts: now });
      await this.storage.put('spawns', spawns.slice(-20));
      if (reqId) {
        keys.push({ k: reqId, name: solveId, ts: now });
        await this.storage.put('spawnkeys', keys.slice(-40));
      }
      this.wake('solve');
      return json({ ok: true, id: solveId, title: titleName });
    }
    if (op === 'solvenext') {
      const b = await request.json(); // {solveId, relay}
      const solves = (await this.storage.get('solves')) || [];
      const sv = solves.find((x) => x.id === b.solveId);
      if (!sv) return json({ error: 'no such solve' }, 404);
      if (sv.status === 'solved') return json({ ok: true, alreadySolved: true });
      // a Stopped relay is sticky: only an explicit user Resume (force:true) revives it.
      if (sv.status === 'stopped' && !b.force) return json({ ok: true, parked: 'stopped' });
      // generation guard: ignore a hand-off from a superseded generation, so the relay can't fork.
      if (typeof b.gen === 'number' && b.gen !== sv.generation) return json({ ok: true, superseded: true });
      const now = Date.now();
      sv.generation = (sv.generation || 1) + 1; sv.status = 'solving'; sv.lastActivity = now;
      sv.lastBeat = now; sv.beatSinceSpawn = false; sv.deadSpawns = 0; delete sv.awaiting;
      await this.storage.put('solves', solves);
      const spawns = (await this.storage.get('spawns')) || [];
      spawns.push({ name: sv.id + '-g' + sv.generation, prompt: buildSolvePrompt(sv.goal, sv.generation, sv.id, b.relay || '', this.env.BUTTON_TOKEN, false), cwd: sv.cwd, dispatch: !!sv.dispatch, goal: sv.goal, ts: now });
      await this.storage.put('spawns', spawns.slice(-20));
      this.wake('solve');
      return json({ ok: true, generation: sv.generation });
    }
    if (op === 'solvedone') {
      const b = await request.json(); // {solveId, summary}
      const solves = (await this.storage.get('solves')) || [];
      const sv = solves.find((x) => x.id === b.solveId);
      if (sv) { sv.status = 'solved'; sv.summary = String(b.summary || '').slice(0, 300); sv.lastActivity = Date.now(); delete sv.awaiting; await this.storage.put('solves', solves); }
      return json({ ok: true });
    }
    if (op === 'solvebeat') {                                // an agent says: alive + working
      const b = await request.json().catch(() => ({}));
      const solves = (await this.storage.get('solves')) || [];
      const sv = solves.find((x) => x.id === b.solveId);
      if (sv && sv.status === 'solving') {
        const now = Date.now();
        sv.lastBeat = now; sv.beatSinceSpawn = true; sv.deadSpawns = 0; sv.lastActivity = now;
        await this.storage.put('solves', solves);
      }
      return json({ ok: true });
    }
    if (op === 'solvewants') {                               // an agent: an external input WOULD help -> flag it (non-blocking) and keep going
      const b = await request.json().catch(() => ({}));
      const solves = (await this.storage.get('solves')) || [];
      const sv = solves.find((x) => x.id === b.solveId);
      if (!sv) return json({ error: 'no such solve' }, 404);
      if (sv.status === 'solved') return json({ ok: true, alreadySolved: true });
      if (sv.status === 'stopped' && !b.force) return json({ ok: true, parked: 'stopped' });
      if (typeof b.gen === 'number' && b.gen !== sv.generation) return json({ ok: true, superseded: true });
      const now = Date.now();
      if (b.need) sv.wants = { need: String(b.need).slice(0, 200), since: now }; // a non-blocking hint shown on the dashboard
      // keep going: hand off to a successor exactly like solvenext (the relay NEVER pauses for a human)
      sv.generation = (sv.generation || 1) + 1; sv.status = 'solving'; sv.lastActivity = now;
      sv.lastBeat = now; sv.beatSinceSpawn = false; sv.deadSpawns = 0; delete sv.awaiting;
      await this.storage.put('solves', solves);
      const spawns = (await this.storage.get('spawns')) || [];
      spawns.push({ name: sv.id + '-g' + sv.generation, prompt: buildSolvePrompt(sv.goal, sv.generation, sv.id, b.relay || '', this.env.BUTTON_TOKEN, false), cwd: sv.cwd, dispatch: !!sv.dispatch, goal: sv.goal, ts: now });
      await this.storage.put('spawns', spawns.slice(-20));
      this.wake('solve');
      return json({ ok: true, generation: sv.generation });
    }
    if (op === 'solvestop') {                                // phone: hard-stop a relay
      const b = await request.json().catch(() => ({}));
      const solves = (await this.storage.get('solves')) || [];
      const sv = solves.find((x) => x.id === b.solveId);
      if (sv) { sv.status = 'stopped'; delete sv.awaiting; sv.lastActivity = Date.now(); await this.storage.put('solves', solves); }
      // drop any queued (not-yet-opened) generation for this relay
      const spawns = (await this.storage.get('spawns')) || [];
      const kept = spawns.filter((s) => !(s.name && s.name.startsWith((b.solveId || '\0') + '-g')));
      if (kept.length !== spawns.length) await this.storage.put('spawns', kept);
      return json({ ok: true });
    }
    if (op === 'solvewatch') {                               // poller: keep relays alive (auto-continue / pause crash-loops)
      const b = await request.json().catch(() => ({}));
      const relay = b.relay || '';
      const solves = (await this.storage.get('solves')) || [];
      const now = Date.now();
      const STALL_MS = (typeof b.stallMs === 'number' && b.stallMs >= 0) ? b.stallMs : 30 * 60 * 1000;
      const spawns = (await this.storage.get('spawns')) || [];
      const respawned = [], paused = [];
      let changed = false;
      for (const sv of solves) {
        if (sv.status !== 'solving') continue;               // skip awaiting / stopped / solved
        if (typeof sv.lastBeat !== 'number') continue;       // legacy relays opted out of the watchdog
        if (now - sv.lastBeat <= STALL_MS) continue;         // still checking in
        // never pause: even a run of generations that fail to check in just keeps getting retried
        // (deadSpawns is only tracked so the poller can log a warning if the spawn path looks broken).
        if (sv.beatSinceSpawn === false) sv.deadSpawns = (sv.deadSpawns || 0) + 1;
        sv.generation = (sv.generation || 1) + 1;
        sv.lastActivity = now; sv.lastBeat = now; sv.beatSinceSpawn = false;
        sv.autoContinues = (sv.autoContinues || 0) + 1;
        spawns.push({ name: sv.id + '-g' + sv.generation, prompt: buildSolvePrompt(sv.goal, sv.generation, sv.id, relay, this.env.BUTTON_TOKEN, false), cwd: sv.cwd, dispatch: !!sv.dispatch, goal: sv.goal, ts: now });
        respawned.push(sv.id + '-g' + sv.generation); changed = true;
      }
      if (changed) { await this.storage.put('solves', solves); await this.storage.put('spawns', spawns.slice(-20)); }
      if (respawned.length) this.wake('solve');
      return json({ respawned, paused });
    }
    if (op === 'solvedelete') {                              // phone: remove a relay from the list
      const b = await request.json().catch(() => ({}));
      const solves = (await this.storage.get('solves')) || [];
      await this.storage.put('solves', solves.filter((x) => x.id !== b.solveId));
      const spawns = (await this.storage.get('spawns')) || [];
      const kept = spawns.filter((s) => !(s.name && s.name.startsWith((b.solveId || '\0') + '-g')));
      if (kept.length !== spawns.length) await this.storage.put('spawns', kept);
      return json({ ok: true });
    }

    // ---- remote-control bridge ----
    // Storage: rcmsgs:<sessionId> = {n, messages:[{n,role,text,ts,uuid}], status, activity},
    // rcsubs = {sessionId: expiresAt}, rcout = [{sessionId, text, uuid, ts}].
    // `n` is a per-session monotonic counter the phone uses as its read cursor; it is ours,
    // not the API's sequence_num, because a locally echoed message has no sequence number yet.
    if (op === 'rcsub') {
      const b = await request.json().catch(() => ({}));
      const id = String(b.sessionId || '');
      if (!id) return json({ error: 'sessionId required' }, 400);
      if (b.off) {
        const subs = (await this.storage.get('rcsubs')) || {};
        if (id in subs) { delete subs[id]; await this.storage.put('rcsubs', subs); this.pushSubs(subs); }
        this.rcNotify(id);                       // release any long-poll parked on this session
        return json({ ok: true, off: true });
      }
      await this.rcTouch(id);
      return json({ ok: true });
    }

    if (op === 'rcget') {
      const u = new URL(request.url);
      const id = String(u.searchParams.get('id') || '');
      const after = parseInt(u.searchParams.get('after') || '0', 10) || 0;
      const wait = u.searchParams.get('wait') === '1';
      if (!id) return json({ error: 'id required' }, 400);
      await this.rcTouch(id);
      const fresh = (r) => (r && Array.isArray(r.messages)) ? r.messages.filter((m) => m.n > after) : [];
      let rec = (await this.storage.get('rcmsgs:' + id)) || null;
      // Park until something arrives. COST NOTE: this trades request count for duration - a
      // parked request keeps the DO active for the hold. At 25s an open chat page costs ~144
      // requests/hour; the 2-second interval poll cf/chat.html uses would cost ~1800/hour and
      // burn the 100k/day free tier on its own. Do not turn this back into an interval poll.
      if (wait && !fresh(rec).length) {
        await new Promise((resolve) => {
          const set = this.rcWaiters.get(id) || new Set();
          let done = false;
          const fire = () => { if (done) return; done = true; clearTimeout(timer); set.delete(fire); resolve(); };
          const timer = setTimeout(fire, RC_WAIT_MS);
          set.add(fire);
          this.rcWaiters.set(id, set);
        });
        rec = (await this.storage.get('rcmsgs:' + id)) || null;
      }
      return json({
        messages: fresh(rec),
        n: rec ? (rec.n || 0) : 0,
        status: rec ? rec.status : null,
        activity: rec ? rec.activity : null,
        ts: Date.now()
      });
    }

    if (op === 'rcpush') {                       // poller: normalized transcript frames
      const b = await request.json().catch(() => ({}));
      const id = String(b.sessionId || '');
      if (!id) return json({ error: 'sessionId required' }, 400);
      const rec = (await this.storage.get('rcmsgs:' + id)) || { n: 0, messages: [], status: null, activity: null };
      // Dedupe on uuid. Three different paths can deliver the same message: an SSE replay
      // after the poller restarts (it re-reads from sequence 0), the agent echoing a turn back
      // out, and the local echo rcsend already wrote. All three carry the same uuid, so this
      // one guard covers all of them.
      const seen = new Set(rec.messages.map((m) => m.uuid).filter(Boolean));
      for (const m of (Array.isArray(b.messages) ? b.messages : [])) {
        const uuid = m && m.uuid ? String(m.uuid) : null;
        if (uuid && seen.has(uuid)) continue;
        const text = String((m && m.text) || '').slice(0, 8000);
        if (!text) continue;
        if (uuid) seen.add(uuid);
        rec.n = (rec.n || 0) + 1;
        rec.messages.push({
          n: rec.n,
          role: m.role === 'user' ? 'user' : (m.role === 'system' ? 'system' : 'agent'),
          text, ts: m.ts || Date.now(), uuid
        });
      }
      if (rec.messages.length > RC_CAP) rec.messages = rec.messages.slice(-RC_CAP);
      if (b.status) rec.status = b.status;
      rec.activity = b.activity || null;         // null clears the "using <tool>" indicator
      rec.ts = Date.now();
      await this.storage.put('rcmsgs:' + id, rec);
      this.rcNotify(id);
      return json({ ok: true, n: rec.n });
    }

    if (op === 'rcsend') {                       // phone: queue a message for the terminal agent
      const b = await request.json().catch(() => ({}));
      const id = String(b.sessionId || '');
      const text = String(b.text || '').trim();
      if (!id || !text) return json({ error: 'sessionId and text required' }, 400);
      // The uuid is minted by the phone and carried unchanged to the Anthropic POST, which
      // dedupes on it. A retry after a lost response therefore cannot double-send, and the
      // local echo written here is recognised (not duplicated) when it streams back.
      const uuid = String(b.uuid || crypto.randomUUID());
      const now = Date.now();
      const rec = (await this.storage.get('rcmsgs:' + id)) || { n: 0, messages: [], status: null, activity: null };
      if (!rec.messages.some((m) => m.uuid === uuid)) {
        rec.n = (rec.n || 0) + 1;
        rec.messages.push({ n: rec.n, role: 'user', text: text.slice(0, 8000), ts: now, uuid });
        if (rec.messages.length > RC_CAP) rec.messages = rec.messages.slice(-RC_CAP);
        rec.ts = now;
        await this.storage.put('rcmsgs:' + id, rec);
      }
      const out = (await this.storage.get('rcout')) || [];
      if (!out.some((x) => x.uuid === uuid)) out.push({ sessionId: id, text, uuid, ts: now });
      await this.storage.put('rcout', out.slice(-40));
      await this.rcTouch(id);
      this.wake('rc');
      this.rcNotify(id);                         // the sender's own long-poll returns at once
      return json({ ok: true, uuid, n: rec.n });
    }

    if (op === 'rcoutnext') {                    // poller: drain outbound + re-sync subscriptions
      const out = (await this.storage.get('rcout')) || [];
      if (out.length) await this.storage.put('rcout', []);
      // Riding the subscription list back on this response is free, and it is the backstop for
      // a pushSubs that got lost with a dropped socket.
      const subs = await this.rcPrune();
      return json({ items: out, subs: Object.keys(subs) });
    }

    return new Response('do: not found', { status: 404 });
  }
}
