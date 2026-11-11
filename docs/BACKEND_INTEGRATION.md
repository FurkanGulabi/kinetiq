# Backend Integration

**Project:** Kinetiq: Advanced Motion Control
**Question:** How does Kinetiq reuse the CNCjs backend while staying a **single Next.js application**?
**Answer (approved 2026-11-08):** Option B, an **embedded backend runtime through a Next.js custom server**. This is one Node.js process and one package. It hosts the Next.js request handler **and** the CNCjs `CNCEngine` (Socket.IO, now 4, + serialport) on the same `http.Server`. The CNCjs GRBL server code is embedded in `src/server/`, rewritten into TypeScript, with a few documented changes (D2 revised; §7.1).

> **Approved.** D1–D4 (§9) were approved on 2026-11-08. A custom server is an official Next.js feature, not a separate backend; it replaces `next start` with `node dist/server.js`.

---

## 1. Single-application feasibility (the eight mandatory questions)

| # | Question | Finding | Evidence |
|---|---|---|---|
| 1 | Can CNCjs backend modules be imported and reused directly? | **Yes, but only after transpiling.** The source uses Babel-only syntax: ES `import` without file extensions plus CommonJS default-import interop. Native Node ESM cannot load it as-is. The CNCjs build already produces runnable CommonJS: `babel -d dist/cncjs/server src/server`, with `src/package.json` copied as `dist/cncjs/package.json`. | `scripts/build-prod.sh`, `babel.config.js`, `config/settings.base.js` (imports `../../package.json`) |
| 2 | Does CNCjs require an independent Node.js process? | **No.** `CNCEngine.start(server, controller)` accepts **any** `http.Server`. The CNCjs process boundary exists only because `server/index.js` creates its own Express server. | `CNCEngine.js:100-145`, `server/index.js:233-236` |
| 3 | Can Next.js server-side code host the backend? | **Route Handlers and Server Actions: no.** They are request-scoped, may be re-evaluated on hot reload, and offer no `http.Server` to attach Socket.IO to. **Custom server: yes.** It owns the `http.Server` and the process lifetime. | Next.js custom server (`next({ dev })` + `app.getRequestHandler()`) |
| 4 | Is serial port access compatible with the Next.js runtime? | **Yes in the Node runtime, no in the Edge runtime.** `serialport` v10 is a native addon (`@serialport/bindings-cpp`). It must be loaded by plain Node `require` from the custom server and **never** bundled by Next's webpack or Turbopack. Keeping all CNCjs code outside `src/app/` guarantees this. | `SerialConnection.js:1-3`, `CNCEngine.js:3` |
| 5 | Can WebSockets and Socket.IO run reliably? | **Yes.** Socket.IO attaches to the custom server's `http.Server` at path `/socket.io`, which does not collide with Next routes. **Constraint (at the time):** the server was Socket.IO **2.2** (Engine.IO protocol 3), so the browser had to use **`socket.io-client@2.x`**. *Since 2026-11-11 both sides are on Socket.IO 4 (server and client together); see D3.* **Risk to confirm in M1:** Engine.IO 3 tears down other WebSocket upgrades that it has not answered within 1 s (`destroyUpgrade`). Next's dev HMR socket answers immediately, so it should be unaffected, but this must be observed. | `CNCEngine.js:142-145`, `package.json` (`socket.io ~2.2.0`) |
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

> **Superseded 2026-11-08 (D2 revised):** none of the ways below is used any more. The CNCjs GRBL server code was copied into Kinetiq as JavaScript (`src/server/cnc`, loaded by `src/server/backend.ts`) and has since been rewritten into TypeScript under `src/server/` (§7.1), so there is no fork build and no `cncjs-app` dependency. This section is kept as the record of the original evaluation.

CNCjs is not published as a library, so Kinetiq needs its transpiled server code. Three ways were evaluated:

