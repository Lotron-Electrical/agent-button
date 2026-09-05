// agent-button remote-control bridge.
//
// Makes the poller a SECOND CLIENT of the same Claude Code remote-control session the
// claude.ai Code tab talks to, so Lloyd can chat with a real terminal agent inside his own
// app. Downstream: an SSE stream of the session transcript. Upstream: a POST that lands in
// the agent's input exactly like a message typed in the claude.ai app.
//
// This is a PRIVATE, UNDOCUMENTED Anthropic API (his own account, his own credentials, his
// own sessions). It can change without notice, so every failure here is soft: the bridge
// reports `status:'error'` upstream and the app falls back to the "Open in Claude" link.
//
// Contract proven on the wire 2026-08-01 (see the plan file's "Step 0 - DONE" section):
//   GET  /v1/code/sessions/{cse_id}/events/stream?from_sequence_num=N  -> text/event-stream
//   POST /v1/code/sessions/{cse_id}/events   {"events":[{"payload":{...}}]}
//   headers: Authorization: Bearer <oauth>, anthropic-version, anthropic-beta (all three
//   required - without anthropic-version you get a 400).
const fs = require('fs');
const os = require('os');
const path = require('path');
const https = require('https');

const API_HOST = 'api.anthropic.com';
const CRED_PATH = path.join(os.homedir(), '.claude', '.credentials.json');
const API_HEADERS = { 'anthropic-version': '2023-06-01', 'anthropic-beta': 'oauth-2025-04-20' };

// Everything inside agent-button addresses a session by the id on disk in
// ~/.claude/sessions/<pid>.json, which is `session_<ULID>`. Only the HTTP layer uses the
// API's `cse_<ULID>` form - same ULID, different prefix. Converting in exactly one place
// keeps the app, the worker and the DO free of prefix trivia.
function apiId(id) {
  const s = String(id || '');
  if (s.startsWith('cse_')) return s;
  if (s.startsWith('session_')) return 'cse_' + s.slice(8);
  return s;
}

// ---------- credentials ----------
// The OAuth token rotates roughly every 8 hours (that rotation is the whole premise of the
// existing rc-bridge-monitor.js), so we never hold one for long: cached for a minute, and
// force-re-read the instant anything answers 401.
let tokCache = { tok: null, ts: 0 };
function readToken(force) {
  if (!force && tokCache.tok && Date.now() - tokCache.ts < 60000) return tokCache.tok;
  let tok = null;
  try {
    const cred = JSON.parse(fs.readFileSync(CRED_PATH, 'utf8'));
    tok = (cred && cred.claudeAiOauth && cred.claudeAiOauth.accessToken) || null;
  } catch (_) { tok = null; }
  tokCache = { tok, ts: Date.now() };
  return tok;
}

