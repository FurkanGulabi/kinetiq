# CNCjs Analysis

**Project:** Kinetiq: Advanced Motion Control
**Subject:** `CNCJS-fork/` (CNCjs 1.11.5, commit `a3922a1bf`)
**Scope:** The backend (`src/server/`) as used for GRBL-compatible controllers (target: FluidNC on ESP32).
**Status:** Analysis only. Nothing in `CNCJS-fork/` was modified.

---

## 1. Method

### 1.1 Graphify

| Item | Finding |
|---|---|
| Graphify CLI | Installed at `~/.local/bin/graphify` |
| Existing graph | `cnc-app/graphify-out/graph.json`, `GRAPH_REPORT.md`, `graph.html` |
| Graph root | `CNCJS-fork/src` (from `graphify-out/.graphify_root`) |
| Freshness | Built 2026-11-08 at 18:07, after the fork was cloned at 18:01. The fork's working tree is clean, so the graph is current. |
| Size | 573 files, 2,479 nodes, 5,713 edges, 168 communities |
| Extraction | AST only (0 LLM tokens): 94 % EXTRACTED and 6 % INFERRED edges (347; average confidence 0.85) |
| Side effect | A `CNCJS-fork/src/graphify-out/cache/` folder already existed before this analysis. Graphify created it; it is not a source change. |

Queries used:

```
graphify explain "GrblController"     graphify explain "SerialConnection"
graphify explain "CNCEngine"          graphify explain "Feeder"
graphify explain "Sender"             graphify path "CNCEngine" "SerialConnection"
graphify path "GrblController" "Sender"
graphify query "How does the server start and how are socket.io connections handed to controllers?"
graphify query "Grbl runner status parsing activeState mpos wpos"
+ a direct scan of graph.json for INFERRED edges touching cncengine/Grbl/Sender/Feeder/SerialConnection/Workflow
```

### 1.2 Validation rule

Every architectural claim below was traced from a graph node to its source file and then read in the code. Each relationship is labeled one of two ways:

- **CONFIRMED.** Read in source. The file and line are given.
- **GRAPH-ONLY.** Reported by Graphify but not confirmed, or confirmed false.

### 1.3 What Graphify got right, got wrong, and cannot see

| Observation | Detail |
|---|---|
| Import and construction edges are reliable | `CNCEngine.js → GrblController`, and `GrblController.constructor → SerialConnection / Feeder / Sender / Workflow / GrblRunner`, are all EXTRACTED and CONFIRMED. |
| Method-call edges are INFERRED but correct | Edges such as `GrblController.command() → Sender.load()`, `→ Workflow.pause()` and `→ Feeder.feed()` carry confidence 0.85 because Graphify resolves `this.sender.*` by inference. Every one checked in `GrblController.js` is real: **CONFIRMED.** |
| False INFERRED edges exist | `GrblController.constructor → noop() [TinyGController.js]` is wrong: it is a local `_.noop`. `app/widgets/Visualizer/index.jsx → Feeder.size()` is impossible because the frontend cannot call a server class. `GrblController.test.js → monitor.failure()` is also spurious. |
| Blind spot: Socket.IO wiring | The frontend and backend are linked only by **string event names** (`socket.emit('open', …)` ↔ `socket.on('open', …)`), and the AST graph has no edge for these. All interfaces in `API_REFERENCE.md` were therefore taken from source, not from the graph. |
| Blind spot: runtime singletons | The graph shows `store`, `configstore` and `taskRunner` as modules. It does not show that they are **process-wide singletons**, which drives the integration design. |

---

## 2. Backend at a glance

CNCjs's backend is one Node.js process with five parts:

1. **HTTP layer.** Express, run through `webappengine`. It serves the old React app and a REST API.
2. **CNCEngine.** Attaches Socket.IO to the HTTP server and maps socket events to controller instances.
3. **Controllers.** One class per firmware family. `GrblController` is the only one in scope.
4. **Streaming primitives.** `SerialConnection`, `Feeder`, `Sender`, `Workflow`, plus a firmware-specific `Runner` (line parser and state).
5. **Services.** `configstore` (the `~/.cncrc` JSON file), `taskRunner` (shell tasks), `monitor` (watch directory), and the `store` registry of open controllers.

