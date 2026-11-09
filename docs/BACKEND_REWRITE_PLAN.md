# Backend rewrite plan: CNCjs JavaScript → modular TypeScript

Status: branch `refactor/typescript-backend` (cut from `main` at `ce7ef91`). **Phase 0 done** (protocol types, recorder, baseline). **Phase 1 done** (removals; bugs 1 and 2 of §3a fixed). **Phase 2 done** (leaf modules in TypeScript; bug 5 of §3a found and fixed). **Phase 3 done** (serial + streaming core in TypeScript; bugs 6–7 of §3a found). **Phase 4 done** (GrblController split into `src/server/controller/`; protocol diff identical; bug 8 of §3a found). **Phase 5 done** (`CNCEngine.js` → `engine/SocketEngine.ts`, `access-control.js` → `session.ts`, typed `backend.ts`, `allowJs` removed; no JavaScript left under `src/server/`; bug 8 of §3a fixed; protocol diff identical). Phase 6: docs done, `main` merged into the branch (7734d94); waiting for the hardware session in `docs/hardware/REWRITE_HARDWARE_CHECK.md`, then merge to `main`.

## 1. Why

`src/server/cnc` was the CNCjs 1.11.5 GRBL server, copied in as JavaScript (45 files, ~6,400 lines). (As of phase 5 it is fully ported and the folder is gone; provenance and the CNCjs licence: `BACKEND_INTEGRATION.md` §7.1, `src/server/CNCJS_LICENSE`.) It works and has run on the real machine, but:

- `controllers/Grbl/GrblController.js` is 1,852 lines in one class: serial lifecycle, Feeder, Sender, status polling, workflow, 32 command handlers, socket fan-out. The graph (`graphify-out/`, 480 nodes, 19 communities) puts it as the top god node, and its community ("Controller Core and Streaming", 73 nodes) has the lowest cohesion (0.06).
- The browser types (`src/lib/cnc`) guess the backend's payloads; nothing shares a type with the server.
- It carries generic-CNCjs features Kinetiq never uses (see §3), plus old dependencies (`lodash`, `ensure-type`, `chalk`, `shortid`, `watch`, `socketio-jwt`, socket.io 2.2).

## 2. Ground rules

1. **The socket protocol does not change** during the rewrite: same event names, same payload shapes, same command names (`docs/API_REFERENCE.md`). The UI is not touched until the last step. socket.io 2 → 4 is a separate, later change.
2. **Machine behaviour does not change.** The rewrite is structural. Anything that changes what reaches the serial port (§3 deletions included) is called out per phase.
3. **Every phase leaves the app working** and is one commit (or a short series) on this branch. `main` only receives the branch after the hardware check (phase 6), so `main` stays a safe fallback; individual phases can also be merged early if they are verified.
4. **No automated tests** (project rule). Verification is the fake-controller protocol diff (§4) plus `npm run typecheck`, and a hardware session at the end.

## 3. What is removed (not ported)

Checked against the client (`src/lib/cnc/client.ts`, components) and the server TS code: none of these are called.

| Remove | Why |
|---|---|
| Commands `macro:run`, `macro:load`, `watchdir:load`, `autolevel:*` (6), `sleep`, `rapidOverride`, `feeder:feed/start/stop`, `statusreport`, and the aliases `start`/`stop`/`pause`/`resume` if unused | Never sent by the UI. |
| Events `Grbl:settings`, `Grbl:state`, `autolevel:*`, `watchdir:change` | The UI listens to `controller:*` only. |
| `services/monitor` (FSMonitor, `watch` dep) | Watch-directory feature, no UI. |
| `lib/autolevel.js` | Kinetiq has its own bed leveling (`src/lib/leveling`). |
| `Sender` send-response mode | Only character counting is used. |
| `access-control.js` | Folded into `session.ts` (loopback / allow-list check). Done in phase 5: `authorizeIPAddress` / `validateUser` ported unchanged. |

**Kept and ported to TypeScript (decided 2026-11-09):**

- The CNCjs macro language: `[expr]` translation and `%var=` assignments (`lib/evaluate-*.js`, `lib/translate-expression.js`, `esprima`) → `streaming/expressions.ts`, same semantics, with `%wait` / `%msg`. Behaviour is unchanged: bracketed text is still evaluated before a line is sent.
- The rc `events` shell runner (`services/taskrunner`, `lib/EventTrigger.js`) → `events/EventTrigger.ts` + `events/TaskRunner.ts`. The security rule (formerly in `src/server/cnc/README.md`, now `BACKEND_INTEGRATION.md` §7.2) carries over unchanged and moves into the new files' headers: commands come only from the rc file, never from socket or HTTP input.
- Logging stays on `winston` (`logger.ts`, typed wrapper with the same format and levels).

