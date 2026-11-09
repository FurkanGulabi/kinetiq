# API Reference

**Project:** Kinetiq: Advanced Motion Control
**Scope:** The verified communication interface between the Kinetiq UI and the embedded CNCjs backend (GRBL controller only).
**Source of truth:** `CNCJS-fork/src/server/services/cncengine/CNCEngine.js` and `CNCJS-fork/src/server/controllers/Grbl/GrblController.js`. Line numbers refer to commit `a3922a1bf`. The same code now runs inside Kinetiq as `src/server/cnc/` (same file layout); Kinetiq's few changes are listed in `src/server/cnc/README.md`, so line numbers in the embedded copy can differ slightly.

Every event, payload and command below was read in source. Anything Kinetiq **derives** on the client is marked **[Kinetiq-derived]**. Anything not yet observed at runtime is marked **[runtime check]**.

---

## 1. Transport

| Item | Value | Source |
|---|---|---|
| Protocol | Socket.IO **2.2** server (Engine.IO 3). The client must be `socket.io-client@2.x`. | `package.json`, `CNCEngine.js:142` |
| Path | `/socket.io` | `CNCEngine.js:144` |
| Auth | JWT in the handshake query: `io(url, { query: 'token=' + token })` | `CNCEngine.js:147-150`, `app/index.jsx:122` |
| Token | `jwt.sign({ id, name }, settings.secret, { expiresIn: settings.accessTokenLifetime /* '30d' */ })`. With no users configured, `{ id: '', name: '' }` is valid. | `api/api.users.js:27-33, 74-83` |
| IP policy | Loopback and private ranges are allowed unless `allowRemoteAccess` is set | `access-control.js:7-37` |
| Kinetiq token endpoint | `GET /api/kinetiq/session` → `200 { token: string }`. Served by Kinetiq's custom server. **[Kinetiq-defined]**, see `BACKEND_INTEGRATION.md` §4.1 | — |

All port-scoped events take the serial **port path** (for example `/dev/tty.usbserial-0001`) as their first argument.

---

## 2. Client → server events

| Event | Arguments | Behaviour | Source |
|---|---|---|---|
| `list` | — | Calls `SerialPort.list()`, appends configured `ports`, and replies with `serialport:list`. *(Any callback argument is ignored.)* | `CNCEngine.js:203-230` |
| `open` | `port: string, options: OpenOptions, callback?: (err: object \| null) => void` | Creates a `GrblController` if none exists for the port, adds this socket, opens the port, joins room `port`, then calls `callback(null)`. If the port is already open, the socket is just attached and `callback(null)` is called. | `CNCEngine.js:233-295` |
| `close` | `port: string, callback?: (err) => void` | Leaves the room, closes the port, removes the controller from the store and destroys it. Every attached socket receives `serialport:close`. | `CNCEngine.js:298-328` |
| `command` | `port: string, cmd: string, ...args` | `controller.command(cmd, ...args)`. Ignored, with a server log entry, if the port is closed. | `CNCEngine.js:330-340` |
| `write` | `port: string, data: string, context?: object` | `controller.write(data, ctx)`: writes raw bytes immediately and bypasses the Feeder | `CNCEngine.js:342-352`, `GrblController.js:1974-1991` |
| `writeln` | `port: string, data: string, context?: object` | Writes real-time characters (`~ ! ? \x18`, `\x80-\xff`) raw; anything else gets `\n` appended. Bypasses the Feeder. | `CNCEngine.js:354-364`, `GrblController.js:1993-2004` |

### 2.1 `OpenOptions`

```ts
interface OpenOptions {
  controllerType: 'Grbl';            // defaults to 'Grbl'; Kinetiq always sends 'Grbl'
  baudrate: number;                  // REQUIRED and must be a number (see warning)
  rtscts?: boolean;                  // hardware flow control; default false
  pin?: { dtr?: boolean; rts?: boolean }; // set DTR/RTS after open (ESP32 auto-reset control)
}
```

> ⚠️ **`baudrate` must be a finite number.** `SerialConnection`'s constructor *throws* `TypeError` if `baudRate` is not a number (`SerialConnection.js:82-84`). The throw happens synchronously inside the `open` socket handler, during `new GrblController(...)`. **[runtime check]** whether it crashes the process. Kinetiq must validate the value before emitting.

