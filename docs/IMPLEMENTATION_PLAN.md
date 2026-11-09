# Implementation Plan

**Project:** Kinetiq: Advanced Motion Control
**Goal:** The smallest reliable CNC control application: connect to FluidNC, see the machine, jog it, talk to it, and run and monitor a job. It is built on the unmodified CNCjs backend inside one Next.js application.

**Policy:** No tests, test files, test tooling or test tasks (project rule). Acceptance criteria are **observable outcomes** of the running application.

**Machine safety during development:** the first hardware sessions (M1–M3) run with the **TB6600 drivers unpowered** or the motors disconnected, and the spindle off. Motion is enabled first in M4, with the work area clear and the physical emergency stop within reach.

---

## M0: Approval gate

| | |
|---|---|
| **Objective** | Confirm the decisions this plan depends on |
| **Tasks** | Review and approve or reject **D1** (Next.js custom server), **D2** (CNCjs consumed as a fork build, `file:../CNCJS-fork/dist/cncjs`), **D3** (`socket.io-client@2.x`), **D4** (Load/Start/Pause/Resume/Stop in the Job widget plus Hold/Reset in the top bar). See `BACKEND_INTEGRATION.md` §9. |
| **Dependencies** | — |
| **Expected output** | Recorded decisions. If D1 is rejected, the plan pauses for an alternative design. |
| **Acceptance criteria** | All four decisions answered |
| **Outcome** | ✅ D1–D4 approved on 2026-11-08 |

---

## M1: Architecture foundation and reliable machine connection *(first milestone)*

| | |
|---|---|
| **Objective** | One Next.js process that hosts CNCEngine, opens the FluidNC serial port, and shows live connection state in the Connection widget |
| **Dependencies** | M0 |

**Tasks**
1. Build the CNCjs server once: `yarn install` in `CNCJS-fork/`, then run only the server part of the build. That is `babel -d dist/cncjs/server src/server`, copying `src/package.json` to `dist/cncjs/`, and copying `src/server/{i18n,views}`. This writes the git-ignored `dist/` only; **no source changes**.
2. Scaffold `new-cnc-app` with Next.js (App Router, TS), Tailwind v4 and `name: "kinetiq"`. Add dependencies: `cncjs-app` (file:), `socket.io-client@2`, `jsonwebtoken`, `@radix-ui/react-select`, `@radix-ui/react-dialog`, `lucide-react`. Dev dependencies: `typescript`, `tsx`, `@types/*`.
3. `server.ts` + `src/server/cncjs.ts`, following the boot order in `BACKEND_INTEGRATION.md` §5.1: rc file `~/.kinetiqrc`, secret, `new CNCEngine().start(server, 'Grbl')`, listen on `127.0.0.1:8000`, and fail fast if the build is missing.
4. `src/server/session.ts`: `GET /api/kinetiq/session` with a Host-header check.
5. `lib/cnc/protocol.ts` (typed events from `API_REFERENCE.md`), `client.ts`, `store.ts`, and `derive.connectionStatus`.
6. Design tokens in `globals.css`, plus the `Button`, `Select` and `StatusBadge` primitives.
7. `ConnectionBar` (Widget 1): port list and refresh, baud, Connect/Disconnect, the four states, the waiting-for-controller sub-status, FluidNC identification, inline errors.
8. Attach-on-reconnect (list → `open` for a port marked in use).
9. Observe and record the M1 runtime checks: U1 (HMR alongside Engine.IO), U2 (open-error payload), the non-numeric `baudrate` behaviour, F1 (banner text), F3 (ESP32 reset on open; decide on `pin`), F4 (`$13` present in `$$`), F6 (status fields, `Bf`), F15 (baud). Write the findings into `BACKEND_INTEGRATION.md` §6 and §8.

**Expected output:** `npm run dev` starts one process. The browser shows the Kinetiq top bar with a working Connection widget.

**Progress (2026-11-08):** tasks 1–8 are implemented. Observed so far: one process serves the page, the session and `/socket.io`; the authenticated socket receives the port list; HMR coexists with Socket.IO (U1); the open-error payload is empty (U2); a bad baud value raises an uncaught exception (U8); the production build starts and shuts down cleanly. **Hardware session (2026-11-08, FluidNC v4.0.1):** see `docs/hardware/2026-11-08-m1-fluidnc.md`. Connect, Disconnect (port released), re-attach after reload, Connected / ALARM state and FluidNC identification were observed. No reset on open; no banner; `$13=0`. **Still open:** unplug-while-connected ("Connection lost"), busy/missing-port error with a real device, and decision U9 (auto `$I`).

