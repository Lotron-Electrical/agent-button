// agent-button relay, Cloudflare Worker edition.
// Same contract as the Node relay (server.js), always-on and free. The queue lives in a
// single Durable Object (strongly consistent, instant read-after-write — unlike KV, which
// caches reads at the edge for up to 60s and would make the poller miss fresh tasks).
import HTML from './app.html';
import AGENTS from './agents.html';
import CHAT from './chat.html';
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

# IF YOU GET STUCK BUT THE WORK CAN CONTINUE (never just give up)
When you hit a wall, run low on context, or judge the problem too large to finish this session:
1. Write a thorough, honest handover to ${ho}.
2. Hand off to your successor (it reads the handover and continues):
   curl -s -X POST '${relay}/solve/next' ${auth} -d '{"solveId":"${solveId}"}'
3. Then stop. The successor takes over.

# IF YOU ARE BLOCKED ON SOMETHING ONLY A HUMAN CAN PROVIDE
If real progress is impossible without an external input only Lloyd can give (a file, a login or credential, a gated/paywalled resource, a decision) — do NOT spin, and do NOT fabricate progress just to look busy. Instead:
1. Write the handover, stating exactly what is needed and why nothing else can move without it.
2. Pause the relay and ping Lloyd:
   curl -s -X POST '${relay}/solve/await' ${auth} -d '{"solveId":"${solveId}","need":"<one line: what you need from Lloyd>"}'
The relay then pauses (it will NOT auto-spawn a successor) until Lloyd provides it and resumes you. Use this ONLY for genuine external blockers, never as an escape hatch from hard work.

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
    if (p === '/solve/await' && method === 'POST') {         // an agent: blocked, needs external human input
      if (!authed()) return json({ error: 'unauthorized' }, 401);
      return queueStub(env).fetch('https://do/solveawait', { method: 'POST', body: await req.text() });
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

    return new Response('not found', { status: 404 });
  }
};