---

## 3. Server → client events

| Event | Payload | When | Recipients | Source |
|---|---|---|---|---|
| `startup` | `{ loadedControllers: string[], baudrates: number[], ports: object[] }` | Immediately after the socket connects | that socket | `CNCEngine.js:178-184` |
| `serialport:list` | `Array<{ port: string, manufacturer?: string, inuse: boolean }>` | Reply to `list` | that socket | `CNCEngine.js:217-225` |
| `serialport:open` | `{ port, baudrate, controllerType: 'Grbl', inuse: true }` | The port opened successfully, **or** a socket attached to an already-open port | attached sockets | `GrblController.js:1221-1226, 1310-1317` |
| `serialport:change` | `{ port, inuse: boolean }` | The port opened or closed | **all** sockets | `GrblController.js:1229-1234, 1274-1279` |
| `serialport:close` | `{ port, inuse: false }` | Close was requested **or** the connection was lost (USB unplugged, device reset) | attached sockets | `GrblController.js:1268-1271`, `:82-96` |
| `serialport:error` | `{ err: object, port }` | The port failed to open. `err` is an `Error` and probably serialises to `{}` **[runtime check]**. | attached sockets | `GrblController.js:1189-1193` |
| `serialport:read` | `line: string` | Every controller line forwarded to the user (see §5.2) | attached sockets | many sites in `GrblController.js:542-858` |
| `serialport:write` | `data: string, context: { source: 'client' \| 'feeder', ...callerContext }` | Bytes written by `write`/`writeln` (`source:'client'`) or by the Feeder (`source:'feeder'`). **Program lines from the Sender and the `?`/`$G` polls are not emitted.** | attached sockets | `GrblController.js:354-357, 1985-1988` |
| `controller:state` | `type: 'Grbl', state: GrblState` | Every 250 ms tick in which the runner state object changed | attached sockets | `GrblController.js:973-977, 1323-1327` |
| `controller:settings` | `type: 'Grbl', settings: GrblSettings` | The settings object changed (startup banner, `$n=` lines, `[G54:…]` parameters) | attached sockets | `GrblController.js:966-970, 1318-1322` |
| `feeder:status` | `FeederStatus` | Feeder state changed (checked on each tick) | attached sockets | `GrblController.js:951-953` |
| `sender:status` | `SenderStatus` | Sender state changed (checked on each tick) | attached sockets | `GrblController.js:956-958` |
| `workflow:state` | `'idle' \| 'running' \| 'paused'` | Every workflow transition, and on attach | attached sockets | `GrblController.js:508-535, 1341-1344` |
| `gcode:load` | `name: string, gcode: string, context: object` | A program was loaded, or a socket attached while one was loaded | attached sockets | `GrblController.js:1385, 1336-1339` |
| `gcode:unload` | — | The program was unloaded | attached sockets | `GrblController.js:1400` |

"Attached sockets" means every socket that called `open` for this port (`addConnection`). A socket that has not called `open` receives only `startup`, `serialport:list` and the global `serialport:change`.

**Ignored by Kinetiq:** `Grbl:state` and `Grbl:settings` (legacy duplicates), `task:start/finish/error`, `config:change`, `watchdir:change`, `autolevel:update/complete`.

---

## 4. Types

