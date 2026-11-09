# Backend rewrite plan: CNCjs JavaScript → modular TypeScript

Status: **proposal**, branch `refactor/typescript-backend` (cut from `main` at `ce7ef91`). Nothing is rewritten yet.

## 1. Why

`src/server/cnc` is the CNCjs 1.11.5 GRBL server, copied in as JavaScript (45 files, ~6,400 lines). It works and has run on the real machine, but:

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
| `access-control.js` | Folded into `session.ts` (loopback / allow-list check). |

**Kept and ported to TypeScript (decided 2026-11-09):**

- The CNCjs macro language: `[expr]` translation and `%var=` assignments (`lib/evaluate-*.js`, `lib/translate-expression.js`, `esprima`) → `streaming/expressions.ts`, same semantics, with `%wait` / `%msg`. Behaviour is unchanged: bracketed text is still evaluated before a line is sent.
- The rc `events` shell runner (`services/taskrunner`, `lib/EventTrigger.js`) → `events/EventTrigger.ts` + `events/TaskRunner.ts`. The security rule in `src/server/cnc/README.md` carries over unchanged and moves into the new files' headers: commands come only from the rc file, never from socket or HTTP input.
- Logging stays on `winston` (`logger.ts`, typed wrapper with the same format and levels).

## 3a. Bugs found in Phase 0 (JS behaviour, not yet fixed)

Found while typing the protocol (`src/server/protocol.ts`). Fixing them changes behaviour, so each fix is its own commit in phase 1 and shows up in the protocol diff.

1. **`config:change` broadcasts the JWT secret.** When the rc file changes on disk, `CNCEngine.js` emits the whole config, including `secret`, to every connected socket (the fake controller rewrites the rc file, so this fires in `dev:fake`). Only already-authenticated loopback clients receive it. Fix: drop the event (the UI does not listen to it) or redact `secret`.
2. **Reopen does not unload a leftover program.** `GrblController.js` calls `this.command('unload')` on open, but the handler is `gcode:unload`; the server logs "Unknown command: unload" and the old program stays loaded. Fix: call `gcode:unload`.
3. **`%wait` typed in the console holds the Sender, not the Feeder** (`GrblController.js`, Feeder `dataFilter`). Ported as-is; revisit in phase 3.

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

A short script drives scenarios 1–7 over the socket so the runs are repeatable; 8–9 run from the UI. Identical serial traffic (apart from the removals in §3) is the acceptance bar for each phase.

## 5. Target structure

```
src/server/
  backend.ts              # entry: config, engine, shutdown (exists, simplified)
  session.ts              # JWT + host check (absorbs access-control.js)
  protocol.ts             # socket event/command names + payload types, shared with src/lib/cnc
  config/ConfigStore.ts   # rc file (~/.kinetiqrc), typed
  engine/SocketEngine.ts  # was CNCEngine: auth, list/open/close/command/write, port fallback
  serial/SerialPort.ts    # was SerialConnection
  grbl/
    constants.ts
    parser/               # GrblLineParser + 14 result parsers → one typed parse() returning a union
    GrblState.ts          # was GrblRunner (state + settings from parsed lines)
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
| 6 | Hardware + docs | Short session on the machine (connect, jog, a real job with hold/resume/stop, probe, settings save); update `ARCHITECTURE.md`, `BACKEND_INTEGRATION.md`, `src/server/cnc/README.md`; merge to `main`. | — |
| later | socket.io 4 | Server + client together, own branch. | medium |

## 7. Decisions (2026-11-09)

1. rc `events` shell runner: **kept**, ported to TypeScript with the same security rule.
2. `[expr]` / `%var=` macro language: **kept**, ported to TypeScript (`esprima` stays).
3. Logger: **winston stays**.
4. Merge cadence: the whole branch goes to `main` **after phase 6** (hardware check); `main` keeps the proven JS backend until then.
