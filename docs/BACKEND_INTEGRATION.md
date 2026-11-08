# Backend Integration

**Project:** Kinetiq: Advanced Motion Control
**Question:** How does Kinetiq reuse the CNCjs backend while staying a **single Next.js application**?
**Answer (approved 2026-11-08):** Option B, an **embedded backend runtime through a Next.js custom server**. This is one Node.js process and one package. It hosts the Next.js request handler **and** the unmodified CNCjs `CNCEngine` (Socket.IO 2 + serialport) on the same `http.Server`.

> **Approved.** D1–D4 (§9) were approved on 2026-11-08. A custom server is an official Next.js feature, not a separate backend; it replaces `next start` with `node dist/server.js`.

---

## 1. Single-application feasibility (the eight mandatory questions)

| # | Question | Finding | Evidence |
|---|---|---|---|
| 1 | Can CNCjs backend modules be imported and reused directly? | **Yes, but only after transpiling.** The source uses Babel-only syntax: ES `import` without file extensions plus CommonJS default-import interop. Native Node ESM cannot load it as-is. The CNCjs build already produces runnable CommonJS: `babel -d dist/cncjs/server src/server`, with `src/package.json` copied as `dist/cncjs/package.json`. | `scripts/build-prod.sh`, `babel.config.js`, `config/settings.base.js` (imports `../../package.json`) |
| 2 | Does CNCjs require an independent Node.js process? | **No.** `CNCEngine.start(server, controller)` accepts **any** `http.Server`. The CNCjs process boundary exists only because `server/index.js` creates its own Express server. | `CNCEngine.js:100-145`, `server/index.js:233-236` |
| 3 | Can Next.js server-side code host the backend? | **Route Handlers and Server Actions: no.** They are request-scoped, may be re-evaluated on hot reload, and offer no `http.Server` to attach Socket.IO to. **Custom server: yes.** It owns the `http.Server` and the process lifetime. | Next.js custom server (`next({ dev })` + `app.getRequestHandler()`) |
| 4 | Is serial port access compatible with the Next.js runtime? | **Yes in the Node runtime, no in the Edge runtime.** `serialport` v10 is a native addon (`@serialport/bindings-cpp`). It must be loaded by plain Node `require` from the custom server and **never** bundled by Next's webpack or Turbopack. Keeping all CNCjs code outside `src/app/` guarantees this. | `SerialConnection.js:1-3`, `CNCEngine.js:3` |
| 5 | Can WebSockets and Socket.IO run reliably? | **Yes.** Socket.IO attaches to the custom server's `http.Server` at path `/socket.io`, which does not collide with Next routes. **Constraint:** the server is Socket.IO **2.2** (Engine.IO protocol 3), so the browser must use **`socket.io-client@2.x`**. v3 and v4 clients cannot talk to it. **Risk to confirm in M1:** Engine.IO 3 tears down other WebSocket upgrades that it has not answered within 1 s (`destroyUpgrade`). Next's dev HMR socket answers immediately, so it should be unaffected, but this must be observed. | `CNCEngine.js:142-145`, `package.json` (`socket.io ~2.2.0`) |
| 6 | Can the app keep a persistent serial connection? | **Yes.** The engine lives in the custom server module, outside Next's module graph and HMR, so the serial port stays open across frontend reloads and page navigations. Browser tabs can close and reopen without touching the port, because CNCEngine keeps controllers in a process-wide store. | `store/index.js`, `CNCEngine.js:186-200, 266-273` |
| 7 | Do job streaming and buffer management stay reliable? | **Yes, unchanged.** Streaming runs entirely inside `GrblController`, `Sender` and the serialport event loop in Node. The browser only sends `gcode:start/pause/resume/stop` and never streams lines. One caveat: heavy server-side rendering work runs on the same event loop. For Kinetiq (one page, local, mostly client-rendered) the load is negligible, and Next can be kept off the hot path by rendering the page statically. | `Sender.js`, `GrblController.js:366-496` |
| 8 | Do Next.js dev or prod environments cause lifecycle problems? | **Manageable, with rules.** (a) Never import CNCjs from `src/app/**`; otherwise HMR could create a second engine and a second handle on the port. (b) Changes to the custom server need a process restart, which closes the port. That is acceptable and intended. (c) `output: 'standalone'` does not trace a custom server, so production runs `next build` followed by `node dist/server.js`. (d) CNCjs installs no SIGINT/SIGTERM handler; Kinetiq should add one (§5.3). | — |