```ts
// controller:state  (GrblRunner.state; GrblRunner.js:20-50, GrblLineParserResultStatus.js)
interface GrblState {
  status: {
    activeState: '' | 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | 'Door' | 'Check' | 'Home' | 'Sleep' | string;
    subState?: number;                    // Hold:0 complete / Hold:1 in progress; Door:0..3 (NaN when absent)
    mpos: Record<'x'|'y'|'z'|'a'|'b'|'c', string>;   // machine position, decimal STRINGS e.g. "12.500"
    wpos: Record<'x'|'y'|'z'|'a'|'b'|'c', string>;   // work position (reported, or MPos − WCO)
    wco?: Record<'x'|'y'|'z'|'a'|'b'|'c', string>;   // last reported work coordinate offset
    ov: number[];                          // [feed%, rapid%, spindle%]
    feedrate?: number;                     // live feed (FS:/F:)
    spindle?: number;                      // live spindle speed (FS:)
    buf?: { planner: number; rx: number }; // Bf: available planner blocks / RX bytes
    ln?: number;                           // Ln: line number
    pinState: string;                      // e.g. 'XZP'; '' when none triggered
    accessoryState?: string;               // e.g. 'SF'
  };
  parserstate: {
    modal: {
      motion: string;   wcs: 'G54'|'G55'|'G56'|'G57'|'G58'|'G59'|string;
      plane: string;    units: 'G20' | 'G21';
      distance: 'G90' | 'G91'; feedrate: string; program: string;
      spindle: string;  coolant: string | string[];
    };
    tool: string; feedrate: string; spindle: string;
  };
}
// activeState is '' until the first status report arrives. That is the earliest sign the controller is responding.

// controller:settings  (GrblRunner.settings; GrblRunner.js:52-58)
interface GrblSettings {
  version: string;                         // from startup banner, e.g. '3.7' for FluidNC ("Grbl 3.7 [FluidNC …]")
  parameters: Record<string, unknown>;     // [G54:…], [G28:…], [TLO:…], [PRB:…]
  settings: Record<string, string>;        // '$13' → '0' | '1', etc.
}

// sender:status  (Sender.toJSON; Sender.js:225-241)
interface SenderStatus {
  sp: 0 | 1;                 // 1 = character-counting
  hold: boolean;
  holdReason: null | { data?: 'M0'|'M1'|'M6'|'%wait'; msg?: string; err?: true };
  name: string;              // program name given to gcode:load
  context: object;
  size: number;              // program length in characters (incl. appended %wait line)
  total: number;             // non-empty lines (incl. appended %wait line)
  sent: number;              // lines handed to the serial port
  received: number;          // lines acknowledged (ok/error)
  startTime: number;         // epoch ms (server clock), 0 = not started
  finishTime: number;        // epoch ms when received >= total, 0 = not finished
  elapsedTime: number;       // ms, recomputed only on each ack
  remainingTime: number;     // ms, line-count extrapolation, 0 until ≥1 s and ≥1 ack
}

// feeder:status  (Feeder.toJSON; Feeder.js:29-37)
interface FeederStatus {
  hold: boolean;
  holdReason: null | { data?: string; msg?: string };
  queue: number;             // queued manual lines
  pending: boolean;          // one line awaiting ok/error
  changed: boolean;
}

type WorkflowState = 'idle' | 'running' | 'paused';
```

---

## 5. Connection interface (Widget 1)

### 5.1 Calls

| Action | Emit |
|---|---|
| Refresh ports | `socket.emit('list')` → `serialport:list` |
| Connect | `socket.emit('open', port, { controllerType: 'Grbl', baudrate }, cb)` (selected rate, default 115200; validated as a positive finite number first) |
| Disconnect | `socket.emit('close', port, cb)` |
| Re-attach after a page reload | `list` → for a port with `inuse: true`, `open(port, …)`. The backend attaches without reopening. |

### 5.2 Connection states [Kinetiq-derived from verified signals]

| UI state | Entered when | Signal |
|---|---|---|
| **Disconnected** | Initial; after a user-requested close completes | `serialport:close` while `userRequestedClose === true`, or no attached port |
| **Connecting** | Kinetiq emitted `open` and has no answer yet | Client-side flag between `emit('open')` and the callback |
| **Connected** | The port is open | `open` callback `null` **or** `serialport:open` |
| ↳ *Waiting for controller* (sub-status) | Open, but no status report yet | `controller:state.status.activeState === ''` |
| ↳ *Controller ready* (sub-status) | Status reports are flowing | `activeState !== ''`; banner version in `controller:settings.version` |
| **Connection error** | Open failed, **or** the port closed without a user request (cable pulled, device reset) | `open` callback with an `err` **or** `serialport:error`; or `serialport:close` while `userRequestedClose === false` |

The backend has no explicit "connecting" or "lost" event. Both are client-side derivations from the signals above, and no other states are invented.

### 5.3 Controller identification

| Field | Source |
|---|---|
| Controller type | `serialport:open.controllerType` (`'Grbl'`) |
| GRBL-compat version | `controller:settings.version` |
| Firmware name and version | Regex on `serialport:read` lines: `/FluidNC v(\d+(?:\.\d+)+[\w.-]*?)(?=[\s:\]]\|$)/` (matches the banner and the `$I` `[VER:…]` line) **[Kinetiq-derived]** |
| Port, baud | `serialport:open` |

