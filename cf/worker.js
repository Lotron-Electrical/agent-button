// agent-button relay, Cloudflare Worker edition.
// Same contract as the Node relay (server.js), always-on and free. The queue lives in a
// single Durable Object (strongly consistent, instant read-after-write — unlike KV, which
// caches reads at the edge for up to 60s and would make the poller miss fresh tasks).
import HTML from './app.html';
import ICON192 from './icon-192.png';
import ICON512 from './icon-512.png';

const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { 'content-type': 'application/json' } });
const pngResp = (buf) =>
  new Response(buf, { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });

// The one queue instance every request talks to.
const queueStub = (env) => env.QUEUE_DO.get(env.QUEUE_DO.idFromName('main'));

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

    return new Response('not found', { status: 404 });
  }
};

// Strongly-consistent queue. One instance ('main') serializes all ops.
export class QueueDO {
  constructor(state) {
    this.storage = state.storage;
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

    return new Response('do: not found', { status: 404 });
  }
}