Kinetiq needs (2) through (5) for GRBL and **nothing** from (1).

---

## 3. Dependency map (actual backend, GRBL path)

Solid arrows are CONFIRMED in source. The dotted arrow is a run-time relationship that the graph does not show.

```mermaid
flowchart TD
    CLI["server-cli.js\ncommander → createServer()"] --> IDX["server/index.js\ncreateServer()"]
    IDX -->|config.load(rcfile)| CFG[(services/configstore\n~/.cncrc, EventEmitter)]
    IDX -->|webappengine routes| APP["server/app.js\nExpress + REST /api/*\n(NOT needed by Kinetiq)"]
    IDX -->|on 'ready': cncengine.start(server, controller)| ENG["services/cncengine/CNCEngine\nSocket.IO server @ /socket.io"]

    ENG -->|socketio-jwt.authorize(settings.secret)| JWT[socketio-jwt]
    ENG -->|authorizeIPAddress / validateUser| ACL[access-control.js]
    ENG -->|SerialPort.list()| SP[(serialport v10\nnative addon)]
    ENG -->|new GrblController(engine, opts)| GC["controllers/Grbl/GrblController"]
    ENG -->|controllers[port]| STORE[(store\nImmutableStore singleton)]
    ENG --> TR[services/taskrunner]
    ENG --> MON[services/monitor]

    GC --> SC["lib/SerialConnection\nSerialPort + ReadlineParser('\\n')"]
    SC --> SP
    GC --> FEED["lib/Feeder\nqueue for manual cmds\n(send-response, 1 line in flight)"]
    GC --> SEND["lib/Sender\nG-code program streamer\n(char-counting, 120 B)"]
    GC --> WF["lib/Workflow\nidle / running / paused"]
    GC --> RUN["controllers/Grbl/GrblRunner\nstate + settings"]
    RUN --> LP["GrblLineParser\n+ 13 ResultXxx parsers"]
    GC --> CFG
    GC --> ET[lib/EventTrigger]
    GC -.->|emit(event) to every added socket| ENG
    SEND --> GP[gcode-parser\nparseLine stripped]
    FEED --> GP
```

### 3.1 Runtime data flow (confirmed)

```
Browser ──socket.emit('command', port, 'gcode', 'G0 X1')──▶ CNCEngine  (CNCEngine.js:330)
   CNCEngine ─ store.get(controllers[port]) ─▶ GrblController.command('gcode', …)  (GrblController.js:1599)
      Feeder.feed → Feeder.next → dataFilter (expression/M0/M6) → 'data'  (Feeder.js:96)
         GrblController: alarm check → emit('serialport:write') → SerialConnection.write  (GrblController.js:337-361)
            serialport ─▶ FluidNC

FluidNC ─▶ serialport ─▶ ReadlineParser('\n') ─▶ SerialConnection 'data'  (SerialConnection.js:39)
   GrblController.connectionEventListener.data → GrblRunner.parse(line)  (GrblController.js:78)
      GrblLineParser → typed result → runner emits 'status' | 'ok' | 'error' | 'alarm' | …  (GrblRunner.js:62)
         GrblController handlers → Sender.ack/next or Feeder.next, emit('serialport:read')  (GrblController.js:542-858)
   queryTimer (250 ms): emit 'controller:state' / 'controller:settings' / 'sender:status' / 'feeder:status' on change;
                        writes '?' (status) and '$G' (parser state) polls  (GrblController.js:944-1010)
```

---

## 4. Subsystems

Each entry gives the subsystem's responsibility, location, interface, dependencies and whether it can be reused on its own.

### 4.1 Entry point and lifecycle: `server-cli.js`, `server/index.js`