---

## 6. Console interface (Widget 2)

### 6.1 Incoming

| Line class [Kinetiq-derived] | Rule (applied to `serialport:read`) |
|---|---|
| Error | `/^error:/i`. CNCjs reformats known codes as `error:N (message)`. During a program it first emits `> <line> (ln=N)`. |
| Alarm | `/^ALARM:/i`. Known codes are reformatted as `ALARM:N (message)`. |
| Message | `/^\[MSG:/`. FluidNC sub-levels: `INFO`, `WARN`, `ERR`. |
| Status | `/^</`. Only shown when the user sent `?`. |
| Ack | `ok` |
| Response | anything else (`$n=v (desc, units)`, `[GC:…]`, `[VER:…]`, the banner, …) |

### 6.2 Outgoing (echo)

`serialport:write (data, context)` with `context.source === 'client' | 'feeder'`. Kinetiq tags its own sends with `context.__sender__ = <clientId>`, as CNCjs does (`app/widgets/Console/index.jsx:66-71, 98-104`), so it can tell its own commands from those of other tabs.

### 6.3 Sending a manual command

| | |
|---|---|
| Emit | `socket.emit('writeln', port, line, { __sender__: clientId })` |
| Why `writeln` | It matches CNCjs console behaviour (direct, not queued), so `$X`, `$H` and `?` work in Alarm state, where Feeder commands are dropped (`GrblController.js:343-347`). |
| Guard | **Disabled while `workflow:state !== 'idle'`** (hazard H1: an extra `ok` would desynchronise char counting), and while a Kinetiq sequence (Probe Z, height-map probing, settings operation) owns the port (`derive.consoleView`). |

---

## 7. Job status interface (Widget 4)

### 7.1 Commands

| Action | Emit | Backend effect |
|---|---|---|
| Load program *(D4)* | `command(port, 'gcode:load', name, gcodeText, context, cb)` with `context = { kinetiqJobId?, kinetiqLeveling? }` (§7.4, `BED_LEVELING.md`) | `Sender.load` (appends `%wait`); workflow → idle; emits `gcode:load`. `cb(err, senderStatus)`. |
| Unload *(D4)* | `command(port, 'gcode:unload')` | workflow → idle; emits `gcode:unload` |
| Start *(D4)* | `command(port, 'gcode:start')` | workflow → running; Feeder reset; `Sender.next()` |
| Pause *(D4)* | `command(port, 'gcode:pause')` | workflow → paused; Sender holds; writes `!` |
| Resume *(D4)* | `command(port, 'gcode:resume')` | writes `~`; workflow → running |
| Stop *(D4)* | Kinetiq sequence (`client.stopJob`): `gcode:pause` (if running) → wait for `activeState === 'Hold' && subState === 0` (also accepted: `Door:0`, or Idle/Alarm once the workflow has been paused for ≥ 750 ms, i.e. nothing to decelerate) → `command(port, 'gcode:stop', { force: true })`. Gives up after 15 s with a message. | workflow → idle; Sender rewinds; soft reset `0x18` if in Hold |

**Overrides** (Job panel, any time the controller is reporting, including while a job runs):

| Action | Emit | Bytes |
|---|---|---|
| Feed override +10 / −10 / +1 / −1 / reset 100 % | `command(port, 'feedOverride', 10 \| -10 \| 1 \| -1 \| 0)` | `0x91 / 0x92 / 0x93 / 0x94 / 0x90` |
| Spindle override, same steps | `command(port, 'spindleOverride', …)` | `0x9A / 0x9B / 0x9C / 0x9D / 0x99` |

Real-time bytes (`GrblController.js` feedOverride/spindleOverride), so they never disturb streaming (no hazard H1). The displayed percentages are the controller's `Ov:feed,rapid,spindle` report (`status.ov`, kept by GrblRunner between reports); "—" until the first `Ov:`. GRBL range 10–200 %; the buttons disable at the limits. **Observed on FluidNC v4.0.1 during a running job:** Feed +10 → `Ov` 110 %, reset → 100 %. A spindle −1 % with the spindle off left `Ov` spindle at 100 %.