## 3a. Bugs found in Phase 0

Found while typing the protocol (`src/server/protocol.ts`). Fixing them changes behaviour, so each fix is its own commit in phase 1 and shows up in the protocol diff.

1. **Fixed in phase 1.** **`config:change` broadcasts the JWT secret.** When the rc file changes on disk, `CNCEngine.js` emits the whole config, including `secret`, to every connected socket (the fake controller rewrites the rc file, so this fires in `dev:fake`). Only already-authenticated loopback clients receive it. Fix: drop the event (the UI does not listen to it) or redact `secret`.
2. **Fixed in phase 1.** **Reopen does not unload a leftover program.** `GrblController.js` calls `this.command('unload')` on open, but the handler is `gcode:unload`; the server logs "Unknown command: unload" and the old program stays loaded. Fix: call `gcode:unload`.
3. **`%wait` typed in the console holds the Sender, not the Feeder** (`GrblController.js`, Feeder `dataFilter`). Ported as-is; revisit in phase 3.
4. **Extended real-time bytes go out UTF-8 encoded.** `write()` takes a JS string, so jog cancel reaches the port as `0xC2 0x85` and every feed/spindle override as `0xC2 0x9X` (visible in `baseline/02-jog.trace` and `05-overrides.trace`). Check how FluidNC handles the `0xC2` prefix before changing it; a TS backend writing raw single bytes shows up as a protocol diff and must be accepted deliberately (re-record the baseline) only after a hardware check of jog cancel and overrides.

5. **Fixed after phase 2 (also applied to `main`).** **The macro-language sandbox could run arbitrary code (inherited from CNCjs).** `streaming/expressions.ts` evaluates `[expr]` / `%var=` from any G-code line (job files, console, `%` lines). Member access is not restricted, so `posx.constructor.constructor("…")()` builds a `Function` and reaches `process` — verified with a harmless `typeof process` payload. `Function` and `Object` are also in `GLOBAL_OBJECTS`. A malicious G-code file could therefore execute code on the server. Phase 2 ported this unchanged. Fix (decided 2026-11-09: harden, keep the language): `constructor`, `prototype` and `__…` properties are refused on reads and assignment paths, function expressions are no longer compiled with `Function()`, and `Function`/`Object` left `GLOBAL_OBJECTS`. 14 known escape expressions resolve to `undefined`; ordinary macros (`[posx - 8]`, `[Math.max(…)]`, ternaries) are unchanged; protocol diff identical. `escodegen` was only used for function expressions and is gone.

6. **The Sender runs `dataFilter` twice on a line that did not fit in the buffer** (open, ported as-is). The filtered text is kept in `sp.line` and filtered again on the next `next()`, so GrblController's filter (expressions, `%` lines, `populateContext`, M0/M1/M6 hold detection) can run twice for one line. Revisit in phase 4 only with a protocol-diff-visible reason.
7. **`await this.connection.port.set(...)` does not wait** (open): serialport v10's `set()` is callback-based and returns void (GrblController). Ported as-is.
8. **Fixed in phase 5.** **`command` looked handlers up on a plain object** (found in phase 4, ported as-is then). `command(cmd)` indexes an object literal, so an inherited name such as `toString`, `valueOf` or `__proto__` finds an `Object.prototype` member instead of logging "Unknown command": `toString` returns harmlessly, `valueOf`/`hasOwnProperty` throw a TypeError and `__proto__` throws "handler is not a function", inside the socket's `command` handler. Only an authenticated socket can send it. Fix (phase 5, with the engine): `GrblController.command()` looks up own properties only (`Object.prototype.hasOwnProperty.call`), so these log "Unknown command" like any other name (checked against the fake controller: `valueOf`, `__proto__`, `toString`, `constructor`, `hasOwnProperty`). No protocol-diff scenario sends such a name, so the diff stays identical. The engine's `open` handler had the same plain-object lookup for `controllerType`; it now uses an own-property lookup too, so `constructor` etc. answer "Not supported controller".

Phase 2–3 also showed where `protocol.ts` is looser than reality (fixed with the controller typing in phases 4–5): `GrblSettings` should be a `type` so `exchange.ts` can accept it; `GrblParserState` fields and modal groups are optional and any group may be an array; `FeederStatus.holdReason` may be absent.

## 4. Verification without tests: protocol diff

The fake controller (`scripts/fake-controller.py -v`) logs every line it receives. Before phase 1, record a baseline with the current JS backend for a fixed set of scenarios, then re-run them after every phase and diff the logs (timestamps stripped):