| Way | Description | Pros | Cons |
|---|---|---|---|
| **B1 (recommended)** | Build `cncjs/dist/cncjs/server` in a local CNCjs checkout with CNCjs's own Babel config (`babel -d dist/cncjs/server src/server`, then copy `src/package.json`). Kinetiq depends on it as `"cncjs-app": "file:../cncjs/dist/cncjs"`. | Tracks **our fork**. Installs only server dependencies. No CNCjs source is copied into Kinetiq. | Needs a one-time `yarn install` in the fork to get Babel, and a rebuild after fork updates. Building writes `dist/` (git-ignored) inside the fork. **Not done in this phase.** |
| B2 | Depend on the published npm `cncjs@1.11.x` and require `cncjs/dist/cncjs/server/...` | No build step | Pulls the full frontend dependency tree (React 15, three.js, …). Tracks upstream releases, not the fork. |
| B3 | Kinetiq transpiles `../cncjs/src/server` into `vendor/` at build time | Self-contained | Duplicates CNCjs's build config, and Kinetiq would have to list CNCjs's server dependencies by hand. |

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
│   ├── /api/kinetiq/jobs/*       ── job library (src/server/jobs.ts)                               │
│   ├── /api/kinetiq/machine-config/* ── FluidNC config editor (src/server/fluidnc/)                │
│   ├── /socket.io/*              ── SocketEngine, was CNCEngine (Socket.IO 4, JWT handshake)       │
│   │                                   └── GrblController ── Sender/Feeder/Workflow ── serialport ──┼──USB──▶ FluidNC (ESP32)
│   └── everything else           ── Next.js request handler (App Router, single page)              │
│                                                                                                   │
└───────────────────────────────────────────────────────────────────────────────────────────────────┘
        ▲                                  ▲
        │ HTTP (page, assets, Kinetiq APIs)│ WebSocket (socket.io-client@4)
        └──────────────── Browser: Kinetiq UI (React client components) ──────────────┘
```

### 4.1 Session token

The engine (`src/server/engine/SocketEngine.ts`, was CNCjs's `CNCEngine`) requires the JWT in the handshake's `auth` payload (`auth: { token }`; checked by `authenticateSocketToken()` in `src/server/session.ts`, HS256 only; this replaced `socketio-jwt` and its `?token=` query when the engine moved to Socket.IO 4). The token is a JWT signed with `settings.secret`, the same secret the CNCjs bootstrap generates and stores in the rc file. The payload is `{ id, name }`; with no users configured, `{ id: '', name: '' }` is accepted (`api.users.js:74-83`; `validateUser()` in `src/server/session.ts`, was `access-control.js:39-57`). After the token, `authorizeIPAddress()` (same file) rejects addresses outside the loopback and private ranges.

Kinetiq's custom server handles `GET /api/kinetiq/session` itself (plus the job library and machine-config APIs, which require this token as `Authorization: Bearer`), before delegating to Next. It returns a token signed with `jsonwebtoken`, which is already a CNCjs dependency. Next Route Handlers are avoided here because they run in Next's bundled module graph and would not share the engine's `settings` singleton.

Hardening for the endpoint:
- Bind to `127.0.0.1` by default (`KINETIQ_HOST` overrides it; the Host check below still requires a loopback name).
- Reject requests whose `Host` header is not a loopback name (defends against DNS rebinding).
- Send no CORS headers.

### 4.2 Client to server

The browser opens one socket and then uses only the verified events: `list`, `open`, `close`, `command`, `writeln`. The full list is in `API_REFERENCE.md`. Request/response operations that are not part of the CNCjs protocol (job library, FluidNC config) go over Kinetiq's HTTP APIs instead (`API_REFERENCE.md` §7.4–7.5).

### 4.3 Server to client

`startup`, `serialport:list`, `serialport:open`, `serialport:close`, `serialport:change`, `serialport:error`, `serialport:read`, `serialport:write`, `controller:state`, `controller:settings`, `sender:status`, `feeder:status`, `workflow:state`, `gcode:load`, `gcode:unload`. The legacy duplicates `Grbl:state` / `Grbl:settings` were removed from the backend (rewrite phase 1).

---

## 5. Backend lifecycle

### 5.1 Startup (`server.ts`)

1. `process.env.NODE_ENV` is set (`development` or `production`). The backend `settings` module (`src/server/config/settings.ts`) reads it when it first evaluates, so `src/server/backend.ts` is imported only after this, and `loadBackend()` itself imports the settings, config, logger, store and engine modules lazily (dynamic `import()`).
2. `await loadBackend()` (`src/server/backend.ts`): set the log level (`KINETIQ_LOG_LEVEL`, default `info`); resolve the rc file to `KINETIQ_RC` or `~/.kinetiqrc` (created as `{}` with mode 0600 if missing). This is deliberately separate from `~/.cncrc`, so Kinetiq never mixes configuration with an installed CNCjs.
3. `config.load(rcfile)`. If `config.get('secret')` is missing, generate one and `config.set('secret', …)`, as `server/index.js:59-67` does. Then `settings.secret = config.get('secret')` and `settings.rcfile = rcfile`. `new SocketEngine()` is constructed (not started).
4. `const server = http.createServer(handler)`, where `handler` serves `/api/kinetiq/session`, `/api/kinetiq/jobs/*` and `/api/kinetiq/machine-config/*`, and passes everything else to Next (503 "Kinetiq is starting" until Next is ready).
5. `engine.start(server, 'Grbl')`. **Only `GrblController` is registered.**
6. `const app = next({ dev, hostname, port, httpServer: server })`, then `await app.prepare()` and `app.getRequestHandler()`.
7. `server.listen(port, hostname)`: `KINETIQ_PORT` (else `PORT`, default `8000`) and `KINETIQ_HOST` (default `127.0.0.1`). Any failure logs `[kinetiq] Failed to start` and exits with code 1.

### 5.2 Steady state

- One `GrblController` per open port. Status is polled every 250 ms. State is broadcast to every socket that attached through `open`.
- When a browser tab reloads, it reconnects, receives `startup`, emits `list`, sees `inuse: true`, and re-emits `open` for that port. SocketEngine attaches the socket and replays `serialport:open`, `controller:settings`, `controller:state`, `sender:status`, `workflow:state` and `gcode:load` (`GrblController.addConnection()`, was `GrblController.js:1298-1345`). **This is how Kinetiq resumes a session without touching the port.**

### 5.3 Shutdown (Kinetiq addition, uses existing interfaces only)

On SIGINT/SIGTERM:
1. Stop accepting HTTP connections.
2. If any controller has `workflow.state !== 'idle'`, log a warning. The process is ending mid-job and the controller will run out whatever it has buffered. Kinetiq **does not** auto-send a reset, because a reset during motion raises an alarm; that decision belongs to the operator.
3. Close each open controller (`controller.close`) so the port is released cleanly.
4. `engine.stop()` and exit.

Implemented in `server.ts` and `closeAllControllers()` (`src/server/backend.ts`): it reaches the open controllers through the backend `store` module (`controllers`), closes each one, removes it from the store and destroys it, then calls `engine.stop()` and `app.close()`.

---

## 6. FluidNC compatibility

FluidNC speaks GRBL v1.1-style serial, but it is a different firmware. CNCjs was written against gnea/grbl. Each item below is labeled **Verified (source)**, meaning confirmed against CNCjs code with the FluidNC format taken from FluidNC documentation, or **Hardware check**, meaning it needs observation on the real ESP32 in Milestone 1.

| # | Topic | CNCjs behaviour | FluidNC consideration | Status |
|---|---|---|---|---|
| F1 | Startup banner | Regex `^([a-zA-Z0-9]+)\s+((?:\d+\.){1,2}\d+…)([^\[]*\[[^\]]+\].*)?` → `firmware`, `version`, `message`. Only `version` is stored in `settings.version`. | **Observed (M1, FluidNC v4.0.1): no banner is received on connect**, because opening the port does not reset the board (F3). `settings.version` therefore stays `''`. | **Hardware: observed** |
| F2 | Controller identification | `controller:settings.version` holds the GRBL-compat version. `[VER:]` from `$I` goes to the console raw. | **Observed:** `$I` returns `[VER:4.0 FluidNC v4.0.1:]` and `[OPT:PHS]`, plus `[MSG:Machine: 3-Axis Spindle Probe Config]` and a WiFi line. Kinetiq's pattern `/FluidNC v(\d+(?:\.\d+)+…)/` now matches both the banner and the `$I` format. Without a banner, identity only appears after someone sends `$I` (see U9). | **Hardware: observed** |
| F3 | Auto-reset on open | `open` sets DTR/RTS only if `pin.dtr`/`pin.rts` are given (`GrblController.js:1196-1219`). | **Observed twice (CH340 adapter, VID 0x1A86 / PID 0x7523): opening the port does NOT reset the ESP32.** No ROM boot text and no FluidNC boot messages arrive. The first line is the reply to CNCjs's 2 s wake-up `?` (+2.25 s). No `pin` option is needed. | **Hardware: observed** |
| F4 | `$$` at init | `initController` sends `$$` and parses `$n=v` lines. | **Observed:** FluidNC returns a GRBL subset: `$10=1`, `$13=0`, `$20=0`, `$21=1`, `$22=1`, `$23=2`, `$30=10000`, `$32=0`, `$100-102=400`, `$110-112=1000`, `$120-122=25`, `$130-132=1000`, then `ok`. **`$13` is present (`0`), so positions are reported in mm.** | **Hardware: observed** |
| F5 | `[MSG:…]` lines | Feedback parser → `serialport:read` raw | FluidNC prefixes messages with a level: `[MSG:INFO: …]`, `[MSG:WARN: …]`, `[MSG:ERR: …]`. The console classifies them by level. | Verified (source) |
| F6 | Status report | Handles MPos or WPos, WCO caching, `FS`, `Ov`, `Pn`, `A`, `Bf`, `Ln` | **Observed:** `<Alarm\|MPos:0.000,0.000,0.000\|FS:0,0>`, with `WCO:0.000,0.000,22.603` and `Ov:100,100,100` appended periodically (`$10=1`: MPos only). CNCjs derives WPos = MPos − WCO (Z = −22.603). **No `Bf:` field.** | **Hardware: observed** |
| F7 | RX buffer and char counting | Starts at 120 bytes. Grows to `Bf.rx − 8` only if idle and the queue is empty. | No `Bf:` is reported (F6), so the Sender stays at the conservative 120 bytes. Safe; throughput is not a concern at hobby feed rates. | **Hardware: observed** |
| F8 | Error and alarm codes | Known GRBL codes are decorated with text. Unknown codes are emitted raw (`error:NN`, `ALARM:NN`). | FluidNC extends the error table (codes beyond GRBL 1.1). They display raw; nothing breaks. | Verified (source) |
| F9 | Jogging | Kinetiq sends `$J=G91 G21 X10 F1000` through `command('gcode')`. Cancel is `command('jogCancel')` → `0x85`. | FluidNC documents GRBL `$J=` jogging and the `0x85` jog cancel. Soft limits reject jogs with an `error:` code. | **Operator-confirmed (2026-11-08):** jog pad works; `0x85` cancel and absolute `$J=G90` not yet exercised |
| F10 | Real-time commands | `? ! ~ 0x18`, override bytes `0x90–0x9D` | Supported by FluidNC. Kinetiq uses `! ~ 0x18 0x85` and the feed/spindle override bytes `0x90–0x94`, `0x99–0x9D` (Job widget). | **Hardware: observed** for `!`, `~`, `0x18` and feed override (`API_REFERENCE.md` §7.1, §10); `0x85` not yet |
| F11 | Unsolicited status reports | Each `<…>` line updates state | If FluidNC auto-reporting is enabled, extra status lines are harmless. | Verified (source) |
| F12 | FluidNC `$` extensions (`$CD`, `$LocalFS/*`, `$SD/*`, `$Config/*`) | Not parsed → `others` → console raw | Usable from the console while idle. Large dumps such as `$CD` must not be sent during a job (see hazard H1). | Verified (source) |
| F13 | Transport | Serial only | FluidNC WiFi, telnet and WebSocket are **not** reachable. USB serial only. | Verified (source) |
| F14 | Homing and alarm at boot | `homing` → `$H`; `unlock` → `$X` | With homing enabled, FluidNC boots in Alarm. Jogging stays disabled until the operator unlocks or homes (the top-bar **Home** / **Unlock** buttons, or the console; see decision D4). | Verified (source) |
| F15 | Baud rate | Default 115200 | **Observed:** at 115200 every received byte decodes as valid GRBL/FluidNC text (status reports, `$$`, `[GC:…]`, `$I`), which confirms the controller's USB console rate. | **Hardware: observed** |

---

## 7. What Kinetiq's backend layer contains (and does not)

**Contains:**
- `server.ts`: bootstrap (§5.1), routing and shutdown (§5.3).
- `src/server/backend.ts`: loads the backend (rc file, secret, `SocketEngine`), typed against the real modules, and closes controllers on shutdown.
- `src/server/session.ts`: the session endpoint (§4.1), the auth check shared by the HTTP APIs, and the socket handshake's IP and user checks (`authorizeIPAddress`, `validateUser`).
- `src/server/jobs.ts`: the job library (`API_REFERENCE.md` §7.4).
- `src/server/macros.ts`: saved macros in the rc file (`kinetiq.macros`) and the lookup behind the `macro:run` command (`API_REFERENCE.md` §7.6).
- `src/server/fluidnc/`: the FluidNC config editor API (`SETTINGS_EDITOR.md` §3). It sends `$` commands through `controller.writeln()` one at a time and, for saving, an XModem transfer on the raw port while the controller is in exclusive mode.
- The GRBL backend itself (D2, revised), CNCjs 1.11.5 rewritten into TypeScript (§7.1):
  - `src/server/protocol.ts`: socket event and command names and payload types, shared with `src/lib/cnc`.
  - `src/server/engine/SocketEngine.ts`: the Socket.IO 4 server (handshake, `list`/`open`/`close`/`command`/`write`/`writeln`, `startup`, the rc-ports fallback of `list`).
  - `src/server/controller/`: `GrblController` (coordinator, socket fan-out), `StatusPoller`, `JobRunner`, `filters`, `commands`.
  - `src/server/streaming/`: `Sender` (character counting), `Feeder`, `Workflow`, the `[expr]` / `%var=` macro language (`expressions.ts`) and `%wait` / `%msg` / M0 / M6 helpers (`builtins.ts`).
  - `src/server/serial/SerialConnection.ts`, `src/server/grbl/` (constants, line parsers, `GrblRunner`).
  - `src/server/config/` (settings, rc file store), `src/server/events/` (rc `events` → shell runner, §7.2), `store.ts`, `logger.ts`, `constants.ts`, `util/`.

**Does not contain:**
- Its own streaming code or G-code protocol parsing beyond the ported CNCjs code.
- The CNCjs REST API.
- Any re-implementation of a CNCjs subsystem: the TypeScript files are line-for-line ports, checked with the protocol diff (`scripts/protocol-scenarios/`).

### 7.1 Provenance (CNCjs)

- **Source:** `src/server` of [CNCjs](https://github.com/cncjs/cncjs) at commit `a3922a1bf` (CNCjs 1.11.5), copied into `src/server/cnc` as JavaScript on 2026-11-08 so Kinetiq no longer depends on a CNCjs checkout. The CNCjs MIT licence is in [`src/server/CNCJS_LICENSE`](../src/server/CNCJS_LICENSE); keep it with the code.
- **Rewritten into TypeScript** (2026-11-09/10), file by file, with the serial traffic compared against the JavaScript backend after every step (`scripts/protocol-scenarios/`). Behaviour is unchanged except for the changes below and the fixes in §7.3. Each file's header names the CNCjs file it came from (`was src/server/cnc/…`). `src/server/cnc/` no longer exists.
- **Kinetiq changes** are marked in the code with `// Kinetiq:` or `// SECURITY (Kinetiq):` comments. The main ones: only the Grbl controller is registered (Marlin, Smoothie, TinyG/g2core removed); `list` answers with the rc `ports` when port detection fails; no `config:change` broadcast (it carried the JWT `secret`); `gcode:unload` (not `unload`) on reopen; M6 is always a manual tool-change pause (the `tool:change` routine, `tool.*` config and `lasertest:*` were removed); `GrblController.setExclusive()` for the settings editor's XModem upload; command names are looked up as own properties only; `settings.ts` holds only the fields the backend reads. The commands and events the UI never used were removed: CNCjs macros, watch directory, CNCjs autolevel, the `Grbl:*` duplicate events, command aliases, `sleep`, rapid overrides, `feeder:*` and `statusreport`.
- **Not carried over:** the Express app, REST API, i18n, views, the Marlin/Smoothie/TinyG controllers and the CNCjs CLI.

### 7.2 Security rule: shell commands

`src/server/events/TaskRunner.ts` runs shell commands. Today its only input is the `events` list in the rc file (`~/.kinetiqrc`), read by `src/server/events/EventTrigger.ts`. No socket or HTTP handler reaches it. Kinetiq writes three config values, all its own: `secret` (at first start), `kinetiq.travel` (measured travel, `TravelGuard`) and `kinetiq.macros` (the macro API). Macro content only ever goes to the Feeder (the `gcode` command path), never to `taskRunner.run()`; the macro API reads only `name` and `content` from a request and writes no other key.

Keep it that way:
- Never pass socket, HTTP or other frontend input to `taskRunner.run()`.
- Never add an API that writes `events`, or anything else that is later handed to `run()`, into the config.
- The planned Automation UI must offer a fixed allow-list of server-defined actions (for example "switch relay N on"), validated on the server, not free-form commands.

The same rule is in the headers of `TaskRunner.ts`, `EventTrigger.ts` and `config/ConfigStore.ts`.

### 7.3 Bugs found during the rewrite

Found while typing the protocol and porting the code. Code comments cite them by number.

| # | Bug | State |
|---|---|---|
| 1 | `config:change` broadcast the whole config, including the JWT `secret`, to every connected socket when the rc file changed. | **Fixed:** the event is gone. |
| 2 | Reopening a port did not unload a leftover program (`unload` instead of `gcode:unload`). | **Fixed.** |
| 3 | `%wait` typed in the console holds the Sender, not the Feeder. | Kept as in CNCjs. |
| 4 | Extended real-time bytes go out UTF-8 encoded: `write()` takes a JS string, so jog cancel reaches the port as `0xC2 0x85` and the overrides as `0xC2 0x9X` (visible in `baseline/02-jog.trace` and `05-overrides.trace`). | Kept until jog cancel and the overrides are checked on hardware with raw single bytes. |
| 5 | The macro-language sandbox (`[expr]`, `%var=`) could run arbitrary code: `posx.constructor.constructor("…")()` reached `Function`, so a malicious G-code file could execute code on the server. Inherited from CNCjs. | **Fixed:** `constructor`, `prototype` and `__…` properties are refused on reads and assignment paths, function expressions are not compiled with `Function()`, and `Function`/`Object` left `GLOBAL_OBJECTS`. |
| 6 | The Sender runs its `dataFilter` a second time on a line that did not fit in the RX buffer, so the controller's filter can run twice for one program line. | Kept as in CNCjs. |
| 7 | `await port.set(...)` does not wait: serialport v10's `set()` is callback-based. | Kept as in CNCjs. |
| 8 | `command` looked handlers up on a plain object, so inherited names such as `valueOf` or `__proto__` threw inside the socket handler. | **Fixed:** own properties only; such names log "Unknown command". |
| 9 | The bug 5 fix could be escaped with a computed key whose `toString` answers differently on the second call. | **Fixed:** each computed key is converted to a string once and that string is both checked and used; any read that yields `Function` resolves to `undefined`. |

### 7.4 Safety mechanisms and interaction hazards

Read in the CNCjs 1.11.5 source (commit `a3922a1bf`) before the port; the line numbers refer to those originals. The TypeScript code under `src/server/` keeps every mechanism. Other documents and code comments cite the identifiers below (S3, H1, …).

| # | Mechanism | Where | Behaviour |
|---|---|---|---|
| S1 | Character-counting flow control | `Sender.js:157-189`, `GrblController.js:366-368` | Never overruns the controller's RX buffer. The 8-byte margin is deliberate. |
| S2 | Program bytes are not echoed | `GrblController.js:477-496` | The Sender writes straight to serial. Program lines are not broadcast as `serialport:write`, which keeps sockets from being flooded. |
| S3 | Alarm blocks the Feeder | `GrblController.js:343-347` | Queued manual commands are dropped and the queue is cleared while `activeState === 'Alarm'`. |
| S4 | Errors pause the program | `GrblController.js:635-673` | During a run, `error:x` logs the offending line and calls `workflow.pause({err:true})` unless `state.controller.exception.ignoreErrors` is set. *(The default config defines `controller.exception.ignoreErrors`, a different key, so pause-on-error is the effective default.)* |
| S5 | Pause and resume | `:1451-1466` | `gcode:pause` sets the workflow to paused, holds the Sender, and writes `!`. `gcode:resume` writes `~` and resumes the workflow (which resets the Feeder and unholds the Sender). |
| S6 | Force stop | `:1424-1446` | `gcode:stop {force:true}` stops the workflow and rewinds the Sender. If the machine is in `Run` it writes `!`, waits 500 ms, and writes `0x18` (soft reset) if it is now in `Hold`. **Caveat:** `Hold` includes `Hold:1` (decelerating). A reset during deceleration can raise an ALARM because position may be lost. |
| S7 | Soft reset | `:1508-1514` | `reset` stops the workflow, resets the Feeder, and writes `0x18`. |
| S8 | Real-time bytes bypass queues | `writeln` `:1993-2004` | `~ ! ? 0x18` and extended `0x80-0xFF` bytes are written without a newline and are not queued. |
| S9 | Status polling with watchdog | `:873-903, 944-1010` | `?` every 250 ms with a single-flight guard. The guard is force-cleared after 5 s without a reply. `$G` is polled only when idle, because it consumes RX buffer. |
| S10 | Ready gating | `:542-558, 836-854, 980-983` | Polling waits for a startup banner or the first status report. Until then a throttled `?` is sent every 2 s. |
| S11 | Completion detection | `:991-1009` | After the Sender finishes, the program auto-stops (`gcode:stop`) only after the machine has been idle with an unchanged position for at least 500 ms. |
| S12 | Connection loss | `:82-96` | A serial `close` sets `ready=false`, closes the controller (emitting `serialport:close` and `serialport:change`), removes it from the store, and destroys it. **Streaming stops**, but the controller still runs whatever is already buffered. |
| S13 | Open resets job state | `:1240-1248` | On open, the workflow is stopped and action flags are cleared. *Bug note:* `this.command('unload')` names a non-existent command. It logged `Unknown command` and did nothing. Fixed in Kinetiq (§7.3 bug 2). |
| S14 | Browser disconnect is harmless | `CNCEngine.js:186-200` | A socket disconnect only removes the listener. **Streaming continues server-side.** |
| S15 | Access control | `CNCEngine.js:147-168`, `access-control.js` | JWT is required at handshake. Non-private IPs are rejected unless remote access is enabled. |

**Software is not an emergency stop.** Every mechanism above relies on a working process, a working USB link and responsive firmware. Feed hold (`!`) and soft reset (`0x18`) are controlled-stop commands. They do **not** replace a hard-wired emergency-stop circuit that cuts power to the TB6600 drivers or the spindle.

**Rules that must stay under backend control**

The Kinetiq frontend must never re-implement any of the following, or send around it:

1. RX-buffer accounting and line release. The frontend never streams program lines itself.
2. The ok/error bookkeeping that ties responses to the Sender or Feeder.
3. Alarm gating of queued commands.
4. Pause-on-error.
5. Status and parser-state polling.
6. Job completion detection.
7. Connection-loss teardown.


**Interaction hazards**

| Hazard | Evidence | Consequence for Kinetiq |
|---|---|---|
| **H1: Direct writes during a program break char-counting.** | While `workflow.state === 'running'`, *every* `ok` is counted as a Sender acknowledgement (`GrblController.js:607-615`). A non-real-time line sent with `write`/`writeln` produces an extra `ok`, which desynchronises `received` from the bytes actually in flight. | Disable console input and jogging while the workflow is `running` or `paused`. Real-time control (`!`, `~`, `0x18`) stays available. |
| **H2: Feeder commands during a program also write immediately.** | `command('gcode')` calls `feeder.next()` if nothing is pending (`:1612-1616`), and the Feeder writes straight to serial. | Same gating as H1. |
| **H3: The CNCjs default jog has no feed rate.** | The CNCjs Axes widget sends `G91`, `G0 X…`, `G90` as three Feeder commands (`app/widgets/Axes/index.jsx:195-200`). | Kinetiq uses GRBL v1.1 `$J=` jogging through the same `command('gcode')` path. It carries a feed rate, leaves modal state unchanged, and can be cancelled with `jogCancel` (`0x85`). `gcode-parser` stripped mode keeps `$J=` lines intact (checked in `gcode-parser@2.2.0 dist/cjs/index.js:151-179`). |
| **H4: Error objects do not survive Socket.IO.** | `callback(err)` and `serialport:error {err}` send `Error` instances. Socket.IO 2 serialises them with JSON, and `JSON.stringify(new Error())` is `{}`. | Kinetiq can show "failed to open *port*", but not the OS reason (busy, permission, not found). The reason is in the server log. Confirmed at runtime, also on Socket.IO 4 (§8 U2). |
| **H5: Feeder stuck in pending.** | If an `ok` never arrives (for example the controller reboots mid-command), `feeder.state.pending` stays `true`, and later `gcode` commands queue silently until `reset`. | Show `feeder:status.queue > 0` as "commands queued". A soft reset clears it. |
| **H6: Force stop during deceleration.** | See S6. | Kinetiq's Stop sequence pauses first, waits for `Hold:0` (subState 0), then issues `gcode:stop {force:true}`. Each step is an existing command. |

---

## 8. Limitations and unresolved questions

| # | Item | Impact | Plan |
|---|---|---|---|
| U1 | Engine.IO 3 `destroyUpgrade` alongside Next dev HMR | **Resolved (M1, 2026-11-08).** With `next({ httpServer })`, `[HMR] connected` and live component edits work next to Socket.IO; the serial engine is not restarted. | — |
| U2 | Open-error reason not transmitted (hazard H4) | **Confirmed (M1), unchanged on Socket.IO 4 (2026-11-11).** The `open`/`close` callbacks and `serialport:error.err` all arrive as `{}`. The reason (e.g. "No such file or directory") only appears in the server log. | The UI shows "Could not open *port*" plus the likely causes. |
| U8 | Non-numeric `baudrate` in `open` | **Observed (M1).** `SerialConnection` throws an uncaught `TypeError`. Next's handler keeps the process alive in dev and prod, but the `open` callback never fires. | Kinetiq validates the baud rate on the client before emitting (`client.ts`). |
| U9 | No banner on connect (F1/F3) | The Connection widget cannot show the firmware until a `$I` reply passes through | **Decision pending:** have Kinetiq send a read-only `$I` once when the controller is ready, or leave identification to the console. |
| U10 | Dev-only: hot reload of `src/lib/cnc/client.ts` resets its module state while the page keeps the old socket, so actions silently do nothing until a page reload (observed in M1) | Development only | Reload the page after editing `client.ts`, or keep the socket on `globalThis` in dev. |
| U3 | FluidNC hardware checks | F1, F2, F3, F4, F6, F7 and F15 were **observed on 2026-11-08** with FluidNC v4.0.1. F9 and F10 are partly observed (relative jogging, hold/resume/reset, feed override); absolute jog and `0x85` remain. | — |
| U4 | Socket.IO 2.2 and Engine.IO 3 are old and carry published advisories (for example permissive default CORS before socket.io 2.4) | **Resolved (2026-11-11).** Server and client moved to Socket.IO 4 (no CORS by default, `allowEIO3` off, client script not served). | Loopback bind and the Host-header check stay. |
| U5 | A CNCjs checkout must be built before Kinetiq can run | **Resolved (2026-11-08):** the backend is embedded in `src/server/` (D2 revised; first as JavaScript in `src/server/cnc`, now TypeScript); `npm install` is the only setup step. | — |
| U6 | `ignoreErrors` key mismatch (`state.controller.exception.ignoreErrors` vs the default `controller.exception.ignoreErrors`) | None (the safe default holds) | Leave as is. Kinetiq never sets either key. |
| U7 | `remainingTime` is a line-count extrapolation | Inaccurate on uneven programs | **Resolved (2026-11-10):** the Job widget computes its own estimate from the toolpath, feeds and `$110`–`$122`, calibrated against the run (`API_REFERENCE.md` §7.3). `remainingTime` is only the fallback. |

---

## 9. Decisions (approved 2026-11-08)

| ID | Decision | Recommendation (all approved) |
|---|---|---|
| **D1** | Use a Next.js **custom server** (`node dist/server.js`) to host CNCEngine in the same process | **Approve.** It is the only single-application design that keeps CNCjs unmodified and safe. |
| **D2** | Consume CNCjs as a **fork build** (`file:../cncjs/dist/cncjs`, way B1) | Approve B1. B2 is the fallback. **Revised 2026-11-08:** the CNCjs GRBL server code now lives in `src/server/` (rewritten into TypeScript, §7.1) and Kinetiq no longer depends on a CNCjs checkout. |
| **D3** | Pin **`socket.io-client@2.x`** in the frontend (protocol lock-step with the CNCjs server) | Approved; **revised 2026-11-11:** server and client moved to Socket.IO 4 together, so the client is `socket.io-client@4.x`. The lock-step rule stays: upgrade both sides at once. |
| **D4** | Minimal job and safety controls beyond pure monitoring: Load file (single file picker, not a file manager), Start/Pause/Resume/Stop in the Job widget, plus a persistent **Feed Hold** and **Reset** in the top bar | Approve. Without these a job cannot run, and a hold/reset control should always be reachable. Unlock (`$X`) and Home (`$H`) were later added as buttons at the user's request (2026-11-08). |