**Verdict:** a single Next.js application is **technically feasible and safe** with a custom server. No separate backend process is required. Nothing found blocks it. The open items (Engine.IO upgrade coexistence and error serialisation) are confirmations planned for Milestone 1, not blockers.

---

## 2. Options compared

| Criterion | **A: Direct module reuse in Route Handlers** | **B: Embedded runtime (custom server)** ✅ | **C: Separate CNCjs process** |
|---|---|---|---|
| Single app / single process | Single app; unreliable process model | **Yes / yes** | No / no (two processes) |
| Persistent serial link | ✗ Handlers are request-scoped; HMR re-evaluates modules | **✓** | ✓ |
| Socket.IO | ✗ No `http.Server` to attach to | **✓ Same server** | ✓ Cross-origin or proxy |
| Reuses CNCEngine contract unchanged | ✗ Would need a new SSE/WebSocket layer, duplicating CNCEngine | **✓** | ✓ |
| Machine-communication safety | ✗ Risk of a second engine and a second port handle | **✓ One engine per process** | ✓ |
| Runtime complexity | Low on paper, high in practice | **Low: one `node` command** | Medium: supervise two processes, ports, token sharing |
| Dev complexity | High (work around HMR) | **Low** | Medium |
| Dependency management | — | Kinetiq installs CNCjs **server-only** deps (`dist/cncjs/package.json`) | Two dependency trees |
| Code duplication | High | **~40 lines of bootstrap** | None, but needs proxy and auth glue |
| Compatibility with CNCjs updates | Poor | **Good: rebuild `dist/cncjs/server` from the fork** | Good |
| Fits "one application" requirement | Nominally | **Yes** | **No** (fallback only) |

**Recommendation: Option B.** It is the simplest design that keeps all of CNCjs's streaming and safety code untouched and meets the single-application requirement.

---

## 3. How CNCjs code gets into Kinetiq

CNCjs is not published as a library, so Kinetiq needs its transpiled server code. Three ways were evaluated:

| Way | Description | Pros | Cons |
|---|---|---|---|
| **B1 (recommended)** | Build `CNCJS-fork/dist/cncjs/server` with CNCjs's own Babel config (`babel -d dist/cncjs/server src/server`, then copy `src/package.json`). Kinetiq depends on it as `"cncjs-app": "file:../CNCJS-fork/dist/cncjs"`. | Tracks **our fork**. Installs only server dependencies. No CNCjs source is copied into Kinetiq. | Needs a one-time `yarn install` in the fork to get Babel, and a rebuild after fork updates. Building writes `dist/` (git-ignored) inside the fork. **Not done in this phase.** |
| B2 | Depend on the published npm `cncjs@1.11.x` and require `cncjs/dist/cncjs/server/...` | No build step | Pulls the full frontend dependency tree (React 15, three.js, …). Tracks upstream releases, not the fork. |
| B3 | Kinetiq transpiles `../CNCJS-fork/src/server` into `vendor/` at build time | Self-contained | Duplicates CNCjs's build config, and Kinetiq would have to list CNCjs's server dependencies by hand. |

Modules that Kinetiq loads from the build (CommonJS, `.default` export):

```
cncjs-app/server/config/settings                → settings (mutable: secret, rcfile)
cncjs-app/server/services/configstore           → config.load(file)
cncjs-app/server/services/cncengine/CNCEngine   → new CNCEngine()   (class, keeps a handle on engine.io)
```

Kinetiq instantiates the `CNCEngine` class itself rather than using the `cncengine/index.js` singleton. That gives the server access to `engine.io` for graceful shutdown. The class is exported (`export default CNCEngine`), so no CNCjs change is needed.

---

## 4. Communication flow