### 7.2 Job state [Kinetiq-derived]

The backend exposes only `idle | running | paused`. Kinetiq derives six display states from `workflow:state` plus `sender:status`:

| Kinetiq state | Rule |
|---|---|
| **Idle** | `workflow === 'idle'` and (no program loaded, or `startTime === 0`) |
| **Running** | `workflow === 'running'` |
| **Paused** | `workflow === 'paused'` and `holdReason?.err !== true` (M0/M1/M6/`%wait`/user pause; `holdReason.msg` is shown) |
| **Error** | `workflow === 'paused'` and `holdReason?.err === true` (pause-on-error, S4); **or** `activeState === 'Alarm'` while running or paused |
| **Completed** | `workflow === 'idle'`, `startTime > 0` and `finishTime > 0`. `finishTime` survives `rewind()` and is only cleared when the next run starts. |
| **Cancelled** | `workflow === 'idle'`, `startTime > 0` and `finishTime === 0` (stopped by the user, another client, reset, or connection loss) |

Completed and Cancelled can be rebuilt from server state after a page reload. Telling an error-triggered stop apart from a user stop needs client memory and is kept only for the session.

**Observed backend quirk (2026-11-08, FluidNC v4.0.1):** in a short program the Sender sends the appended `%wait` line before the `error:N` reply arrives. `%wait` calls `Sender.hold({data:'%wait'})` (Sender hold only, workflow stays running), and `Sender.hold()` returns early when already held, so the later `workflow.pause({err:true})` reason is **dropped** and the job ends with `finishTime > 0`, which looks Completed. Kinetiq therefore also records `error:` lines that CNCjs forwards on `serialport:read` while the workflow is not idle (`store.jobErrors`, keyed by `sender.startTime`). Any recorded error makes the state **Error** (paused) or **Error · Finished with errors** (idle). The program text CNCjs prints in its `> line (ln=N)` echo is `lines[received-1]`, i.e. the *previous* line; only `ln` is shown. This memory is per session: after a reload such a run shows Completed.

### 7.3 Time and progress values: source and accuracy

| Field | Source | Accuracy |
|---|---|---|
| Start time | `sender.startTime` | Exact: server clock at the first line sent. The server and browser share a host, so the same clock. |
| Finish time | `sender.finishTime`, only when **Completed** | Exact: acknowledgement of the appended `G4 P0.5` dwell, i.e. the planner has drained. **Never predicted.** Shown as "—" otherwise. |
| Elapsed | Running or paused: `Date.now() − startTime`, recomputed every 1 s on the client. Completed: `finishTime − startTime`. | Exact wall-clock time, **including pauses** (same definition as CNCjs). The client computes it because `sender.elapsedTime` only updates on acknowledgements and stalls during long moves. |
| Remaining (estimate) | `sender.remainingTime` | **Approximate.** `(elapsed / received) × total − elapsed`: it assumes every line takes the same time and counts pause time in the rate. Hidden until non-zero (≥1 s and ≥1 acknowledgement). Labeled "≈ … est.", and labeled "paused" while paused. |
| Completion % | `received / total × 100` | Acknowledged lines, not executed motion. It runs ahead of the tool by at most the RX buffer (~120 B) plus the planner queue. Line-based, not time-based. `total` includes the appended `%wait` line, so 100 % means "planner drained". |
| Lines | `received` / `total` (`sent` shown as secondary) | Exact |
| Hold reason | `sender.holdReason.msg` / `.data` | Exact |

---

### 7.4 Job library (Kinetiq HTTP API, `src/server/jobs.ts`)

Uploaded programs and their recent-run history, served by the custom server next to the session endpoint. Loading onto the controller is still `gcode:load` (§7.1), with `context = { kinetiqJobId }` so every client (and a reloaded page) knows which library entry is loaded (`sender:status.context`, `gcode:load` 3rd argument).