// ---------- frame normalization ----------
// Reduces the raw event stream to the two things a chat UI can show: messages and "what is
// it doing right now". Shapes below are from real captured frames, not from guessing.
//
//   assistant/worker  content:[{type:'text'}]      -> an agent message
//   assistant/worker  content:[{type:'tool_use'}]  -> activity only (tool name), no message
//   assistant/worker  content:[{type:'thinking'}]  -> dropped
//   user/*            content:"<string>"           -> a human turn. NOTE source is 'worker'
//                                                     when typed at the terminal (and for the
//                                                     session's opening prompt) and 'client'
//                                                     when posted by claude.ai or by us, so
//                                                     filtering on source alone would hide
//                                                     everything Lloyd types at the keyboard.
//   user/*            content:[{type:'tool_result'}] -> worker output wearing a user frame.
//                                                     The CLI drops these too; so must we.
//   result/worker                                  -> the turn finished -> status idle
//   system, control_*                              -> dropped
function normalize(f) {
  const seq = parseInt(f.sequence_num, 10) || 0;
  const p = f.payload || {};
  const uuid = p.uuid || f.event_id || null;
  const ts = Date.parse(p.timestamp || f.created_at || '') || Date.now();

  if (f.event_type === 'result') return { kind: 'idle', seq };

  if (f.event_type === 'user') {
    const c = p.message && p.message.content;
    if (typeof c !== 'string') return null;     // array content = tool_result, i.e. worker output
    const text = c.trim();
    if (!text) return null;
    // Not everything wearing role:user was typed by a person. The CLI injects string notes
    // alongside tool results ("[Image: original 1648x3600, displayed at ...]" after a Read of a
    // picture, "<system-reminder>" blocks, mid-turn nudges). They confused the phone chat
    // (2026-09-05: three orange bubbles of image metadata). Drop them.
    if (/^\[Image: original \d+x\d+/.test(text)) return null;
    if (/^<system-reminder>/.test(text) || /^The user hasn't heard from you/.test(text)) return null;
    return { kind: 'msg', role: 'user', text, ts, uuid, seq };
  }

  if (f.event_type === 'assistant') {
    const c = (p.message && p.message.content) || [];
    if (!Array.isArray(c)) return null;
    const text = c.filter((b) => b && b.type === 'text').map((b) => b.text || '').join('').trim();
    if (text) return { kind: 'msg', role: 'agent', text, ts, uuid, seq };
    const tool = c.find((b) => b && b.type === 'tool_use');
    if (tool) return { kind: 'tool', tool: String(tool.name || 'tool'), ts, seq };
    return null;                                 // thinking-only turn
  }

  return null;
}

// ---------- HTTP ----------
function apiRequest({ method, path: p, body, tok }) {
  return new Promise((resolve) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      host: API_HOST, path: p, method,
      headers: {
        Authorization: 'Bearer ' + tok,
        ...API_HEADERS,
        ...(payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {})
      }
    }, (res) => {
      let d = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { d += c; });
      res.on('end', () => {
        let j = null; try { j = JSON.parse(d); } catch (_) {}
        resolve({ status: res.statusCode, body: j, raw: d });
      });
    });
    req.on('error', (e) => resolve({ status: 0, body: null, raw: e.message }));
    req.setTimeout(30000, () => { try { req.destroy(new Error('timeout')); } catch (_) {} });
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------- one streamed session ----------
class SessionStream {
  constructor(sessionId, opts) {
    this.sessionId = sessionId;
    this.cse = apiId(sessionId);
    this.o = opts;                  // {relay, headers, log, flushMs}
    this.lastSeq = 0;
    this.closed = false;
    this.req = null;
    this.res = null;
    this.buf = '';
    this.pending = [];              // normalized messages awaiting a flush
    this.activity = null;           // {tool, ts} - the live "what is it doing" indicator
    this.status = 'connecting';
    this.dirty = false;
    this.lastPush = 0;
    this.lastActivityPush = 0;
    this.flushTimer = null;
    this.retryTimer = null;
    this.backoff = 1000;
    this.retriedAuth = false;
    this.connect();
  }

  log(...a) { try { this.o.log('[rc ' + this.sessionId.slice(-6) + '] ' + a.join(' ')); } catch (_) {} }

  connect() {
    if (this.closed) return;
    const tok = readToken(false);
    if (!tok) { this.status = 'error'; this.dirty = true; this.scheduleFlush(); return this.retry('no oauth token on disk'); }
    // from_sequence_num=0 replays the entire session history, so a cold start hands the app a
    // full transcript; a reconnect resumes from where we got to instead of replaying it all.
    const p = '/v1/code/sessions/' + encodeURIComponent(this.cse)
      + '/events/stream?from_sequence_num=' + this.lastSeq;
    this.req = https.request({
      host: API_HOST, path: p, method: 'GET',
      headers: { Authorization: 'Bearer ' + tok, ...API_HEADERS, Accept: 'text/event-stream' }
    }, (res) => {
      this.res = res;
      if (res.statusCode === 401) {
        res.resume();
        // Token rotated under us. Re-read the credential file once and reconnect immediately;
        // only a SECOND 401 falls back to the backoff, so a rotation costs no visible delay.
        if (!this.retriedAuth) { this.retriedAuth = true; readToken(true); return this.retry('401, re-read token', 0); }
        this.status = 'error'; this.dirty = true; this.scheduleFlush();
        return this.retry('401 after token re-read');
      }
      if (res.statusCode !== 200) {
        res.resume();
        // 404 = the session is gone (tab closed). Report it and stop hammering.
        this.status = res.statusCode === 404 ? 'gone' : 'error';
        this.dirty = true; this.scheduleFlush();
        return this.retry('HTTP ' + res.statusCode);
      }
      this.retriedAuth = false;
      this.backoff = 1000;
      this.status = 'live';
      this.dirty = true;
      res.setEncoding('utf8');
      res.on('data', (c) => this.onData(c));
      res.on('end', () => this.retry('stream ended'));
      res.on('error', (e) => this.retry('stream error: ' + e.message));
    });
    this.req.on('error', (e) => this.retry('connect error: ' + e.message));
    this.req.end();
  }

  onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n\n')) !== -1) {
      const block = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 2);
      if (this.buf.length > 1 << 20) this.buf = '';       // paranoia: never grow unbounded
      let data = '';
      for (const line of block.split('\n')) {
        if (line.startsWith('data:')) data += line.slice(5).trim();
      }
      if (!data) continue;                                 // :keepalive / event-only blocks
      let f = null; try { f = JSON.parse(data); } catch (_) { continue; }
      if (!f) continue;
      if (f.connection_status) continue;                   // session_update housekeeping frame
      const seq = parseInt(f.sequence_num, 10) || 0;
      if (seq > this.lastSeq) this.lastSeq = seq;
      const n = normalize(f);
      if (!n) continue;
      if (n.kind === 'msg') { this.pending.push(n); this.activity = null; this.status = 'live'; this.dirty = true; }
      else if (n.kind === 'tool') { this.activity = { tool: n.tool, ts: n.ts }; this.dirty = true; }
      else if (n.kind === 'idle') { this.activity = null; this.dirty = true; }
    }
    this.scheduleFlush();
  }

  // Push to the relay on a throttle, never per-frame. A working agent emits a frame every
  // second or two; at one Durable Object request each that alone would eat the 100k/day free
  // tier. One push per flushMs (default 2.5s) while a session is subscribed caps it at
  // ~1.4k/hr, and a batch with no messages (a tool-name change only) is further limited to
  // one every 10s since nobody is waiting on it.
  scheduleFlush() {
    if (this.flushTimer || this.closed) return;
    const wait = Math.max(0, this.o.flushMs - (Date.now() - this.lastPush));
    this.flushTimer = setTimeout(() => { this.flushTimer = null; this.flush(); }, wait);
  }

  async flush() {
    if (this.closed) return;
    const msgs = this.pending;
    if (!msgs.length && !this.dirty) return;
    if (!msgs.length && Date.now() - this.lastActivityPush < 10000) { this.scheduleFlush(); return; }
    this.pending = [];
    this.dirty = false;
    this.lastPush = Date.now();
    if (!msgs.length) this.lastActivityPush = this.lastPush;
    try {
      await fetch(this.o.relay + '/rc/push', {
        method: 'POST',
        headers: { ...this.o.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: this.sessionId,
          messages: msgs,
          status: this.status,
          activity: this.activity,
          ts: Date.now()
        })
      });
    } catch (e) {
      // Relay unreachable: put the messages back so the next flush retries them rather than
      // silently dropping a turn out of the transcript.
      this.pending = msgs.concat(this.pending);
      this.dirty = true;
      this.scheduleFlush();
    }
  }

  retry(why, ms) {
    if (this.closed) return;
    this.teardownReq();
    if (this.retryTimer) return;
    const wait = ms === 0 ? 0 : (ms || this.backoff);
    if (ms !== 0) this.backoff = Math.min(this.backoff * 2, 60000);
    if (why && why !== 'stream ended') this.log(why + '; retrying in ' + Math.round(wait / 1000) + 's');
    this.retryTimer = setTimeout(() => { this.retryTimer = null; this.connect(); }, wait);
  }

  teardownReq() {
    try { if (this.res) this.res.destroy(); } catch (_) {}
    try { if (this.req) this.req.destroy(); } catch (_) {}
    this.res = null; this.req = null; this.buf = '';
  }

  close() {
    this.closed = true;
    if (this.flushTimer) { clearTimeout(this.flushTimer); this.flushTimer = null; }
    if (this.retryTimer) { clearTimeout(this.retryTimer); this.retryTimer = null; }
    this.teardownReq();
  }
}