```
┌──────────────────────────── one Node.js process: `node dist/server.js` ───────────────────────────┐
│                                                                                                   │
│  http.Server (127.0.0.1:8000)                                                                     │
│   ├── GET /api/kinetiq/session  ── handled by server.ts → { token } (JWT signed w/ settings.secret)│
│   ├── /socket.io/*              ── CNCjs CNCEngine (Socket.IO 2.2, JWT handshake)                 │
│   │                                   └── GrblController ── Sender/Feeder/Workflow ── serialport ──┼──USB──▶ FluidNC (ESP32)
│   └── everything else           ── Next.js request handler (App Router, single page)              │
│                                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ HTTP (page, assets, session)     │ WebSocket (socket.io-client@2)
        └──────────────── Browser: Kinetiq UI (React client components) ──────────────┘
```

### 4.1 Session token

CNCEngine requires `?token=<JWT>` at handshake (`socketio-jwt`, `handshake: true`). The token is a JWT signed with `settings.secret`, the same secret the CNCjs bootstrap generates and stores in the rc file. The payload is `{ id, name }`; with no users configured, `{ id: '', name: '' }` is accepted (`api.users.js:74-83`, `access-control.js:39-57`).

Kinetiq's custom server handles **one** path itself, `GET /api/kinetiq/session`, before delegating to Next. It returns a token signed with `jsonwebtoken`, which is already a CNCjs dependency. Next Route Handlers are avoided here because they run in Next's bundled module graph and would not share the engine's `settings` singleton.

Hardening for the endpoint:
- Bind to `127.0.0.1`.
- Reject requests whose `Host` header is not a loopback name (defends against DNS rebinding).
- Send no CORS headers.

### 4.2 Client to server

The browser opens one socket and then uses only the verified events: `list`, `open`, `close`, `command`, `writeln`. The full list is in `API_REFERENCE.md`.

### 4.3 Server to client

`startup`, `serialport:list`, `serialport:open`, `serialport:close`, `serialport:change`, `serialport:error`, `serialport:read`, `serialport:write`, `controller:state`, `controller:settings`, `sender:status`, `feeder:status`, `workflow:state`, `gcode:load`, `gcode:unload`. The legacy duplicates (`Grbl:state`, `Grbl:settings`) are ignored.

---

## 5. Backend lifecycle

### 5.1 Startup (`server.ts`)

1. `process.env.NODE_ENV` is set (`development` or `production`). CNCjs `settings` is evaluated on first `require`.
2. Resolve the rc file to `~/.kinetiqrc`. This is deliberately separate from `~/.cncrc`, so Kinetiq never mixes configuration with an installed CNCjs.
3. `config.load(rcfile)`. If `config.get('secret')` is missing, generate one and `config.set('secret', …)`, as `server/index.js:59-67` does. Then `settings.secret = config.get('secret')` and `settings.rcfile = rcfile`.
4. `const app = next({ dev })`, then `await app.prepare()`.
5. `const server = http.createServer(handler)`, where `handler` serves `/api/kinetiq/session` and passes everything else to `app.getRequestHandler()`.
6. `engine = new CNCEngine()`, then `engine.start(server, 'Grbl')`. **Only `GrblController` is registered.**
7. `server.listen(8000, '127.0.0.1')`.

### 5.2 Steady state

- One `GrblController` per open port. Status is polled every 250 ms. State is broadcast to every socket that attached through `open`.
- When a browser tab reloads, it reconnects, receives `startup`, emits `list`, sees `inuse: true`, and re-emits `open` for that port. CNCEngine attaches the socket and replays `serialport:open`, `controller:settings`, `controller:state`, `sender:status`, `workflow:state` and `gcode:load` (`GrblController.js:1298-1345`). **This is how Kinetiq resumes a session without touching the port.**

### 5.3 Shutdown (Kinetiq addition, uses existing interfaces only)

On SIGINT/SIGTERM:
1. Stop accepting HTTP connections.
2. If any controller has `workflow.state !== 'idle'`, log a warning. The process is ending mid-job and the controller will run out whatever it has buffered. Kinetiq **does not** auto-send a reset, because a reset during motion raises an alarm; that decision belongs to the operator.
3. Close each open controller (`controller.close`) so the port is released cleanly.
4. `engine.stop()` and exit.

