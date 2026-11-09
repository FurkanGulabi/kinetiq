# Backend rewrite plan: CNCjs JavaScript → modular TypeScript

Status: **proposal**, branch `refactor/typescript-backend` (cut from `main` at `ce7ef91`). Nothing is rewritten yet.

## 1. Why

`src/server/cnc` is the CNCjs 1.11.5 GRBL server, copied in as JavaScript (45 files, ~6,400 lines). It works and has run on the real machine, but:

- `controllers/Grbl/GrblController.js` is 1,852 lines in one class: serial lifecycle, Feeder, Sender, status polling, workflow, 32 command handlers, socket fan-out. The graph (`graphify-out/`, 480 nodes, 19 communities) puts it as the top god node, and its community ("Controller Core and Streaming", 73 nodes) has the lowest cohesion (0.06).
- The browser types (`src/lib/cnc`) guess the backend's payloads; nothing shares a type with the server.
- It carries generic-CNCjs features Kinetiq never uses (see §3), plus old dependencies (`esprima`, `lodash`, `ensure-type`, `chalk`, `shortid`, `watch`, `socketio-jwt`, socket.io 2.2).

## 2. Ground rules

1. **The socket protocol does not change** during the rewrite: same event names, same payload shapes, same command names (`docs/API_REFERENCE.md`). The UI is not touched until the last step. socket.io 2 → 4 is a separate, later change.
2. **Machine behaviour does not change.** The rewrite is structural. Anything that changes what reaches the serial port (§3 deletions included) is called out per phase.
3. **Every phase leaves the app working** and is one commit (or a short series) on this branch. `main` only receives the branch after the hardware check (phase 6), so `main` stays a safe fallback; individual phases can also be merged early if they are verified.
4. **No automated tests** (project rule). Verification is the fake-controller protocol diff (§4) plus `npm run typecheck`, and a hardware session at the end.

## 3. What is removed (not ported)

Checked against the client (`src/lib/cnc/client.ts`, components) and the server TS code: none of these are called.

| Remove | Why |
|---|---|
| Commands `macro:run`, `macro:load`, `watchdir:load`, `autolevel:*` (4), `sleep`, `rapidOverride`, `feeder:feed/start/stop`, `statusreport`, and the aliases `start`/`stop`/`pause`/`resume` if unused | Never sent by the UI. |
| Events `Grbl:settings`, `Grbl:state`, `autolevel:*`, `watchdir:change` | The UI listens to `controller:*` only. |
| `services/monitor` (FSMonitor, `watch` dep) | Watch-directory feature, no UI. |
| `lib/autolevel.js` | Kinetiq has its own bed leveling (`src/lib/leveling`). |
| `lib/evaluate-*.js`, `lib/translate-expression.js` (`esprima`) | CNCjs's `[expr]` / `%var=` macro language. **Behaviour change:** bracketed text in G-code would reach FluidNC verbatim instead of being evaluated by the server — which is what FluidNC's own `[...]` expressions need. `%wait` and `%msg` stay (the backend appends `%wait`; the UI shows `%msg`). |
| `Sender` send-response mode | Only character counting is used. |
| `services/taskrunner` + `lib/EventTrigger.js` (rc `events` → shell) | **Decision needed.** Unused by Kinetiq, and the only shell-execution path in the server (see `src/server/cnc/README.md`). Recommended: remove; a future Automation feature uses a server-side allow-list instead. |
| `access-control.js` | Folded into `session.ts` (loopback / allow-list check). |

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
  controller/
    GrblController.ts     # thin coordinator: owns the parts below, socket fan-out
    StatusPoller.ts       # ? and $G query timer, exclusive-mode pause
    JobRunner.ts          # gcode:load/start/pause/resume/stop on Sender + Workflow
    commands.ts           # command name → handler table (typed)
  fluidnc/                # unchanged (already TS)
  jobs.ts                 # unchanged
```

## 6. Phases

| # | Phase | Contents | Risk |
|---|---|---|---|
| 0 | Baseline | `protocol.ts` from `API_REFERENCE.md` + client types; scenario script; record baseline logs. No behaviour change. | none |
| 1 | Remove unused | Everything in §3 (JS still). Drop deps. Diff: only removed traffic differs. | low |
| 2 | Leaf modules | `constants`, units, line parsers, `ImmutableStore`/store, `ConfigStore`, logger, delay → TS. Pure code, easy to check by reading. | low |
| 3 | Serial + streaming | `SerialPort`, `Sender`, `Feeder`, `Workflow`, `MessageSlot`, `GrblState` → TS. The buffer accounting (120-byte window, `ok`/`error` release) is ported line by line. | **high** |
| 4 | Split the controller | `GrblController` → coordinator + `StatusPoller` + `JobRunner` + `commands`. Done in 2–3 commits, protocol diff after each. | **high** |
| 5 | Engine + entry | `CNCEngine` → `SocketEngine`, auth into `session.ts`, typed `backend.ts`; `src/lib/cnc` imports `protocol.ts`; remove `allowJs`. | medium |
| 6 | Hardware + docs | Short session on the machine (connect, jog, a real job with hold/resume/stop, probe, settings save); update `ARCHITECTURE.md`, `BACKEND_INTEGRATION.md`, `src/server/cnc/README.md`; merge to `main`. | — |
| later | socket.io 4 | Server + client together, own branch. | medium |

## 7. Open decisions

1. Remove the rc `events` shell runner (taskrunner/EventTrigger)? Recommended: yes.
2. Remove `[expr]` / `%var=` evaluation? Recommended: yes (FluidNC handles its own expressions).
3. Logger: keep `winston`, or a ~40-line console logger with levels? Recommended: small logger.
4. Merge cadence: whole branch after phase 6 (recommended), or each phase to `main` once its diff passes.