- **Responsibility:** parse the CLI, load config, generate a secret, start the HTTP server, then call `cncengine.start(server, controller)` on `ready`.
- **Key code:** `index.js:52-67` loads config and generates a secret with `bcrypt.genSaltSync()` if none exists, then persists it. `index.js:233-260` calls `webappengine({ port, host, routes })` and then `.on('ready', server => cncengine.start(server, …))`.
- **No signal handling.** There is no SIGINT/SIGTERM handler anywhere in `server/`, `main.js` or `server-cli.js` (`grep` confirmed). On process exit the OS closes the serial file descriptor.
- **Reuse:** Not reused. Kinetiq replaces this ~20-line bootstrap (config load, secret, engine start) with its own custom server. The Express app and webappengine are dropped.

### 4.2 CNCEngine: `services/cncengine/CNCEngine.js`

- **Responsibility:** owns the **Socket.IO 2.2 server**, authenticates sockets, lists serial ports, creates and opens controllers, and routes commands to them.
- **Public interface:**
  - `start(server: http.Server, controller = '')`. The `controller` argument limits which controller classes are registered. `start(server, 'Grbl')` registers **only** `GrblController` (`CNCEngine.js:100-121`).
  - `stop()`.
- **Socket.IO setup** (`:142-168`): `socketIO(server, { serveClient: true, path: '/socket.io' })`, then `socketioJwt.authorize({ secret: settings.secret, handshake: true })`, then IP whitelist and user validation.
- **Socket events handled:** `list`, `open`, `close`, `command`, `write`, `writeln` and `disconnect`. On connect it emits `startup`. Full detail is in `API_REFERENCE.md`.
- **Multi-client model:** one controller per serial port, held in `store.controllers[port]`. Every socket that emits `open` is added to that controller with `addConnection`. If the port is already open, `open` just attaches and replays state (`:266-273`).
- **Dependencies:** `serialport`, `socket.io@2`, `socketio-jwt`, `store`, `configstore`, `taskRunner`, `monitor`, `access-control`, `config/settings`.
- **Reuse:** **Yes, as-is.** It needs only an `http.Server` and a loaded config. This is the integration point for Kinetiq.

### 4.3 Serial communication: `lib/SerialConnection.js`

- **Responsibility:** wraps `serialport` v10. Opens with `autoOpen: false`, pipes through `ReadlineParser({ delimiter: '\n' })`, and re-emits `data`, `open`, `close` and `error`.
- **Interface:** `open(cb)`, `close(cb)`, `write(data, context)`, `isOpen`, `isClose`, `ident`, plus an optional `writeFilter`.
- **Defaults:** 115200 baud, 8N1, no flow control. It validates its options strictly: it throws if `baudrate` is passed instead of `baudRate`.
- **Transport:** USB/UART serial only. There is no TCP, telnet or WebSocket transport, so **FluidNC's WiFi/telnet interfaces are not reachable through CNCjs.**
- **Reuse:** Yes. It is used internally by `GrblController` and Kinetiq never calls it directly.

### 4.4 GRBL controller: `controllers/Grbl/GrblController.js` (2,007 lines)

- **Responsibility:** the whole GRBL protocol policy. It wires the connection, Runner, Feeder, Sender and Workflow together, polls status, interprets responses, enforces alarm and error handling, and broadcasts state to sockets.
- **Constructor** (`:170-1011`):
  - Creates `SerialConnection`. Its `writeFilter` watches for `$13=` (report-inches) changes.
  - Creates a `Feeder` whose `dataFilter` handles `%msg`, `%wait`, `%expr`, `[expression]` translation and M0/M1/M6 holds.
  - Creates a `Sender(SP_TYPE_CHAR_COUNTING, { bufferSize: 128 - 8 })` with the same filter. In the program context this triggers `workflow.pause` on M0/M1/M6 instead.
  - Creates a `Workflow` and wires `start`/`stop` to `sender.rewind()`, `pause` to `sender.hold()`, and `resume` to `feeder.reset()`, `sender.unhold()` and `sender.next()`.
  - Creates a `GrblRunner` and attaches handlers for `status`, `ok`, `error`, `alarm`, `parserstate`, `parameters`, `feedback`, `settings`, `startup` and `others`.
  - Starts `queryTimer = setInterval(…, 250)`, which emits changed state and polls `?` and `$G`.