How Kinetiq should reach the open controllers from `server.ts` (through the CNCjs `store` module, or by having the server emit `close` per port) is an implementation detail for M6. It needs no CNCjs change: the `store` module is importable from the build.

---

## 6. FluidNC compatibility

FluidNC speaks GRBL v1.1-style serial, but it is a different firmware. CNCjs was written against gnea/grbl. Each item below is labeled **Verified (source)**, meaning confirmed against CNCjs code with the FluidNC format taken from FluidNC documentation, or **Hardware check**, meaning it needs observation on the real ESP32 in Milestone 1.

| # | Topic | CNCjs behaviour | FluidNC consideration | Status |
|---|---|---|---|---|
| F1 | Startup banner | Regex `^([a-zA-Z0-9]+)\s+((?:\d+\.){1,2}\d+…)([^\[]*\[[^\]]+\].*)?` → `firmware`, `version`, `message`. Only `version` is stored in `settings.version`. | The FluidNC banner has the form `Grbl 3.x [FluidNC vX.Y.Z (…) '$' for help]`. The regex yields `firmware=Grbl`, `version=3.x`. **The FluidNC version is only in the raw line.** | Verified (source); banner text: Hardware check |
| F2 | Controller identification | `controller:settings.version` holds the GRBL-compat version. `[VER:]` from `$I` goes to the console raw. | Kinetiq parses `/FluidNC v[\d.]+/` from `serialport:read` lines to show "FluidNC vX.Y.Z". | Verified (source) |
| F3 | Auto-reset on open | `open` sets DTR/RTS only if `pin.dtr`/`pin.rts` are given (`GrblController.js:1196-1219`). | ESP32 dev boards reset on DTR/RTS toggling, so opening the port reboots FluidNC. Expect 1–3 s of boot messages before the banner. CNCjs handles this: it polls `?` every 2 s until ready. Whether to pass `pin: { dtr: false, rts: false }` to avoid the reset depends on the board. | Hardware check |
| F4 | `$$` at init | `initController` sends `$$` and parses `$n=v` lines. | FluidNC is configured through YAML, and `$$` reports a GRBL-compatibility subset. Whether `$13` (report inches) appears must be checked. If it is absent, positions are assumed to be in mm. | Hardware check |
| F5 | `[MSG:…]` lines | Feedback parser → `serialport:read` raw | FluidNC prefixes messages with a level: `[MSG:INFO: …]`, `[MSG:WARN: …]`, `[MSG:ERR: …]`. The console classifies them by level. | Verified (source) |
| F6 | Status report | Handles MPos or WPos, WCO caching, `FS`, `Ov`, `Pn`, `A`, `Bf`, `Ln` | FluidNC follows the v1.1 field set. Which fields appear depends on its report settings. `Bf` is needed for RX-buffer auto-sizing. | Hardware check |
| F7 | RX buffer and char counting | Starts at 120 bytes. Grows to `Bf.rx − 8` only if idle and the queue is empty. | 120 bytes is conservative if FluidNC's buffer is at least 128. A larger reported buffer is used automatically. Throughput is not a concern at hobby feed rates. | Safe by design; actual buffer size: Hardware check |
| F8 | Error and alarm codes | Known GRBL codes are decorated with text. Unknown codes are emitted raw (`error:NN`, `ALARM:NN`). | FluidNC extends the error table (codes beyond GRBL 1.1). They display raw; nothing breaks. | Verified (source) |
| F9 | Jogging | Kinetiq sends `$J=G91 G21 X10 F1000` through `command('gcode')`. Cancel is `command('jogCancel')` → `0x85`. | FluidNC documents GRBL `$J=` jogging and the `0x85` jog cancel. Soft limits reject jogs with an `error:` code. | Hardware check |
| F10 | Real-time commands | `? ! ~ 0x18`, override bytes `0x90–0x9D` | Supported by FluidNC. Kinetiq v1 uses only `! ~ 0x18 0x85`. | Hardware check |
| F11 | Unsolicited status reports | Each `<…>` line updates state | If FluidNC auto-reporting is enabled, extra status lines are harmless. | Verified (source) |
| F12 | FluidNC `$` extensions (`$CD`, `$LocalFS/*`, `$SD/*`, `$Config/*`) | Not parsed → `others` → console raw | Usable from the console while idle. Large dumps such as `$CD` must not be sent during a job (see hazard H1). | Verified (source) |
| F13 | Transport | Serial only | FluidNC WiFi, telnet and WebSocket are **not** reachable. USB serial only. | Verified (source) |
| F14 | Homing and alarm at boot | `homing` → `$H`; `unlock` → `$X` | With homing enabled, FluidNC boots in Alarm. Jogging stays disabled until the operator unlocks or homes (from the console in v1; see decision D4). | Verified (source) |
| F15 | Baud rate | Default 115200 | The FluidNC UART default is 115200. Kinetiq preselects 115200. | Hardware check |