// Strongly-consistent queue. One instance ('main') serializes all ops.
export class QueueDO {
  constructor(state, env) {
    this.storage = state.storage;
    this.env = env;
  }
  async fetch(request) {
    const op = new URL(request.url).pathname.slice(1); // 'enqueue' | 'next' | 'ack' | 'status/<id>'

    if (op === 'enqueue') {
      const item = await request.json();
      const q = (await this.storage.get('queue')) || [];
      q.push(item);
      while (q.length > 50) q.shift();
      await this.storage.put('queue', q);
      await this.storage.put('a:' + item.id, { id: item.id, status: 'pending', ts: Date.now() });
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
      return json({ ok: true });
    }
    if (op === 'chatget') {
      const id = new URL(request.url).searchParams.get('id');
      const agents = (await this.storage.get('chatagents')) || [];
      return json({ agent: agents.find((a) => a.id === id) || null, messages: (await this.storage.get('msgs:' + id)) || [] });
    }
    if (op === 'chatlist') {
      return json({
        agents: (await this.storage.get('chatagents')) || [],
        external: (await this.storage.get('external')) || [],
        externalTs: (await this.storage.get('externalTs')) || 0,
        solves: (await this.storage.get('solves')) || [],
        stats: (await this.storage.get('stats')) || null,
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
      const b = await request.json(); // {task, cwd, endless}
      const task = String(b.task || '').trim();
      if (!task) return json({ error: 'task required' }, 400);
      const slug = (task.split('\n')[0].toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 22)) || 'agent';
      const name = 'ag-' + slug + '-' + crypto.randomUUID().replace(/-/g, '').slice(0, 4);
      const prompt = b.endless
        ? (task + '\n\nWork autonomously and keep going until this is fully solved and verified. Do not stop or wait for further input until it is done.')
        : task;
      const spawns = (await this.storage.get('spawns')) || [];
      spawns.push({ name, prompt, cwd: String(b.cwd || ''), ts: Date.now() });
      await this.storage.put('spawns', spawns.slice(-20));
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
      const b = await request.json(); // {goal, cwd, relay}
      const goal = String(b.goal || '').trim();
      if (!goal) return json({ error: 'goal required' }, 400);
      const solveId = 'sv' + crypto.randomUUID().replace(/-/g, '').slice(0, 6);
      const now = Date.now();
      const cwd = String(b.cwd || '');
      const solves = (await this.storage.get('solves')) || [];
      solves.unshift({ id: solveId, title: goal.split('\n')[0].slice(0, 70), goal: goal.slice(0, 600), cwd, status: 'solving', generation: 1, createdAt: now, lastActivity: now, lastBeat: now, beatSinceSpawn: false, deadSpawns: 0, autoContinues: 0 });
      await this.storage.put('solves', solves.slice(0, 30));
      const spawns = (await this.storage.get('spawns')) || [];
      spawns.push({ name: solveId + '-g1', prompt: buildSolvePrompt(goal, 1, solveId, b.relay || '', this.env.BUTTON_TOKEN, true), cwd, ts: now });
      await this.storage.put('spawns', spawns.slice(-20));
      return json({ ok: true, id: solveId });
    }
    if (op === 'solvenext') {
      const b = await request.json(); // {solveId, relay}
      const solves = (await this.storage.get('solves')) || [];
      const sv = solves.find((x) => x.id === b.solveId);
      if (!sv) return json({ error: 'no such solve' }, 404);
      if (sv.status === 'solved') return json({ ok: true, alreadySolved: true });
      // 'stopped' / 'awaiting' relays are sticky: only an explicit user Resume (force:true) revives them,
      // so a still-running generation can't un-park a relay you deliberately halted.
      if ((sv.status === 'stopped' || sv.status === 'awaiting') && !b.force) return json({ ok: true, parked: sv.status });
      const now = Date.now();
      sv.generation = (sv.generation || 1) + 1; sv.status = 'solving'; sv.lastActivity = now;
      sv.lastBeat = now; sv.beatSinceSpawn = false; sv.deadSpawns = 0; delete sv.awaiting;
      await this.storage.put('solves', solves);
      const spawns = (await this.storage.get('spawns')) || [];
      spawns.push({ name: sv.id + '-g' + sv.generation, prompt: buildSolvePrompt(sv.goal, sv.generation, sv.id, b.relay || '', this.env.BUTTON_TOKEN, false), cwd: sv.cwd, ts: now });
      await this.storage.put('spawns', spawns.slice(-20));
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
    if (op === 'solveawait') {                               // an agent is blocked on external human input
      const b = await request.json().catch(() => ({}));
      const solves = (await this.storage.get('solves')) || [];
      const sv = solves.find((x) => x.id === b.solveId);
      if (sv && sv.status !== 'solved') {
        const now = Date.now();
        sv.status = 'awaiting';
        sv.awaiting = { need: String(b.need || 'external input').slice(0, 200), since: now };
        sv.lastActivity = now;
        await this.storage.put('solves', solves);
      }
      return json({ ok: true });
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
        if (sv.beatSinceSpawn === false && (sv.deadSpawns || 0) >= 2) {
          // three generations in a row spawned but never beat -> environment is broken, stop spinning
          sv.status = 'awaiting';
          sv.awaiting = { need: 'The last 3 generations failed to start or never checked in — the spawn path or environment may be broken. Check the poller, then Continue.', since: now };
          sv.lastActivity = now; paused.push(sv.id); changed = true; continue;
        }
        if (sv.beatSinceSpawn === false) sv.deadSpawns = (sv.deadSpawns || 0) + 1;
        sv.generation = (sv.generation || 1) + 1;
        sv.lastActivity = now; sv.lastBeat = now; sv.beatSinceSpawn = false;
        sv.autoContinues = (sv.autoContinues || 0) + 1;
        spawns.push({ name: sv.id + '-g' + sv.generation, prompt: buildSolvePrompt(sv.goal, sv.generation, sv.id, relay, this.env.BUTTON_TOKEN, false), cwd: sv.cwd, ts: now });
        respawned.push(sv.id + '-g' + sv.generation); changed = true;
      }
      if (changed) { await this.storage.put('solves', solves); await this.storage.put('spawns', spawns.slice(-20)); }
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

    return new Response('do: not found', { status: 404 });
  }
}