- **Public methods:** `open(cb)`, `close(cb)`, `isOpen()`, `isClose()`, `addConnection(socket)`, `removeConnection(socket)`, `emit()`, `command(cmd, ...args)`, `write(data, ctx)`, `writeln(data, ctx)`, `destroy()`, `get status`.
- **Commands** (`:1365-1972`): `gcode:load`, `gcode:unload`, `gcode:start`, `gcode:stop`, `gcode:pause`, `gcode:resume`, `feeder:feed`, `feeder:start`, `feeder:stop`, `feedhold`, `cyclestart`, `statusreport`, `homing`, `sleep`, `unlock`, `reset`, `jogCancel`, `feedOverride`, `spindleOverride`, `rapidOverride`, `lasertest:on`, `lasertest:off`, `gcode`, `macro:run`, `macro:load`, `watchdir:load`, `tool:change`, `autolevel:*`, plus the deprecated aliases `start`, `stop`, `pause` and `resume`.
- **Reuse:** **Yes, as-is.** It is reached only through CNCEngine's socket events.

### 4.5 GRBL parsing and state: `GrblRunner.js`, `GrblLineParser*.js`

- **Responsibility:** classifies each received line and maintains `state` and `settings`.
- **Parsers, in priority order** (`GrblLineParser.js:19-73`): Status `<…>`, `ok`, `error:x`, `ALARM:x`, ParserState `[GC:…]`, Parameters `[G54:…]`/`[PRB:…]`, `[HLP:]`, `[VER:]`, `[OPT:]`, `[echo:]`, Feedback `[MSG:]`, Settings `$n=v`, Startup `Grbl X.Y […]`.
- **State shape:** `state.status.{activeState, subState, mpos, wpos, wco?, ov, feedrate, spindle, buf, pinState, accessoryState, ln?}` and `state.parserstate.{modal, tool, feedrate, spindle}`. Settings shape: `{ version, parameters, settings }`.
- **WPos and MPos derivation** (`GrblRunner.js:70-89`): if only one of MPos or WPos is reported, the other is computed from WCO. The last WCO is cached because GRBL sends WCO only periodically.
- **Note:** `[VER:]`, `[OPT:]`, `[HLP:]` and `[echo:]` are parsed but have no dedicated runner branch. They reach `others` and are forwarded raw as `serialport:read`.
- **Reuse:** Yes, indirectly through `controller:state` and `controller:settings`.

### 4.6 Manual command queue: `lib/Feeder.js`

- **Responsibility:** the queue for **non-program** commands (`command('gcode', …)`, macros, tool change). It is a send-response protocol: one line in flight, and the next line is released on `ok` or `error` (`GrblController.js:632, 684`).
- **Interface:** `feed(lines, ctx)`, `next()`, `hold(reason)`, `unhold()`, `reset()`, `clear()`, `isPending()`, `size()`, `peek()`, `toJSON()`.
- **Safety:** the Feeder's `data` handler **drops the line and resets the queue while the controller is in Alarm** (`GrblController.js:343-347`).

### 4.7 Program streamer: `lib/Sender.js`

- **Responsibility:** streams a loaded G-code program.
- **Character-counting protocol** (`Sender.js:157-189`): it tracks the bytes in flight (`dataLength`) against `bufferSize`. A line is sent only if `dataLength + len + 1 < bufferSize`, and each `ok` pops the oldest line length. The default `bufferSize` is `128 - 8 = 120` (`GrblController.js:368`). It grows automatically to `Bf.rx - 8` when a status report shows a larger RX buffer, but only while the workflow is idle and the queue is empty (`GrblController.js:570-592`).
- **State:** `{ hold, holdReason, name, gcode, context, lines, total, sent, received, startTime, finishTime, elapsedTime, remainingTime }`.
- **Timing math** (`Sender.js:336-376`), run only inside `next()`, which is called on each acknowledgement:
  - `startTime` is set when `sent === 0` on the first `next()`.
  - `elapsedTime = now − startTime`.
  - After 1 s and at least one acknowledgement: `remainingTime = (elapsed / received) × total − elapsed`.
  - `finishTime` is set once, when `received >= total`.