---

## 7. What Kinetiq's backend layer contains (and does not)

**Contains:**
- `server.ts`: bootstrap (§5.1), the session endpoint (§4.1) and shutdown (§5.3).
- A `.d.ts` file declaring the three CNCjs modules it loads.

**Does not contain:**
- Serial code, streaming code or protocol parsing.
- A REST API.
- Any re-implementation of a CNCjs subsystem.

---

## 8. Limitations and unresolved questions

| # | Item | Impact | Plan |
|---|---|---|---|
| U1 | Engine.IO 3 `destroyUpgrade` alongside Next dev HMR | **Resolved (M1, 2026-11-08).** With `next({ httpServer })`, `[HMR] connected` and live component edits work next to Socket.IO; the serial engine is not restarted. | — |
| U2 | Open-error reason not transmitted (hazard H4) | **Confirmed (M1).** The `open` callback and `serialport:error.err` both arrive as `{}`. The reason (e.g. "No such file or directory") only appears in the server log. | The UI shows "Could not open *port*" plus the likely causes. |
| U8 | Non-numeric `baudrate` in `open` | **Observed (M1).** `SerialConnection` throws an uncaught `TypeError`. Next's handler keeps the process alive in dev and prod, but the `open` callback never fires. | Kinetiq validates the baud rate on the client before emitting (`client.ts`). |
| U3 | FluidNC items marked "Hardware check" (F1, F3, F4, F6, F7, F9, F10, F15) | Identification, units and jog behaviour | First connection session in M1 with **motors disabled** (drivers unpowered) |
| U4 | Socket.IO 2.2 and Engine.IO 3 are old and carry published advisories (for example permissive default CORS before socket.io 2.4) | Local-only deployment limits exposure. The JWT handshake still applies. | Bind to loopback and add the Host-header check. Upgrading belongs in the fork, not in Kinetiq. |
| U5 | `CNCJS-fork` must be built before Kinetiq can run | Extra setup step | Documented in M1. Optionally a `predev` script that checks `dist/cncjs/server` exists. |
| U6 | `ignoreErrors` key mismatch (`state.controller.exception.ignoreErrors` vs the default `controller.exception.ignoreErrors`) | None (the safe default holds) | Leave as is. Kinetiq never sets either key. |
| U7 | `remainingTime` is a line-count extrapolation | Inaccurate on uneven programs | Shown as "≈ estimate" (see `API_REFERENCE.md` §7). A better estimator is a future feature. |

---

## 9. Decisions (approved 2026-11-08)

| ID | Decision | Recommendation (all approved) |
|---|---|---|
| **D1** | Use a Next.js **custom server** (`node dist/server.js`) to host CNCEngine in the same process | **Approve.** It is the only single-application design that keeps CNCjs unmodified and safe. |
| **D2** | Consume CNCjs as a **fork build** (`file:../CNCJS-fork/dist/cncjs`, way B1) | Approve B1. B2 is the fallback. |
| **D3** | Pin **`socket.io-client@2.x`** in the frontend (protocol lock-step with the CNCjs server) | Approve. It is required. |
| **D4** | Minimal job and safety controls beyond pure monitoring: Load file (single file picker, not a file manager), Start/Pause/Resume/Stop in the Job widget, plus a persistent **Feed Hold** and **Reset** in the top bar | Approve. Without these a job cannot run, and a hold/reset control should always be reachable. Unlock (`$X`) and Home (`$H`) stay console-only in v1 unless you want buttons. |