| Request | Response | Notes |
|---|---|---|
| `GET /api/kinetiq/jobs` | `JobRecord[]`, most recently used first | |
| `POST /api/kinetiq/jobs?name=<file>` (body: G-code, `text/plain`) | `201 JobRecord` | Extensions `.nc .gcode .gc .ngc .tap .cnc .txt`; ≤ 50 MB; empty or binary (NUL) files rejected; name reduced to its basename. Same name + same SHA-256 reuses the existing record (history kept). |
| `GET /api/kinetiq/jobs/<id>/gcode` | `text/plain` | |
| `PATCH /api/kinetiq/jobs/<id>` (body `{ touch?: true, lastRun?: JobRun }`) | `JobRecord` | `touch` on load; `lastRun` written by the client when a run ends |
| `DELETE /api/kinetiq/jobs/<id>` | `204` | Removes the record and file |

```ts
interface JobRecord { id: string /* 16 hex */; name: string; size: number; lines: number /* non-empty */;
  sha256: string; uploadedAt: number; lastUsedAt: number; lastRun: JobRun | null }
interface JobRun { status: 'completed' | 'cancelled' | 'error'; startedAt: number; endedAt: number }
```

- **Auth:** loopback `Host` (same DNS-rebinding check as the session endpoint) **and** `Authorization: Bearer <session JWT>`; otherwise `403`. The client refetches the token once on `403`.
- **Storage:** `~/.kinetiq/jobs/<id>.nc` + `index.json` (dir `0700`, files `0600`; override `KINETIQ_JOBS_DIR`). Index writes are serialised and atomic (tmp + rename). The 50 most recently used jobs are kept; older files are deleted.
- **Run outcome:** recorded by the browser when the workflow returns to idle: `completed` (finishTime set, no errors), `error` (an Error state or controller error was seen during the run), else `cancelled`. Best effort: a run that ends while no Kinetiq tab is open is not recorded.

### 7.5 Machine settings (Kinetiq HTTP API, `src/server/fluidnc/`)

`/api/kinetiq/machine-config` (read, save, restart, backups) for the FluidNC config editor. Same auth as §7.4. Endpoints, payloads and errors are in `SETTINGS_EDITOR.md` §3.4.

---

## 8. Coordinates interface (Widget 3)

| Value | Source |
|---|---|
| Work X/Y/Z | `controller:state.status.wpos.{x,y,z}` (decimal strings; parse with `Number()`) |
| Machine X/Y/Z | `controller:state.status.mpos.{x,y,z}` |
| Active WCS | `controller:state.parserstate.modal.wcs` (`G54`…`G59`). Refreshed by `$G` polling **only while idle**. |
| Report units | `controller:settings.settings['$13'] === '1'` means inches, otherwise mm. **The position units follow `$13`, not the G20/G21 modal state** (see the comment at `GrblController.js:749-751`). |
| Machine state | `controller:state.status.activeState` (+ `subState`) |
| Live feed and spindle | `status.feedrate`, `status.spindle` |
| Triggered pins | `status.pinState` (e.g. `X`, `Z`, `P`) |

---

## 9. Jog interface (Widget 3)

| Action | Emit |
|---|---|
| Jog one step | `command(port, 'gcode', '$J=G91 G21 X10 F1000', { __sender__: clientId })`: one axis per press, signed distance, `G21` (or `G20` when the UI is in inches), feed in units/min |
| Cancel jog | `command(port, 'jogCancel')` → real-time `0x85` (`GrblController.js:1515-1518`) |
| Go to (one axis) | `command(port, 'gcode', '$J=G90 G21 X11 F1000', ctx)`: absolute jog in work coordinates at the jog feed |
| Zero (one axis) | `command(port, 'gcode', 'G10 L20 P1 X0', ctx)`: P from the active WCS (G54 → 1 … G59 → 6), same as the CNCjs Axes widget |
| Home (one axis) | `writeln(port, '$HX', ctx)`: FluidNC single-axis homing; direct write so it works from Alarm (the Feeder drops lines in Alarm) |
| Go to zero | Jog pad button. `command(port, 'gcode', '$J=G90 G21 X0 Y0 F1000', ctx)`, plus `'$J=G90 G21 Z0 F1000'` when **Include Z** is checked (off by default, saved in `localStorage` `kinetiq.goZeroIncludeZ`). Order: Z below work zero → Z0 first, then X0 Y0; otherwise X0 Y0 first, then Z0. Both lines queue in the Feeder and run one after the other. Same gating as Go to; also disabled when already at zero. With Z excluded and the tool below zero, the preview warns that XY moves at that depth. |