- **`gcode:load` appends `%wait`** (a `G4 P0.5` dwell) to the program, so `finishTime` is reached only when the planner has drained (`GrblController.js:1378`). `total` therefore includes one extra line.
- **`rewind()`** resets `sent` and `received` but **not** the time fields (`Sender.js:379-393`).

### 4.8 Workflow: `lib/Workflow.js`

- Three states only: `idle`, `running`, `paused`. There is **no** completed, cancelled or error state in the backend.
- Transitions: `start` (from any state except running), `stop` (from any state except idle), `pause` (running only), `resume` (paused only).

### 4.9 Services and singletons

| Module | Role | Note for Kinetiq |
|---|---|---|
| `store/index.js` | `ImmutableStore({ controllers: {} })`, the registry of open controllers | Process-wide singleton. **Exactly one engine per process.** |
| `services/configstore` | Loads and watches the JSON rc file and emits `change` | Must be `load()`ed before `cncengine.start()`. Read keys include `secret`, `ports`, `baudrates`, `users`, `macros`, `events`, `tool.*` and `state.controller.exception.ignoreErrors`. |
| `config/settings.js` | Merges base and env settings. `secret` defaults to the package version and is overwritten by the bootstrap. | `settings.base.js` imports `../../package.json`, so the build output must keep the `dist/cncjs/package.json` layout. |
| `access-control.js` | IP whitelist (loopback and private ranges) unless `allowRemoteAccess`; user check against `config.users` | With no users configured, any validly signed token passes. |
| `services/taskrunner`, `services/monitor` | Shell tasks for system event triggers; watch directory | Imported by CNCEngine. They stay inert unless configured. |

---

## 5. Controller architecture

```
CNCEngine.controllerClass = { Grbl: GrblController, Marlin: …, Smoothie: …, TinyG: … }
                                   ▲ only Grbl registered when start(server, 'Grbl')
socket 'open' {controllerType:'Grbl'} → new GrblController(engine, {port, baudrate, rtscts, pin})
```

All four controllers share the same primitives (`SerialConnection`, `Feeder`, `Sender`, `Workflow`) and the same socket contract (`command`, `write`, `writeln`, `controller:state`, …). Only the Runner, the parsers and the command table differ. Out-of-scope controllers stay in the codebase untouched. Kinetiq simply never registers them.

---

## 6. Safety-critical mechanisms (confirmed in source)

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
| S13 | Open resets job state | `:1240-1248` | On open, the workflow is stopped and action flags are cleared. *Bug note:* `this.command('unload')` names a non-existent command. It logs `Unknown command` and does nothing (the real name is `gcode:unload`). The first open has no loaded G-code anyway. |
| S14 | Browser disconnect is harmless | `CNCEngine.js:186-200` | A socket disconnect only removes the listener. **Streaming continues server-side.** |
| S15 | Access control | `CNCEngine.js:147-168`, `access-control.js` | JWT is required at handshake. Non-private IPs are rejected unless remote access is enabled. |

**Software is not an emergency stop.** Every mechanism above relies on a working process, a working USB link and responsive firmware. Feed hold (`!`) and soft reset (`0x18`) are controlled-stop commands. They do **not** replace a hard-wired emergency-stop circuit that cuts power to the TB6600 drivers or the spindle.

### 6.1 Rules that must stay under backend control

The Kinetiq frontend must never re-implement any of the following, or send around it:

1. RX-buffer accounting and line release. The frontend never streams program lines itself.
2. The ok/error bookkeeping that ties responses to the Sender or Feeder.
3. Alarm gating of queued commands.
4. Pause-on-error.
5. Status and parser-state polling.
6. Job completion detection.
7. Connection-loss teardown.

---

## 7. Interaction hazards found while tracing the code

