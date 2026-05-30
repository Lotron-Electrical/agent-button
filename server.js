// agent-button relay
// Phone posts a task -> held in memory -> PC poller pulls it via /next -> spawns Claude Code tabs.
// Auth is a single capability secret (BUTTON_TOKEN). The button page lives at /p/<secret>.
const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(express.json({ limit: '64kb' }));

const SECRET = process.env.BUTTON_TOKEN;
if (!SECRET) {
  console.error('FATAL: BUTTON_TOKEN env var is required');
  process.exit(1);
}
const PORT = process.env.PORT || 3000;
const MAX_TASK = 6000;

// ---- state (in-memory; a restart drops anything not yet pulled, which is fine) ----
const pending = [];      // [{id, task, count, cwd, autoClose, ts}]
const taken = new Map(); // id -> {id, status:'taken'|'spawned'|'error', spawned, ts, error}
let counter = 1;
function newId() {
  // time-ish + counter, no Math.random needed
  return (Date.now().toString(36) + '-' + (counter++).toString(36));
}

// ---- auth ----
function auth(req, res, next) {
  const h = req.get('authorization') || '';
  const tok = h.startsWith('Bearer ') ? h.slice(7) : (req.query.s || '');
  if (tok !== SECRET) return res.status(401).json({ error: 'unauthorized' });
  next();
}

// ---- health (public, for Render) ----
app.get('/health', (_req, res) => res.json({ ok: true, pending: pending.length }));
app.get('/', (_req, res) => res.status(404).send('not here'));

// ---- the button page (capability URL) ----
const TEMPLATE = fs.readFileSync(path.join(__dirname, 'public', 'app.html'), 'utf8');
app.get('/p/:secret', (req, res) => {
  if (req.params.secret !== SECRET) return res.status(404).send('Not found');
  const html = TEMPLATE
    .replace(/__SECRET__/g, SECRET)
    .replace(/__START__/g, '/p/' + SECRET);
  res.type('html').send(html);
});

// dynamic manifest so start_url carries the secret
app.get('/p/:secret/manifest.webmanifest', (req, res) => {
  if (req.params.secret !== SECRET) return res.status(404).send('Not found');
  res.type('application/manifest+json').json({
    name: 'Spawn Agents',
    short_name: 'Agents',
    start_url: '/p/' + SECRET,
    scope: '/p/' + SECRET,
    display: 'standalone',
    orientation: 'portrait',
    background_color: '#0d0d0d',
    theme_color: '#C15F3C',
    icons: [
      { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' }
    ]
  });
});

// icons are not sensitive -> serve statically
app.use('/', express.static(path.join(__dirname, 'public'), {
  index: false,
  setHeaders: (res) => res.setHeader('Cache-Control', 'public, max-age=86400')
}));

// ---- phone -> relay ----
app.post('/enqueue', auth, (req, res) => {
  let { task, count, cwd, autoClose } = req.body || {};
  task = (typeof task === 'string' ? task : '').trim();
  if (!task) return res.status(400).json({ error: 'task required' });
  if (task.length > MAX_TASK) task = task.slice(0, MAX_TASK);
  count = Math.max(1, Math.min(4, parseInt(count, 10) || 1));
  cwd = (typeof cwd === 'string' ? cwd : '').trim();
  autoClose = autoClose !== false;
  const id = newId();
  pending.push({ id, task, count, cwd, autoClose, ts: Date.now() });
  if (pending.length > 50) pending.shift(); // backstop
  console.log(`[enqueue] ${id} count=${count} autoClose=${autoClose} task=${JSON.stringify(task.slice(0, 60))}`);
  res.json({ ok: true, id, queued: pending.length });
});

// ---- relay -> PC poller ----
app.get('/next', auth, (_req, res) => {
  const t = pending.shift();
  if (!t) return res.json({ empty: true });
  taken.set(t.id, { id: t.id, status: 'taken', ts: Date.now() });
  // forget old taken records
  if (taken.size > 100) {
    const cutoff = Date.now() - 30 * 60 * 1000;
    for (const [k, v] of taken) if (v.ts < cutoff) taken.delete(k);
  }
  res.json(t);
});

// ---- PC poller -> relay (confirmation) ----
app.post('/ack', auth, (req, res) => {
  const { id, spawned, error } = req.body || {};
  if (!id) return res.status(400).json({ error: 'id required' });
  taken.set(id, {
    id,
    status: error ? 'error' : 'spawned',
    spawned: parseInt(spawned, 10) || 0,
    error: error || null,
    ts: Date.now()
  });
  console.log(`[ack] ${id} -> ${error ? 'error: ' + error : 'spawned ' + spawned}`);
  res.json({ ok: true });
});

// ---- phone polls for confirmation ----
app.get('/status/:id', auth, (req, res) => {
  const id = req.params.id;
  if (taken.has(id)) return res.json(taken.get(id));
  if (pending.some((p) => p.id === id)) return res.json({ id, status: 'pending' });
  res.json({ id, status: 'unknown' });
});

app.listen(PORT, () => console.log(`agent-button relay listening on :${PORT}`));