**Why `$J=` through `command('gcode')`:**
1. The Feeder path waits for `ok` before each line and is **alarm-gated** (S3).
2. `$J=` leaves the G90/G91 and G20/G21 modal state unchanged.
3. It carries an explicit feed rate.
4. The firmware rejects it in Alarm or outside soft limits, with an `error:` shown in the console.
5. It can be cancelled.

The `$J=` line reaches the controller unchanged: `gcode-parser` stripped mode keeps it intact. Relative jogging was confirmed on FluidNC v4.0.1 by the operator (2026-11-08); absolute `$J=G90` and `0x85` are still **[Hardware check]** (`BACKEND_INTEGRATION.md` F9).

**Guard [Kinetiq-derived]:** jog controls are enabled only when all of the following hold:
- connected and controller ready;
- `workflow === 'idle'`;
- `activeState ∈ { 'Idle', 'Jog' }`;
- no other jog line pending (`feeder:status.pending === false`);
- no Kinetiq sequence running (Probe Z, height-map probing, settings operation).

The Feeder condition stops repeated clicks from piling up moves. In every other state the controls are disabled and show the reason ("Alarm — use Home or Unlock in the top bar first", "Jog is disabled while a job is running or paused", …).

### 9.1 Probing sequences (Probe Z, height map)

Probe Z (`lib/cnc/probe.ts`) and height-map probing (`lib/leveling/run.ts`, `BED_LEVELING.md`) use the same Feeder path as jogging, one line at a time (`lib/cnc/lineSequence.ts`): `command(port, 'gcode', line, ctx)`, and the next line is sent only after this line's `ok` arrives on `serialport:read`. A `G38.2` step must also see a `[PRB:x,y,z:1]` report before its `ok`. The sequence stops at the first `error:`, `ALARM:`, probe report without contact, timeout or lost connection; cancel sends `feedhold`, then `reset` 400 ms later. Queueing a whole probe program at once would be unsafe: the Feeder keeps sending after an `error:`. Probe Z sends `G21 G91`, `G38.2 Z-<maxTravel> F<fast>`, `G0 Z<backoff>`, `G38.2 Z-<backoff+1> F<slow>`, `G90`, `G10 L20 P<wcs> Z<thickness>`, `G91 G0 Z<retract>`, then restores the previous distance and units mode.

---

## 10. Safety and machine commands (top bar, D4)

Observed on FluidNC v4.0.1: feed hold (`!`) on an **idle** machine puts FluidNC into `Hold:0` (classic GRBL ignores it); cycle start (`~`) returns it to Idle. Kinetiq therefore shows Resume whenever the state is Hold or Door.


| Control | Emit | Notes |
|---|---|---|
| Feed hold | If `workflow === 'running'`: `command(port, 'gcode:pause')`; otherwise `command(port, 'feedhold')` (`!`) | Pausing the workflow keeps the Sender consistent with the hold |
| Cycle start / resume | If `workflow === 'paused'`: `command(port, 'gcode:resume')`; otherwise `command(port, 'cyclestart')` (`~`) | — |
| Reset | `command(port, 'reset')` | Workflow → idle, Feeder cleared, `0x18`. A reset during motion causes ALARM (position lost); this is GRBL behaviour. **Not an emergency stop.** Observed on FluidNC v4.0.1: prints `Grbl 4.0 [FluidNC v4.0.1 (wifi) '$' for help]`; **an existing Alarm is not cleared** (homing enabled, `$22=1`). |
| Unlock | `command(port, 'unlock')` → `$X` | Enabled only in Alarm with the workflow idle. Observed on FluidNC v4.0.1: replies `[MSG:INFO: Caution: Unlocked]`, state → Idle. |
| Home | `command(port, 'homing')` → `$H` | Enabled in Idle or Alarm with the workflow idle. **Moves the machine.** Not yet exercised on hardware. |

---

## 11. Not used by Kinetiq v1 (exists in the backend)

`macro:run`, `macro:load`, `watchdir:load`, `autolevel:*`, `rapidOverride`, `sleep`, `statusreport`, `feeder:feed`, `feeder:start`, `feeder:stop`, the `write` event, and the CNCjs REST API (not carried over). `tool:change` and `lasertest:*` were removed from the embedded backend (2026-11-08, `src/server/cnc/README.md`).