**Acceptance criteria**
- One `node` process serves the page and `/socket.io`. No second server or process exists.
- The port list shows the ESP32 serial device. Connecting shows **Connecting…**, then **Connected · Waiting for controller**, then **Connected · FluidNC vX.Y.Z** within about 5 s of the board finishing its boot.
- Disconnecting returns to **Disconnected** and releases the port (another program can then open it).
- Unplugging the USB cable while connected shows **Connection error: connection lost**. Plugging it back in and connecting again works without restarting Kinetiq.
- Reloading the page or opening a second tab shows **Connected** immediately, without reopening the port (the board does not reboot).
- Opening a port that is busy or missing shows an inline error, and the app stays usable.
- Changing a React component in dev does not close the serial port.

---

## M2: Workspace layout and design system

| | |
|---|---|
| **Objective** | The final single-page layout with all four widget panels and the shared primitives |
| **Dependencies** | M1 |

**Tasks:** the `Workspace` grid (`ARCHITECTURE.md` §10.1); primitives `Panel`, `SegmentedControl`, `Readout`, `Meter`, `ConfirmDialog`; the backend-offline strip; header machine-state badge; error boundary per widget; focus and reduced-motion and contrast media rules; wordmark and favicon.

**Expected output:** the full layout with empty or disconnected states in every panel.

**Acceptance criteria**
- The layout matches §10.1 at 1440×900 and stays usable at 1280×720 without page scrolling.
- Every interactive element is reachable with Tab and shows the accent focus ring.
- Stopping the Kinetiq process shows the backend-offline strip, disables all controls, and recovers on its own when the process restarts.
- Every status display shows an icon and a text label.

---

## M3: Console

> **Changed 2026-11-08:** at the user's request the Console panel was replaced by a live 3D Visualisation (see `ARCHITECTURE.md` §10.3). The console tasks below are deferred.
>
> **Done 2026-11-09:** implemented as a floating widget (`ARCHITECTURE.md` §10.8). All acceptance criteria below were checked in a browser against the fake controller (`docs/FAKE_CONTROLLER.md`), including the second tab; not yet against hardware.

| | |
|---|---|
| **Objective** | A real-time console on the verified `serialport:read` / `serialport:write` / `writeln` interfaces |
| **Dependencies** | M2 |

**Tasks:** `console-store` (ring buffer, per-frame batching); line classification (`API_REFERENCE.md` §6.1); echo with `__sender__` de-duplication; auto-scroll with "Jump to latest"; Clear view; input with the workflow-idle guard; pinned alarm row.

**Expected output:** a working Console widget.

**Acceptance criteria**
- Sending `$$` shows each setting with its CNCjs description, and `ok` is de-emphasised.
- `$I` shows the `[VER:…]` and `[OPT:…]` lines. `?` shows a status line.
- An invalid command (`G999`) shows a red **error** row with its decoded message.
- `[MSG:…]` lines are visually distinct, and `[MSG:WARN`/`[MSG:ERR` carry their glyphs.
- Scrolling up stops auto-scroll. "Jump to latest" restores it.
- A command typed in a second tab appears in the first tab's console.
- Input is disabled, with its reason shown, while a job is running or paused.

---

## M4: Coordinates and Jog

| | |
|---|---|
| **Objective** | Accurate position feedback and safe manual jogging |
| **Dependencies** | M3. **First milestone with motors powered.** |

**Tasks:** `PositionPanel` readout (work and machine, WCS, `$13` units); `JogPad` (XY cross, Z column, centre Stop-jog); `JogSettings` (step, feed, custom feed validation); `commands.jogLine()` producing `$J=G91 G21|G20 <axis><±step> F<feed>`; `derive.canJog` with stated reasons; persistence of step and feed in `localStorage`; record the F9 and F10 hardware observations.

**Expected output:** a working Coordinates and Jog widget.

**Progress (2026-11-08):** implemented in `src/components/position/PositionPanel.tsx` (gating in `derive.jogView`, line builder in `commands.jogLine`), together with the M2 workspace grid and the `Panel`, `SegmentedControl` and `Readout` primitives; Job and Console are empty panels for now. **Observed on the controller (FluidNC v4.0.1), without motion:** readouts match the status reports (work Z −22.603 = MPos 0 − WCO 22.603), units `mm` from `$13=0`, WCS `G54`; jog buttons disable with a stated reason in Alarm and in `Hold:0`; the custom feed rejects out-of-range values. **Not yet exercised:** an actual jog move and Stop-jog (`0x85`) on FluidNC — this needs the operator, the work area clear and the E-stop within reach.

**Acceptance criteria**
- Readouts match the `?` status line in the console. Work and machine values differ by exactly the active offset.
- Each jog press moves the chosen axis by the selected step at the selected feed, in the right direction (marked on the machine), and the readout follows.
- Stop jog (■) halts a long jog (100 mm at a slow feed) mid-move.
- In Alarm state, all jog buttons are disabled and the hint names `$X`/`$H`. After `$X` in the console they enable again.
- A jog beyond the soft limits (if enabled in FluidNC) produces an `error:` row and no motion.
- Jog buttons are disabled while a job runs.