// ---------- public API ----------
// createRcBridge({relay, headers, log}) -> { setSubs, hasSubs, subs, send, stop }
function createRcBridge({ relay, headers, log, flushMs }) {
  const streams = new Map();
  const opts = { relay, headers, log: log || (() => {}), flushMs: flushMs || 2500 };

  // Reconcile the streamed set against what the app says it currently has open. We hold an SSE
  // connection ONLY for subscribed sessions - an always-on stream per live tab would burn the
  // relay budget and the API for transcripts nobody is reading.
  function setSubs(ids) {
    const want = new Set((ids || []).filter(Boolean).map(String));
    for (const [id, st] of streams) {
      if (!want.has(id)) { st.close(); streams.delete(id); opts.log('rc: unsubscribed ' + id); }
    }
    for (const id of want) {
      if (!streams.has(id)) { streams.set(id, new SessionStream(id, opts)); opts.log('rc: streaming ' + id); }
    }
  }

  function hasSubs() { return streams.size > 0; }
  function subs() { return [...streams.keys()]; }

  // Post one of Lloyd's messages into a session. The uuid is minted by the app and carried
  // end to end: the API dedupes on it (results[].duplicate), so a retry over a flaky mobile
  // connection can never double-send. Returns {ok} | {ok:false, error}.
  // `content`, when given, is an array of Anthropic content blocks (text + image) and replaces the
  // plain string: the API accepted an image block in a user event on 2026-09-05 (HTTP 200,
  // seq 1049) and the session received it as a picture, so attachments from the phone go this way.
  async function send({ sessionId, text, uuid, content }) {
    const body = {
      events: [{
        payload: {
          message: { content: Array.isArray(content) && content.length ? content : String(text || ''), role: 'user' },
          origin: { kind: 'human' },
          parent_tool_use_id: null,
          session_id: apiId(sessionId),
          timestamp: new Date().toISOString(),
          type: 'user',
          uuid: uuid || require('crypto').randomUUID()
        }
      }]
    };
    for (let attempt = 0; attempt < 3; attempt++) {
      const tok = readToken(attempt > 0);          // a retry always re-reads, covering rotation
      if (!tok) return { ok: false, error: 'no oauth token on disk' };
      const r = await apiRequest({ method: 'POST', path: '/v1/code/sessions/' + encodeURIComponent(apiId(sessionId)) + '/events', body, tok });
      if (r.status === 200) {
        const dup = r.body && r.body.results && r.body.results[0] && r.body.results[0].duplicate;
        return { ok: true, duplicate: !!dup };
      }
      if (r.status === 401) { readToken(true); continue; }
      if (r.status === 404) return { ok: false, error: 'session is gone' };
      if (r.status >= 400 && r.status < 500) return { ok: false, error: 'HTTP ' + r.status + ' ' + String(r.raw).slice(0, 200) };
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
    return { ok: false, error: 'send failed after retries' };
  }

  function stop() { for (const [, st] of streams) st.close(); streams.clear(); }

  return { setSubs, hasSubs, subs, send, stop };
}

module.exports = { createRcBridge, apiId, normalize, readToken };