| Hazard | Evidence | Consequence for Kinetiq |
|---|---|---|
| **H1: Direct writes during a program break char-counting.** | While `workflow.state === 'running'`, *every* `ok` is counted as a Sender acknowledgement (`GrblController.js:607-615`). A non-real-time line sent with `write`/`writeln` produces an extra `ok`, which desynchronises `received` from the bytes actually in flight. | Disable console input and jogging while the workflow is `running` or `paused`. Real-time control (`!`, `~`, `0x18`) stays available. |
| **H2: Feeder commands during a program also write immediately.** | `command('gcode')` calls `feeder.next()` if nothing is pending (`:1612-1616`), and the Feeder writes straight to serial. | Same gating as H1. |
| **H3: The CNCjs default jog has no feed rate.** | The CNCjs Axes widget sends `G91`, `G0 X…`, `G90` as three Feeder commands (`app/widgets/Axes/index.jsx:195-200`). | Kinetiq uses GRBL v1.1 `$J=` jogging through the same `command('gcode')` path. It carries a feed rate, leaves modal state unchanged, and can be cancelled with `jogCancel` (`0x85`). `gcode-parser` stripped mode keeps `$J=` lines intact (checked in `gcode-parser@2.2.0 dist/cjs/index.js:151-179`). |
| **H4: Error objects do not survive Socket.IO.** | `callback(err)` and `serialport:error {err}` send `Error` instances. Socket.IO 2 serialises them with JSON, and `JSON.stringify(new Error())` is `{}`. | Kinetiq can show "failed to open *port*", but not the OS reason (busy, permission, not found). The reason is in the server log. *Runtime confirmation pending (M1).* |
| **H5: Feeder stuck in pending.** | If an `ok` never arrives (for example the controller reboots mid-command), `feeder.state.pending` stays `true`, and later `gcode` commands queue silently until `reset`. | Show `feeder:status.queue > 0` as "commands queued". A soft reset clears it. |
| **H6: Force stop during deceleration.** | See S6. | Kinetiq's Stop sequence pauses first, waits for `Hold:0` (subState 0), then issues `gcode:stop {force:true}`. Each step is an existing command. |

---

## 8. Important source files

| File | Why it matters |
|---|---|
| `src/server/services/cncengine/CNCEngine.js` | Socket.IO server; the whole client contract |
| `src/server/controllers/Grbl/GrblController.js` | GRBL policy, commands, emitted events, safety |
| `src/server/controllers/Grbl/GrblRunner.js` | State model (`controller:state`) |
| `src/server/controllers/Grbl/GrblLineParserResultStatus.js` | Status report fields |
| `src/server/controllers/Grbl/GrblLineParserResultStartup.js` | Startup banner regex (FluidNC identification) |
| `src/server/controllers/Grbl/constants.js` | Active states, error and alarm tables, real-time commands |
| `src/server/lib/Sender.js` | Streaming, progress and timing data |
| `src/server/lib/Feeder.js` | Manual command queue |
| `src/server/lib/Workflow.js` | Job state machine |
| `src/server/lib/SerialConnection.js` | Serial port lifecycle |
| `src/server/index.js` | Bootstrap: config, secret, engine start |
| `src/server/access-control.js`, `src/server/api/api.users.js:27-33` | Token format and validation |
| `src/server/config/settings*.js` | `secret`, `rcfile`, environment merge |
| `src/package.json` | **Server-only dependency list** (copied into `dist/cncjs/package.json` by the build) |
| `scripts/build-prod.sh` | Shows that `babel -d dist/cncjs/server src/server` produces the runnable server |
| `src/app/lib/controller/Controller.js`, `src/app/index.jsx:118-126` | Reference client: `io.connect(host, { query: 'token=' + token })` |

---

## 9. Reusable backend components (summary)

| Component | Reuse in Kinetiq | How |
|---|---|---|
| CNCEngine | **Yes** | Instantiated by the Kinetiq custom server on Kinetiq's own `http.Server` |
| GrblController, GrblRunner, parsers | **Yes** | Through the CNCEngine socket contract |
| Sender, Feeder, Workflow, SerialConnection | **Yes** | Internal to GrblController |
| configstore, settings, store, access-control | **Yes** | Bootstrap: `config.load(rcfile)` and set `settings.secret` |
| Express app, REST API, webappengine, views, i18n, old React app | **No** | Not needed for the four widgets |
| Marlin, Smoothie and TinyG controllers | **Not registered** | Left in place and untouched |
