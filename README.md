# agent-button

A button on your phone that spawns Claude Code agent tabs on your PC.

```
 phone page  ──POST /enqueue──▶  Render relay  ◀──GET /next──  PC poller  ──▶  claude-tab.sh ──▶ Claude Code tabs
   (PWA)                         (this repo)                   (pc/poller.js)
```

You type a task on your phone, pick how many agents, hit **SPAWN**. The relay holds the
task; a poller on your PC pulls it within a few seconds and opens that many real
Claude Code tabs (via your existing `~/scripts/claude-tab.sh`), each seeded with the task.
The phone shows a green "Spawned N agents" once the PC confirms.

## Two halves

**Relay (cloud, on Render)** — `server.js`. Serves the button page at a secret URL and
brokers tasks. Single capability secret (`BUTTON_TOKEN`); no other auth.

**Poller (your PC)** — `pc/poller.js`. Polls the relay, spawns the tabs, acks back.
Polling every few seconds also keeps the free Render service from sleeping, so the
button feels instant.

## Setup

1. **Deploy the relay** to Render (Node web service):
   - Build: `npm install`  ·  Start: `node server.js`
   - Env var: `BUTTON_TOKEN` = a long random secret
   - Health check path: `/health`
2. **Configure the poller** on your PC:
   ```bash
   cp "pc/agent-button.env.example" "$HOME/.agent-button.env"
   # edit it: set RELAY_URL to your Render URL and BUTTON_TOKEN to the same secret
   ```
3. **Install the poller as a background task** (hidden, restarts at logon):
   ```powershell
   powershell -ExecutionPolicy Bypass -File "pc\install-poller-task.ps1"
   ```
   Or just run it in a terminal to watch it: `node pc/poller.js`
4. **Add the button to your phone**: open `https://<relay>/p/<secret>` in your phone
   browser, then *Share → Add to Home Screen*. You get an app icon that opens straight
   to the button.

## Security

The page lives at `/p/<secret>` and every API call needs `Authorization: Bearer <secret>`.
Anyone with that URL can spawn agents on your PC, so treat it like a password. To rotate:
change `BUTTON_TOKEN` on Render and in `~/.agent-button.env`, then restart the poller.

## Files

| Path | What |
| --- | --- |
| `server.js` | Render relay + button page |
| `public/app.html` | The phone page (template; `__SECRET__` injected at runtime) |
| `pc/poller.js` | PC-side poller that spawns the tabs |
| `pc/agent-button.env.example` | Copy to `~/.agent-button.env` |
| `pc/install-poller-task.ps1` | Registers + starts the background poller |
| `pc/run-poller.vbs` | Hidden launcher used by the scheduled task |

Spawn prompts, done-flags and per-agent reports land in `~/.agent-button-spawns/`.
