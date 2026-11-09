# Kinetiq CNC backend (`src/server/cnc`)

This is the CNCjs GRBL server code, carried into Kinetiq so Kinetiq no longer depends on `../CNCJS-fork`.

- **Source:** `CNCJS-fork/src/server` at commit `a3922a1bf` (CNCjs 1.11.5). The CNCjs MIT licence is in [`LICENSE`](LICENSE).
- **Still JavaScript here (phase 5 of `docs/BACKEND_REWRITE_PLAN.md`):** `services/cncengine/CNCEngine.js` and `access-control.js`. Every Kinetiq change, here and in the TypeScript files ported from here, is marked with a `// Kinetiq:` or `// SECURITY (Kinetiq):` comment.
- **Ported to TypeScript in phase 2 (2026-11-09), behaviour unchanged:** GRBL constants and line parsers → `src/server/grbl/`; macro language (`[expr]`, `%var=`) and `%msg`/`%wait`/M0/M6 helpers → `src/server/streaming/{expressions,builtins}.ts`; `MessageSlot` → `streaming/`; logger → `src/server/logger.ts`; settings and config store → `src/server/config/`; store → `src/server/store.ts`; EventTrigger and TaskRunner → `src/server/events/`; delay, jsonStringify, decimalPlaces → `src/server/util/`; shared constants → `src/server/constants.ts`.
- **Ported to TypeScript in phase 3 (2026-11-09), behaviour unchanged:** `lib/{Sender,Feeder,Workflow}.js` → `src/server/streaming/`, `lib/SerialConnection.js` → `src/server/serial/SerialConnection.ts`, `controllers/Grbl/GrblRunner.js` → `src/server/grbl/GrblRunner.ts`.
- **Ported to TypeScript in phase 4 (2026-11-10), behaviour unchanged (protocol diff identical):** `controllers/Grbl/GrblController.js` → `src/server/controller/`, split by responsibility:
  - `GrblController.ts`: the coordinator. Owns the connection, runner, Feeder, Sender, Workflow and the parts below, registers their listeners in the original order, socket fan-out (`addConnection`/`removeConnection`/`emit`, and `broadcastChanges()` for the 250 ms tick), `open`/`close`/`destroy`, `write`/`writeln`, `setExclusive`. Carries the `// Kinetiq:` exclusive flag, the Feeder-drop in exclusive mode and the `gcode:unload` on reopen.
  - `StatusPoller.ts`: the query timer: `?` / `$G` queries, action masks, the end-of-program check, the exclusive-mode polling pause (`// Kinetiq:`), the CNCjs issue rules (#115, #133, #176, #186, #889).
  - `JobRunner.ts`: `gcode:load/unload/start/stop/pause/resume` (incl. the force-stop sequence), Sender `data`, Workflow transitions, program acknowledgements and pause-on-error.
  - `filters.ts`: the SerialConnection `$13` write filter, `populateContext`, and the Feeder/Sender dataFilters (`%msg`, `%wait`, `%var=`, `[expr]`, M0/M1, the `// Kinetiq:` M6 manual tool-change pause).
  - `commands.ts`: the command table, typed by `ControllerCommands` (`src/server/protocol.ts`).
- **Changed:**
  - `services/cncengine/CNCEngine.js`: only the Grbl controller is registered. Marlin, Smoothie and TinyG/g2core imports and branches were removed. Added later (2026-11-09): if serial port detection fails, the `list` handler still answers with the ports from the rc file (`ports`) instead of an error, so the fake controller and manually listed ports stay selectable.
  - `config/settings.js`: replaces `settings.{base,development,production}.js` with the fields the backend reads (`secret`, `rcfile`, `accessTokenLifetime`, `allowRemoteAccess`, `verbosity`, `winston.level`). It no longer imports `package.json`.
- **Removed later (2026-11-08):** the `tool:change` routine with its `tool.*` config and `TOOL_CHANGE_POLICY_*` constants, and `lasertest:on`/`lasertest:off`. M6 is now always a manual tool-change pause: the M6 word is sent as a comment `(M6)` and the job pauses until Resume (CNCjs's default policy, no longer configurable). Touched files: `controllers/Grbl/GrblController.js` (now `src/server/controller/filters.ts`), `controllers/constants.js`.
- **Added later (2026-11-08):** `GrblController.setExclusive(on)` and the `exclusive` flag (now in `src/server/controller/GrblController.ts` and `StatusPoller.ts`), used by the settings editor's XModem upload. While on, the query timer sends no `?`/`$G` and Feeder lines are dropped (the Feeder is reset); real-time bytes written through `write()` (Hold, Reset) still go out. Turning it off clears the query masks.
- **Security notes:** `src/server/events/EventTrigger.ts` and `src/server/events/TaskRunner.ts` carry the shell-command security notes (see below).
- **Removed in rewrite phase 1 (2026-11-09, `docs/BACKEND_REWRITE_PLAN.md`):** the commands `macro:run/load`, `watchdir:load`, `autolevel:*` (6), `sleep`, `rapidOverride`, `feeder:feed/start/stop`, `statusreport` and the `start`/`stop`/`pause`/`resume` aliases; the events `Grbl:state`, `Grbl:settings`, `autolevel:update/complete`, `watchdir:change`; `services/monitor` (watch directory) and `lib/autolevel.js`; the Sender's send-response mode. None was used by the UI; the protocol diff showed identical serial traffic.
- **Fixed in phase 1:** `CNCEngine.js` no longer emits `config:change` (it broadcast the whole rc config, including the JWT `secret`, to every socket); `GrblController.open()` now calls `gcode:unload` instead of the nonexistent `unload` (kept in `src/server/controller/GrblController.ts`).
- **Not carried over:** the Express app, REST API, i18n, views, the Marlin/Smoothie/TinyG controllers and the CNCjs CLI.

## Security rule: shell commands

`src/server/events/TaskRunner.ts` runs shell commands. Today its only input is the `events` list in the rc file (`~/.kinetiqrc`), read by `src/server/events/EventTrigger.ts`. No socket or HTTP handler reaches it, and the only config value Kinetiq writes is `secret`.

Keep it that way:
- Never pass socket, HTTP or other frontend input to `taskRunner.run()`.
- Never add an API that writes `events`, or anything else that is later handed to `run()`, into the config.
- The planned Automation UI must offer a fixed allow-list of server-defined actions (for example "switch relay N on"), validated on the server, not free-form commands.

The two remaining files stay JavaScript (`allowJs` in `tsconfig.server.json`) until phase 5. The TypeScript ports are line-for-line what ran under CNCjs, checked with the protocol diff (`scripts/protocol-scenarios/`). `src/server/backend.ts` is the typed entry point that loads the rc file and secret and constructs `CNCEngine`.

The browser talks to this backend with the CNCjs Socket.IO 2 protocol, documented in `docs/API_REFERENCE.md`.
