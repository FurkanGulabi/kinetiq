# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

Kinetiq is a control UI for GRBL-compatible CNC machines (first target: FluidNC on ESP32). It is one Next.js 16 / React 19 app plus a built-in CNC backend (the CNCjs GRBL server, rewritten in TypeScript under `src/server/`), both running in one Node process. Kinetiq's Hold and Reset are software commands and do not replace a hard-wired e-stop. Treat any change that affects what reaches the serial port as safety-relevant.

## Commands

```bash
npm install
npm run dev            # tsx watch server.ts → http://127.0.0.1:8000 (Next dev + backend)
npm run build && npm start
npm run typecheck      # app (tsconfig.json) and server (tsconfig.server.json); the only static check
```

There is **no test suite and no linter, by project policy**. Don't add testing tools. Verification works like this:

- **Fake controller** (no machine needed, macOS/Linux, Python 3): run `npm run fake-controller` in one terminal and `npm run dev:fake` in another, then pick port `kinetiq-fake0` in the UI. `dev:fake` points `KINETIQ_RC` at a temp rc file so `~/.kinetiqrc` is left alone. See `docs/FAKE_CONTROLLER.md`.
- **Protocol scenarios**: this is the regression check for backend changes. It records exactly what the backend writes to the (fake) serial port and diffs it against a committed baseline:
  ```bash
  npm run protocol:record -- --out /tmp/proto-new                 # all scenarios (~2 min)
  npm run protocol:record -- --out /tmp/proto-new 02-jog 10-travel-limits   # just some
  npm run protocol:compare -- scripts/protocol-scenarios/baseline /tmp/proto-new
  ```
  If a difference is intended, re-record into `scripts/protocol-scenarios/baseline` and commit it together with the change. `record.mts` mirrors some UI sequencing code (`client.ts`, `lineSequence.ts`, `probe.ts`, `leveling/run.ts`) because that code can't run in Node. When you change one of those functions, update its mirror too. Details are in `scripts/protocol-scenarios/README.md`.
- `node scripts/build-fluidnc-schema.mjs` regenerates `src/lib/fluidnc/schema.json` for the settings editor.

Environment variables: `KINETIQ_PORT`/`KINETIQ_HOST`, `KINETIQ_RC` (default `~/.kinetiqrc`), `KINETIQ_JOBS_DIR`, `KINETIQ_CONFIG_BACKUP_DIR`, `KINETIQ_LOG_LEVEL`, `KINETIQ_TRAVEL_LIMITS=off|on`, and `KINETIQ_HEADLESS=1`, which runs the backend and HTTP APIs without Next (the protocol recorder uses it).

## Architecture

**One process.** `server.ts` creates the `http.Server`. It routes `/api/kinetiq/{session,jobs,machine-config}` to handlers in `src/server/`, attaches the Socket.IO **2.2** `SocketEngine` (which answers `/socket.io/*`), and sends everything else to Next. The client must stay on `socket.io-client@2.x` because the protocol is locked to that version. Only the `Grbl` controller is registered.

**Import boundary (safety-relevant):** nothing in `src/app`, `src/components` or `src/lib` may import `src/server/**`. This keeps serialport and the engine out of Next bundles and HMR, so there can never be two engines or two handles on the port. The `dev` script excludes the UI directories from tsx watch for the same reason. Code that both sides need goes in a pure, dependency-free module under `src/lib`; `src/lib/machine/travel.ts` is used by `TravelGuard` and `derive.ts`, for example. `src/server/protocol.ts` and `src/lib/cnc/protocol.ts` define the socket event and payload types on each side and must stay in sync.

**Backend (`src/server/`)**: `engine/SocketEngine.ts` (handshake, list/open/close/command/write) → `controller/GrblController.ts` (coordinator; fans out state to sockets) with `StatusPoller`, `JobRunner`, `TravelGuard` and `commands.ts`. Below that are `streaming/` (Sender, Feeder, Workflow, `[expr]`/`%var=` expressions, a macro sandbox using esprima), `grbl/` (line parsers, `GrblRunner` state), `serial/SerialConnection.ts`, `config/` (rc-file store) and `fluidnc/` (config read/write over XModem for the settings editor). Code added on top of CNCjs is marked with `// Kinetiq:` comments. Auth: `session.ts` mints a JWT, and the socket handshake validates it.

**Frontend data flow**: `server event → lib/cnc/client.ts → lib/cnc/store.ts (reduce) → lib/cnc/derive.ts → widgets`. The reverse path is `widget action → derive guard → client.emit → backend → server event`.
- `client.ts` owns the **only** socket and never decides policy.
- `store.ts` is one immutable `MachineState`, read with `useSyncExternalStore` and `useMachine(selector)`. The three.js view uses `subscribe()` and never re-renders React. Console traffic lives in a separate ring-buffer store (`console-store.ts`).
- **All gating rules live in `derive.ts`** as pure view functions (`jogView`, `jobView`, `programFitView`, …). Disabled controls state their reason.
- **No optimistic machine state.** The UI renders only what the backend broadcasts, and a jog changes nothing locally. On (re)connect the client emits `list`, then `open` on an in-use port, which attaches to it and replays the full state.
- Only preferences persist in the browser (`kinetiq.*` localStorage keys). Machine state is never persisted.

**Travel limits** (`docs/TRAVEL_LIMITS.md`): the app is tuned for one DIY router that homes to the bottom-right corner (X runs negative, Y positive). The backend's `TravelGuard` tracks which axes are homed and shortens or refuses every `$J=` jog, including jogs typed in the console. The UI's `programFitView` blocks Start until the program fits. Measured travel is stored in the rc file as `kinetiq.travel`.

**UI**: the 3D view (plain three.js, `components/visualisation/`) is the page background. The other widgets are draggable glass `FloatingWidget`s (`lib/ui/layout.ts`, `lib/ui/spring.ts`). The stack is Tailwind v4 with tokens in `src/app/globals.css`, Radix only for Select and Dialog, and `lucide-react` icons. The rules from `docs/ARCHITECTURE.md` §9 are: one accent colour, every status pairs an icon with a label, axes are identified by letters rather than colours, and nothing animates on high-frequency actions (jog, readouts, console). The UI text is English only.

## Conventions

- Commits use Conventional Commits with a scope, e.g. `feat(jog): …` or `fix(limits): …`, with a body explaining why.
- The docs in `docs/` are kept current alongside the code (`ARCHITECTURE.md`, `API_REFERENCE.md`, `TRAVEL_LIMITS.md`, etc.). Update the relevant doc when behaviour changes. Hardware session logs go in `docs/hardware/`.