---

## M5: Job Status (and job controls, if D4 is approved)

| | |
|---|---|
| **Objective** | Run a G-code program and monitor it with truthful timing |
| **Dependencies** | M4 |

**Tasks:** Load (single file picker → `gcode:load`); `derive.jobStatus` (six states, `API_REFERENCE.md` §7.2); meter and stat row with the client-side elapsed clock and the "≈" remaining estimate; Start, Pause, Resume; Stop with confirmation and the safe sequence (pause → `Hold:0` → `gcode:stop {force:true}`); hold-reason display (M0/M1/M6/`%wait`); top-bar Hold and Reset (`ARCHITECTURE.md` §10.6).

**Expected output:** a working Job widget and safety controls.

**Progress (2026-11-08):** implemented, plus two user-requested additions: an **upload menu** (drop zone / file picker) and **recent jobs** backed by a server-side job library (`API_REFERENCE.md` §7.4). **Observed on FluidNC v4.0.1 with no-motion programs** (only `G4` dwells, `M0` and a bad `G999` line): Start → Running; `M0` → **Paused · M0 program pause**; Resume → Completed with an exact finish time and 100 %; Run again → Stop (confirm) → Stopping… → **Cancelled**, controller went `Hold:0` → soft reset → **Idle (not Alarm)**; `G999` → `error:20 (Unsupported command) at line 2` → **Error**, then "Finished with errors" (this needed a client-side workaround for a CNCjs hold-reason quirk, §7.2); Completed rebuilt correctly after a page reload; run outcomes written to recent jobs. **Not yet exercised:** an air-cut program with motion (Pause/Stop while moving, where Stop must wait for `Hold:0`).

**Acceptance criteria**
- With a short air-cut program (spindle off, Z raised), Start shows **Running**. The percentage rises with `received/total`, and elapsed counts every second.
- Remaining appears after about 1 s marked "≈". Finished shows "—" until completion.
- Pause shows **Paused** and the machine decelerates and holds. Resume continues from the same point.
- An `M0` in the program shows **Paused · M0 program pause**. Resume continues.
- Stop asks for confirmation, then the machine holds and stops, the badge shows **Cancelled**, and the machine is not left in Alarm.
- On completion the badge shows **Completed** with an exact finish time, and elapsed equals finish minus start.
- After a page reload, Completed and Cancelled are shown correctly from server state.
- An injected bad line (`G999` in the program) pauses the job and shows **Error** with the decoded message.
- Hold and Reset in the top bar work at any time while connected. Reset during motion produces the expected GRBL alarm, and the UI shows it.

---

## M5b: Toolpath in the Visualisation

Draw the loaded program (`store.program.gcode`) in the 3D view: rapids and feeds in distinct styles, the executed portion highlighted from `sender.received`, bounds shown and used by Fit.

**Progress (2026-11-08):** implemented (`ARCHITECTURE.md` §10.3). Checked against every file in `CNCJS-fork/examples/gcode`: line numbering equals the Sender's `total` for all of them; arcs in XY/XZ/YZ, full circles without XYZ, R-form helices in inches (`helical-thread-milling`), 2D laser jobs, and the 188k-line `github.gcode` (279 × 279 × 8.2 mm) render correctly. **Not yet observed:** the done/remaining split during a real run (needs a motion job).

---

## M6: Reliability hardening and production run

| | |
|---|---|
| **Objective** | Predictable behaviour across restarts, failures and long sessions |
| **Dependencies** | M5 |

**Tasks:** SIGINT/SIGTERM handler (`BACKEND_INTEGRATION.md` §5.3); production build and start scripts; token refresh on handshake failure; a review pass that every control's guard matches `CNCJS_ANALYSIS.md` §6.1 and §7 (hazards H1–H6); a long idle session (memory steady, console capped); a README covering the CNCjs build step, starting Kinetiq, and the safety notice (software stop ≠ emergency stop).

**Expected output:** `npm run build && npm start` runs Kinetiq in production mode.

**Acceptance criteria**
- Ctrl-C on the server closes the serial port cleanly (the board is free for another program). If a job was running, a warning is logged.
- The production start serves the same functionality as dev, from one process.
- After 8 hours connected and idle, the page remains responsive and memory stays within a stable range.
- No control in the UI can send a non-real-time line while `workflow !== 'idle'`.

---

## Summary

| Milestone | Delivers | Hardware power |
|---|---|---|
| M0 | Decisions | — |
| **M1** | **Single-process app + Connection widget** | Board only, drivers off |
| M2 | Layout + design system | Board only |
| M3 | Console | Board only |
| M4 | Coordinates & Jog | Motors on |
| M5 | Job Status + controls | Motors on (air cuts) |
| M6 | Hardening + production run | Full |