1. Connect, idle 10 s (status / `$G` polling cadence).
2. Jog X/Y/Z, jog cancel.
3. Load and run a short job with M0 and M6, Hold / Resume, finish.
4. Run a job and Stop mid-way (stop sequence).
5. Feed / spindle overrides during a job.
6. Alarm start (`--alarm`), Unlock, Home.
7. Probe Z (touch) and a probe miss (`--probe-miss`).
8. Settings editor: read config, save (XModem upload, exclusive mode), restart.
9. A 3×3 bed-leveling run and a compensated job.

`scripts/protocol-scenarios/` drives all nine over the socket and the settings HTTP API (`npm run protocol:record`), with the fake's `--trace` recording every line, real-time byte and XModem transfer; `npm run protocol:compare` diffs a run against the committed baseline (`scripts/protocol-scenarios/baseline/`, recorded with the JavaScript backend). Identical serial traffic (apart from the removals in §3) is the acceptance bar for each phase.

## 5. Target structure

```
src/server/
  backend.ts              # entry: config, engine, shutdown (typed; lazy imports so NODE_ENV is set first)
  session.ts              # JWT + host check + handshake IP/user checks (absorbed access-control.js)
  CNCJS_LICENSE           # CNCjs MIT licence (the code below derives from CNCjs 1.11.5)
  protocol.ts             # socket event/command names + payload types, shared with src/lib/cnc
  config/ConfigStore.ts   # rc file (~/.kinetiqrc), typed
  engine/SocketEngine.ts  # was CNCEngine: auth, list/open/close/command/write, port fallback
  serial/SerialConnection.ts  # wraps serialport v10 + ReadlineParser
  grbl/
    constants.ts
    parser/               # GrblLineParser + 14 result parsers → one typed parse() returning a union
    GrblRunner.ts         # state + settings from parsed lines
  streaming/
    Sender.ts             # character counting only
    Feeder.ts             # console/jog lines
    Workflow.ts
    builtins.ts           # %wait, %msg, M0/M1/M6 pause handling
    expressions.ts        # [expr] / %var= macro language (esprima)
  controller/
    GrblController.ts     # thin coordinator: owns the parts below, socket fan-out
    StatusPoller.ts       # ? and $G query timer, exclusive-mode pause
    JobRunner.ts          # gcode:load/start/pause/resume/stop on Sender + Workflow
    filters.ts            # Feeder/Sender dataFilters, populateContext, $13 write filter (phase 4 addition)
    commands.ts           # command name → handler table (typed)
  events/
    EventTrigger.ts       # rc `events` → actions (rc file only, never frontend input)
    TaskRunner.ts         # shell runner for those events
  logger.ts               # winston wrapper
  fluidnc/                # unchanged (already TS)
  jobs.ts                 # unchanged
```

## 6. Phases

| # | Phase | Contents | Risk |
|---|---|---|---|
| 0 | Baseline | `protocol.ts` from `API_REFERENCE.md` + client types; scenario script; record baseline logs. No behaviour change. | none |
| 1 | Remove unused | Everything in §3 (JS still). Drop the deps they used (`watch`). Diff: only removed traffic differs. | low |
| 2 | Leaf modules | `constants`, units, line parsers, `ImmutableStore`/store, `ConfigStore`, logger, delay, expression evaluator, EventTrigger/TaskRunner → TS. Pure or isolated code, easy to check by reading. | low |
| 3 | Serial + streaming | `SerialPort`, `Sender`, `Feeder`, `Workflow`, `MessageSlot`, `GrblState` → TS. The buffer accounting (120-byte window, `ok`/`error` release) is ported line by line. | **high** |
| 4 | Split the controller | `GrblController` → coordinator + `StatusPoller` + `JobRunner` + `commands`. Done in 2–3 commits, protocol diff after each. | **high** |
| 5 | Engine + entry | `CNCEngine` → `SocketEngine`, auth into `session.ts`, typed `backend.ts`; `src/lib/cnc` imports `protocol.ts`; remove `allowJs`. | medium |
| 6 | Hardware + docs | Short session on the machine (connect, jog, a real job with hold/resume/stop, probe, settings save); final pass over `ARCHITECTURE.md`, `BACKEND_INTEGRATION.md` (structure and provenance were updated in phase 5); merge to `main`. | — |
| later | socket.io 4 | Server + client together, own branch. | medium |

## 7. Decisions (2026-11-09)

1. rc `events` shell runner: **kept**, ported to TypeScript with the same security rule.
2. `[expr]` / `%var=` macro language: **kept**, ported to TypeScript (`esprima` stays).
3. Logger: **winston stays**.
4. Merge cadence: the whole branch goes to `main` **after phase 6** (hardware check); `main` keeps the proven JS backend until then.
