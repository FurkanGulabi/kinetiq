# Kinetiq Architecture

**Kinetiq: Advanced Motion Control.** A modern, minimal and reliable control interface for GRBL-compatible CNC machines. The initial target is FluidNC on an ESP32-WROOM-32U driving NEMA 23 steppers through TB6600 drivers.

**Status:** Decisions D1–D4 approved 2026-11-08 (`BACKEND_INTEGRATION.md` §9). Implementation in progress (Milestone 1).

---

## 1. Principles

1. **One application.** A single Next.js project and a single Node.js process.
2. **CNCjs does the machine work.** Serial, streaming, buffering, parsing and safety logic come from the CNCjs backend unchanged. Kinetiq adds a UI and about 40 lines of bootstrap.
3. **The server is the source of truth.** The UI renders the state the backend broadcasts. It never guesses machine state and never acts optimistically on motion.
4. **Minimal surface.** Four widgets, one page, few dependencies, no speculative abstractions.
5. **Safety first.** Every control is gated by verified backend state. Real-time hold and reset are always reachable. Software controls never claim to be an emergency stop.

---

## 2. Claude Code skills: discovered and used

| Skill | Source | Used? | Responsibility in Kinetiq |
|---|---|---|---|
| **graphify** | `~/.claude/skills/graphify` | **Yes** | Navigated the CNCjs dependency graph (`explain`, `path`, `query`, plus a scan for INFERRED edges). Every result was checked against source (`CNCJS_ANALYSIS.md` §1). |
| **emil-design-eng** | anthropic-skills | **Yes** | Motion and interaction rules: no animation on high-frequency actions (jog, console, readouts), `scale(0.97)` press feedback at 100–160 ms, transitions on transform and opacity only, custom ease-out curve, exit faster than enter, gate hover behind `(hover:hover)`, `prefers-reduced-motion`. |
| **apple-design** | anthropic-skills | **Yes** | Foundations: respond on pointer-down; *grouping and mapping* (the jog pad mirrors the machine axes); four kinds of feedback (status, completion, warning, error); confirm only irreversible actions (Stop job); *simplicity, not minimalism*; system typography with size-specific tracking; reduced motion and contrast media queries. |
| **dataviz** | bundled | **Yes** | Job progress follows the dataviz *meter* and *stat tile* guidance: it is a number and a meter, not a chart. Status colors are kept separate from the accent and always pair with an icon and a label. The palette was **run through `validate_palette.js`** (§9.3). Tabular figures are used only in aligned columns. |
| **cncjs-patterns** + instincts | `CNCJS-fork/.claude/` | Reference only | Describes CNCjs repo conventions (Yarn, commit scopes, i18n). Relevant only if the fork is ever changed, which is not part of this phase. |
| docs, docx, pptx, pdf, xlsx, google-workspace, browser, computer-use, morning, etc. | anthropic-skills | No | Not relevant to the architecture or UI. |

No Next.js-, Tailwind- or accessibility-specific skill is installed, and none was added: the requirement was not to install extras. Those areas follow the platform's documented conventions plus the design skills above.

---

## 3. Technology stack

| Layer | Choice | Why |
|---|---|---|
| Framework | **Next.js** (App Router, current stable; exact version pinned at M1) + **React** + **TypeScript** | As required |
| Process host | **Next.js custom server** (`server.ts`) | Hosts CNCEngine on the same `http.Server` (D1) |
| Machine backend | **CNCjs server build** (`cncjs-app`, `file:../CNCJS-fork/dist/cncjs`) | Reused unchanged (D2) |
| Realtime client | **`socket.io-client@2.x`** | Protocol lock-step with the CNCjs Socket.IO 2.2 server (D3) |
| Styling | **Tailwind CSS v4** with CSS-variable design tokens (`@theme`) | As required; tokens are defined once |
| Primitives | **Radix UI**, only `@radix-ui/react-select` and `@radix-ui/react-dialog` | Accessible select and confirmation dialog without a full component library |
| Icons | `lucide-react` | Consistent stroke icons, tree-shaken |
| State | React `useSyncExternalStore` over one small module store | Native; no state library |
| Server runner | `tsx` (dev), `tsc` build of `server.ts` (prod) | Minimal |
| Fonts | System stacks only (no web-font download) | Works offline on a shop PC; system fonts ship optical sizing |

**Explicitly not used:** state libraries (Redux, Zustand), data-fetching libraries, ORMs or databases, a REST layer, i18n (English only for v1), animation libraries, charting libraries, and any testing tooling (out of scope by policy).

---

## 4. Directory structure (`new-cnc-app/`)

```
new-cnc-app/
├── package.json                 name: "kinetiq"; scripts: dev / build / start
├── server.ts                    custom server: http.Server + Next handler + CNCEngine + session + shutdown
├── tsconfig.json                app (Next)
├── tsconfig.server.json         server.ts → dist/server.js (CommonJS, Node target)
├── next.config.ts
├── postcss.config.mjs           @tailwindcss/postcss
├── docs/                        ← this documentation
└── src/
    ├── server/                  SERVER-ONLY. Imported by server.ts, never by src/app or src/components.
    │   ├── cncjs.ts             require() of the three CNCjs modules; config/secret bootstrap
    │   ├── session.ts           GET /api/kinetiq/session (JWT mint, Host check)
    │   └── cncjs.d.ts           ambient types for cncjs-app/server/… modules used
    ├── app/
    │   ├── layout.tsx           <html>, fonts, metadata ("Kinetiq")
    │   ├── page.tsx             renders <Workspace/> (static shell)
    │   └── globals.css          Tailwind import + design tokens (@theme)
    ├── lib/
    │   ├── cnc/
    │   │   ├── protocol.ts      typed event maps, mirroring API_REFERENCE.md §2–4
    │   │   ├── client.ts        socket singleton: connect(token), list, open, close, command, writeln
    │   │   ├── store.ts         machine store + useMachine(selector)
    │   │   ├── console-store.ts ring buffer (2,000 lines) + useConsole()
    │   │   ├── derive.ts        pure: connectionStatus, jobStatus, canJog, canSend, jobTimes, units
    │   │   └── commands.ts      jogLine(axis, dir, step, feed, units), stopSequence()
    │   └── format.ts            coordinates, durations, clock times, percentages
    └── components/
        ├── ui/                  design-system primitives (§9.6)
        ├── workspace/Workspace.tsx   layout grid; mounts the socket lifecycle
        ├── connection/ConnectionBar.tsx
        ├── safety/SafetyControls.tsx (Feed Hold, Reset; D4)
        ├── position/PositionPanel.tsx  readout + JogPad + JogSettings
        ├── job/JobPanel.tsx            state, meter, stat row, controls (D4)
        └── console/ConsolePanel.tsx    log list + input
```

**Import boundary (safety-relevant):** nothing under `src/app`, `src/components` or `src/lib` may import `src/server/**` or `cncjs-app`. This keeps serialport and CNCEngine out of Next's bundles and HMR, so the process can never hold two engines or two handles on the port.

---

## 5. Component responsibilities

| Unit | Responsibility | Talks to |
|---|---|---|
| `server.ts` | Boot order (`BACKEND_INTEGRATION.md` §5.1), session route, shutdown | CNCjs modules, Next |
| `lib/cnc/client.ts` | Owns the **only** socket. Fetches a token, connects with `query: 'token=…'`, and exposes typed emitters. Never decides policy. | Socket.IO |
| `lib/cnc/store.ts` | Reduces server events into one immutable `MachineState`. Holds client flags: `connecting`, `userRequestedClose`, `stopSequence`. | client |
| `lib/cnc/derive.ts` | Pure functions from `MachineState` to UI state (connection, job, guards, times). **All gating rules live here.** | — |
| `ConnectionBar` | Widget 1 | store, client |
| `ConsolePanel` | Widget 2 | console-store, client |
| `PositionPanel` | Widget 3 | store, client |
| `JobPanel` | Widget 4 | store, client |
| `SafetyControls` | Hold, resume and reset (D4) | store, client |

---

## 6. State management

```ts
interface MachineState {
  backend: 'connecting' | 'online' | 'offline';       // socket lifecycle
  ports: { port: string; manufacturer?: string; inuse: boolean }[];
  connection: {
    port: string | null; baudrate: number | null;
    phase: 'closed' | 'opening' | 'open';           // client flag + verified events
    userRequestedClose: boolean;
    error: { kind: 'open-failed' | 'lost'; port: string } | null;
  };
  controller: { state: GrblState | null; settings: GrblSettings | null; firmware: string | null };
  workflow: 'idle' | 'running' | 'paused';
  sender: SenderStatus | null;
  feeder: FeederStatus | null;
  program: { name: string } | null;                   // from gcode:load / gcode:unload
  stopSequence: 'idle' | 'pausing' | 'stopping';      // Kinetiq Stop (API_REFERENCE §7.1)
}
```

- **One store, selector hooks.** `useMachine(s => s.controller.state?.status.wpos)` re-renders only when the selected slice changes, compared with `Object.is` or a shallow compare.
- **The console is a separate store.** Line traffic (hundreds of lines per second when running `$$` or `$CD`) must not re-render the readouts. It is a ring buffer of 2,000 entries, each `{ id, t, dir: 'in'|'out', kind, text, source }`.
- **No program text in the store.** `gcode:load` delivers the whole program; only `name` is kept.
- **No persistence**, except the last-used port, baud, jog step and jog feed in `localStorage`.

---

## 7. Data flow and synchronisation

```
server event ──▶ client.ts ──▶ store.reduce(event) ──▶ derive.* ──▶ widgets (render)
widget action ──▶ guard (derive.can*) ──▶ client.emit(...) ──▶ backend ──▶ server event ──▶ …
```

- **No optimistic machine state.** Clicking Jog changes nothing in the store. The new position arrives through `controller:state` within about 250 ms.
- **Attach on (re)connect.** After `startup`, emit `list`. If a port is `inuse`, emit `open(port, {baudrate: last or 115200})`. The backend attaches without reopening and replays the full state. The same path covers a page reload, a second tab, and backend reconnects.
- **Socket loss.** `backend: 'offline'`, a banner reads "Kinetiq server unreachable: machine state unknown", and every machine control is disabled. Socket.IO reconnects on its own and the attach step runs again.
- **Token failure** (`connect_error` / `error` with an auth message): fetch a new token once, then report the error.

---

## 8. Error handling strategy

| Layer | Strategy |
|---|---|
| Firmware errors and alarms | Shown in the console (classified and colored); alarm state appears in the header badge. During a job, pause-on-error is backend behaviour, and the Job widget shows **Error** with `holdReason.msg`. |
| Connection | Open failure and connection loss are distinct, persistent inline messages in the Connection widget, cleared on the next successful open. No toasts. |
| Invalid user input | Validated before emitting: numeric baud, a finite feed above 0, an allowed jog step, a non-empty console line. Errors are shown inline. |
| Disallowed actions | Controls are **disabled with a stated reason** (tooltip and helper text) instead of failing silently. |
| Server startup failures | `server.ts` logs and exits non-zero if the CNCjs build is missing or the port cannot bind. Starting with a half-working backend is never allowed. |
| Client exceptions | Each widget gets a React error boundary, so a rendering bug in one widget cannot blank the safety controls. |

---

## 9. Design system: Kinetiq visual identity

### 9.1 Identity

**Kinetiq = precision in motion.** The interface should feel like a well-made instrument: dark, quiet, exact. Motion is implied by **alignment, rhythm and live numbers**, not by decoration.

- **Wordmark:** `KINETIQ` in the system sans, semibold, uppercase, tracked +0.12em, at 13 px in the top bar. The **Q tail** is the single brand flourish, drawn as a short vector stroke in the accent color, read as a toolpath leaving the letter. It is used only in the wordmark and favicon.
- **Tagline (metadata and about only):** "Advanced Motion Control".
- **Voice:** short, literal, machine-accurate. Write "Alarm: hard limit X", not "Oops!".

### 9.2 Principles applied

| Principle | Concrete rule |
|---|---|
| Simplicity, not minimalism | Every widget shows exactly its required fields, with the most important value largest. Nothing is hidden behind menus. |
| One accent | A single interactive color. Status colors are reserved for state. Everything else is neutral graphite. |
| No card soup | Panels are flat regions separated by 1 px hairlines on a single surface. No shadows, no gradients, no nested cards. |
| Mapping | Jog buttons sit where the axis moves. Work and machine coordinates are aligned columns. |
| Feedback | Press feedback on pointer-down. State is visible in exactly one place (the header badge for machine state). |
| Density without clutter | 4 px grid, 13 px base UI text, monospace numerals, labels in muted ink. |

### 9.3 Color tokens (dark theme only in v1)

| Token | Value | Use |
|---|---|---|
| `--bg` | `#0d0e10` | App background and gaps between panels |
| `--surface` | `#15171a` | Panels |
| `--surface-2` | `#1c1f23` | Inputs, buttons, segmented controls |
| `--line` | `#262a2f` | Hairlines and dividers |
| `--ink` | `#e7e9ec` | Primary text and readouts |
| `--ink-2` | `#a1a7af` | Secondary text (machine coordinates, metadata) |
| `--ink-3` | `#6b727b` | Labels and units |
| `--accent` | `#5ab8ff` | **Kinetiq Signal**: primary action, focus ring, selected segment, meter fill |
| `--accent-track` | `#1b3245` | Meter track (darker step of the accent hue, per the dataviz *meter* rule) |
| `--ok` | `#0ca30c` | Connected, Completed |
| `--warn` | `#fab219` | Paused, Hold, Door, Waiting for controller |
| `--crit` | `#d03b3b` | Alarm, Error, Connection error/lost, Reset button outline |

**Validation (dataviz `validate_palette.js`, dark, surface `#16181b`):** all five non-neutral colors pass **contrast ≥ 3:1** and the chroma floor. As expected, `--ok` and `--crit` are **not** separable under deuteranopia (ΔE 4.1), and an amber "serious" step was too close to `--warn` (ΔE 13.6). So:

1. Kinetiq uses **three** status levels, not four.
2. **Every status always pairs an icon with a text label.** Color is never the only signal.

Axis identity uses **letters, not colors**. The common X-red/Y-green/Z-blue scheme would collide with the status colors.

### 9.4 Typography

| Role | Font | Size / weight | Notes |
|---|---|---|---|
| UI text | `system-ui, -apple-system, "Segoe UI", sans-serif` | 13 px / 400, labels 11 px / 500 uppercase +0.06em | — |
| Panel titles | same | 11 px / 600 uppercase +0.08em, `--ink-3` | Quiet section labels, not headings |
| Work coordinates | `ui-monospace, "SF Mono", "Cascadia Mono", Menlo, monospace` | 34–40 px / 500, tracking −0.02em, `tabular-nums` | Aligned column of live values: tabular figures prevent jitter |
| Machine coordinates | mono | 15 px / 400, `--ink-2`, tabular | — |
| Job percentage | system sans | 28 px / 600, proportional figures | Standalone value (dataviz hero/stat rule) |
| Console | mono | 12.5 px / 1.5 line-height | — |

### 9.5 Space, shape, motion

- **Grid:** 4 px base. Panel padding 16 px; control height 32 px (jog buttons 52 px); gap between regions 1 px (`--bg` shows through as the hairline).
- **Radius:** 6 px for controls, 0 for panels (flush regions), 999 px for status badges.
- **Motion (emil-design-eng):**
  - Press: `transform: scale(0.97)` with 120 ms `cubic-bezier(0.23, 1, 0.32, 1)`.
  - Hover color: 120 ms `ease`, only under `(hover:hover) and (pointer:fine)`.
  - Meter fill: `transform: scaleX()` with 250 ms linear (constant motion, matching the 250 ms server tick).
  - Confirmation dialog: opacity plus `scale(0.98→1)` at 180 ms in and 120 ms out.
  - **No animation** on jog presses beyond press feedback, on readout changes, on console lines, or on state changes of the badge. Under `prefers-reduced-motion` only opacity fades remain.
- **Focus:** a 2 px `--accent` ring offset by 2 px on `:focus-visible`. Everything is keyboard-reachable.
- **Contrast mode:** under `prefers-contrast: more`, hairlines become `--ink-3` and `--surface-2` becomes `#24282d`.

### 9.6 Primitives (`src/components/ui/`)

| Primitive | Variants | Notes |
|---|---|---|
| `Button` | `primary` (accent fill), `secondary` (surface-2), `ghost`, `danger` (crit outline) | `disabledReason` prop renders a tooltip and `aria-describedby` |
| `SegmentedControl` | — | Jog step, jog feed. Arrow-key navigation. |
| `Select` | — | Radix Select: port, baud |
| `StatusBadge` | `neutral`, `ok`, `warn`, `crit` | Always icon + label |
| `Readout` | `primary`, `secondary` | Mono, tabular, fixed decimals, unit suffix in `--ink-3` |
| `Meter` | — | Track plus fill, `role="progressbar"`, `aria-valuenow` |
| `Panel` | — | Title row (label + right-aligned actions) + body |
| `ConfirmDialog` | — | Radix Dialog; used only for **Stop job** |

---

## 10. UI/UX: layout and the four widgets

### 10.1 Layout (desktop-first, minimum 1280×720, designed at 1440×900)

```
┌────────────────────────────────────────────────────────────────────────────────────────────────┐
│ KINETIQ │ ● Connected ▾ /dev/cu.usbserial-0001  115200 ▾ [Disconnect] FluidNC v3.7 │ ◉ IDLE │ [‖ Hold] [⟲ Reset] │ 48
├─────────────────────────────────────┬──────────────────────────────────────────────────────────┤
│ POSITION                 G54 · mm   │ JOB                                        ● Running     │
│            WORK        MACHINE      │ bracket-v2.nc                                            │
│   X     120.000        245.000      │ ███████████████████░░░░░░░░░░░░    62%   8,412 / 13,560  │
│   Y      48.250        148.250      │ STARTED 14:02:11  ELAPSED 0:41:06  REMAINING ≈ 25 min    │
│   Z      -1.500        -21.500      │ FINISHED —                                               │
│ ─────────────────────────────────── │ [Load…]                     [▶ Start] [‖ Pause] [■ Stop] │
│ JOG                                 ├──────────────────────────────────────────────────────────┤
│           [ Y+ ]          [ Z+ ]    │ CONSOLE                          ◉ Auto-scroll   Clear   │
│   [ X− ]  [  ■ ]  [ X+ ]            │ 14:01:58  › $$                                           │
│           [ Y− ]          [ Z− ]    │ 14:01:58    $0=10 (Step pulse time, microseconds)        │
│                                     │ 14:01:58    ok                                           │
│ STEP   0.01  0.1  [1]  10  100   mm │ 14:02:03    [MSG:INFO: Homing done]                      │
│ FEED   100  500  [1000]  3000 mm/min│ 14:02:05  ▲ error:15 (Travel exceeded)                   │
│                                     │ ┌─────────────────────────────────────────────┐ [Send]   │
│ Jog disabled: job running           │ │ › Type a command…                           │          │
└─────────────────────────────────────┴──────────────────────────────────────────────────────────┘
   fixed 420 px                            flexible; Job auto-height, Console fills the rest
```

**Why this arrangement:**
- **Connection lives in the top bar.** It is always visible and costs no panel space. Machine state appears **once**, as the header badge, so no widget repeats it.
- **Safety controls sit at the far right of the top bar.** That is a fixed, predictable location that never scrolls or reflows (apple-design: *familiarity / consistency*).
- **Position and Jog sit on the left.** It is the hands-on panel, and readout and controls sit together so the operator watches the numbers move while jogging (*grouping & mapping*).
- **Job sits above the Console.** It is glanceable status that should not be pushed down by log traffic. The Console takes the remaining height for maximum density.
- **No navigation, no tabs, no pages.**

### 10.2 Widget 1: Connection (top bar)

| Element | Behaviour |
|---|---|
| Status | `StatusBadge`: **Disconnected** (neutral, ○), **Connecting…** (neutral, spinner), **Connected** (ok, ●), **Connection error** (crit, ▲). Sub-status after Connected: "Waiting for controller…" (warn) until the first status report. |
| Port | Radix Select listing `serialport:list` entries (`port · manufacturer`). Ports shown as "in use" belong to this backend. A refresh icon re-emits `list`. Disabled while connected. |
| Baud | Select: 115200 (default), 250000, 230400, 57600, 38400, 19200, 9600, plus any `startup.baudrates`. Disabled while connected. |
| Action | One button: **Connect** (primary) ↔ **Disconnect** (secondary). Disabled while connecting. |
| Identification | When ready: `FluidNC v3.7.8` (from the banner) or `Grbl 1.1h`. Hover shows port, baud and the GRBL-compat version. |
| Errors | Inline under the bar, persistent until the next attempt. "Could not open /dev/cu.usbserial-0001. Check that the cable is connected and no other program is using the port." or "Connection lost: the controller may still finish moves it already received." |

### 10.3 Widget 2: Console

| Element | Behaviour |
|---|---|
| Lines | Mono, one row per line: timestamp (`--ink-3`), direction glyph (`›` outgoing, blank incoming), text. Classes: **out** (`--ink`), **response** (`--ink-2`), **ok** (`--ink-3`, de-emphasised), **message** (`--ink-2`; `[MSG:WARN` → warn glyph, `[MSG:ERR` → crit glyph), **error** (crit ▲ + text), **alarm** (crit ◆ + text, row tinted at 8 % crit). |
| Source | Feeder-originated lines (jogs) are marked with a small `jog`/`feeder` tag. Lines sent from other tabs are shown, because echo de-duplication is per tab. |
| Auto-scroll | On by default. It pauses automatically when the user scrolls up, and a "Jump to latest ↓" pill appears. A toggle in the panel header shows the current mode. |
| Clear | Clears the local buffer only (labelled "Clear view"). It does not affect the machine. |
| Input | Single-line input + **Send** (Enter). **Disabled while a job is running or paused**, with the reason shown in the placeholder. Real-time control stays in the top bar. |
| Performance | The ring buffer caps the DOM at 2,000 rows, and incoming lines are batched per animation frame. Add virtualisation only if profiling shows a need. |

### 10.4 Widget 3: Position and Jog

| Element | Behaviour |
|---|---|
| Header | `POSITION`, plus active WCS (`G54`) and report units (`mm`/`in` from `$13`) on the right |
| Readout | Three rows (X, Y, Z) and two columns. **Work** is large, primary ink. **Machine** is small, secondary ink, under a `MACHINE` column label. Fixed 3 decimals in mm and 4 in inches. Values are dimmed (`--ink-3`) with "—" until the first status report. |
| Jog pad | 3×3 XY cross (Y+ top, Y− bottom, X− left, X+ right), plus a separate Z column (Z+ top, Z− bottom), offset by one column to show it is a different plane. The **centre button ■ is Stop jog** (`jogCancel`, `0x85`). Buttons are 52 px, with the letter and sign large and the arrow glyph small. |
| Step | Segmented control: `0.01 · 0.1 · 1 · 10 · 100` mm (inch mode: `0.001 · 0.01 · 0.1 · 1 · 4` in). |
| Feed | Segmented control: `100 · 500 · 1000 · 3000` mm/min, plus a "Custom" numeric field validated to `0 < F ≤ 10000`. **[Hardware check]** Real limits come from FluidNC's per-axis max rate, and the firmware clamps them anyway. |
| Gating | Enabled only when connected and ready, workflow idle, `activeState` Idle or Jog, and the Feeder is not pending. Otherwise all jog buttons are disabled and the reason appears under the pad ("Alarm: send $X in the console to unlock", "Job running", "Controller not ready"). |
| Input mode | Pointer only in v1. Keyboard jogging is deliberately excluded (accidental-motion risk; not in scope). |

### 10.5 Widget 4: Job Status

| Element | Behaviour |
|---|---|
| Header | `JOB`, plus the job `StatusBadge`: Idle (neutral ○), Running (accent ▶), Paused (warn ‖, with `holdReason.msg` such as "M0 program pause" or "Tool change T2" on a second line), Completed (ok ✓), Cancelled (neutral ■), Error (crit ▲, with the error message). |
| Program | File name (truncated in the middle) and line count. Empty state: "No program loaded" + **Load…** (D4). |
| Meter | Full-width `Meter`. The percentage is large on the right, with `received / total` lines under it. |
| Stat row | `STARTED 14:02:11` · `ELAPSED 0:41:06` · `REMAINING ≈ 25 min` · `FINISHED 14:43:17 / —`. Each has a hover note on its source and accuracy (`API_REFERENCE.md` §7.3). Remaining shows "—" until it is available. |
| Controls (D4) | **Start** (primary; when idle with a program loaded), **Pause** / **Resume**, **Stop** (danger; opens a confirmation dialog, then runs the safe stop sequence pause → Hold:0 → force stop, showing "Stopping…"). |

### 10.6 Safety controls (top bar, D4)

- **Hold** (warn outline): feed hold, or job pause while running. It turns into **Resume** when held. No confirmation.
- **Reset** (crit outline): soft reset. No confirmation, because hesitation is worse than a reset. Hover note: "Soft reset (Ctrl-X). Stops motion and clears buffers. Not an emergency stop."
- Both are **always** visible while connected. Their positions never change.

### 10.7 Empty, disconnected and edge states

- **Backend offline:** a full-width crit strip under the top bar, and all controls disabled.
- **Disconnected:** readouts show "—", jog is disabled, and the console shows its history greyed with an input placeholder of "Connect to send commands".
- **Alarm:** the header badge shows `◆ ALARM`, the Position panel shows the unlock hint, and the latest `ALARM:` line is pinned at the top of the console until the state clears.

---

## 11. Next.js integration strategy

- **Single route `/`.** `page.tsx` is a Server Component that renders a static shell plus `<Workspace/>`, a Client Component that owns the socket lifecycle. No Server Actions, no Route Handlers, no data fetching on the server.
- **Custom server owns the process.** `next({ dev, hostname: '127.0.0.1', port })`, then `app.getRequestHandler()` for everything except `/api/kinetiq/session` and `/socket.io/*`.
- **Scripts:**
  - `dev`: `tsx watch server.ts`
  - `build`: `next build && tsc -p tsconfig.server.json`
  - `start`: `NODE_ENV=production node dist/server.js`
- **Never** set `output: 'standalone'`, because it does not trace a custom server.
- The prerequisite check (`dist/cncjs/server` exists) runs at server boot and fails fast with clear instructions.

---

## 12. Future expansion (designed for, not built)

Excluded from v1, but the architecture adds them without restructuring: G-code visualisation, file manager, macros, probing, WCS screens, overrides, keyboard jogging, light theme. Each would be a new component reading the same store and using an existing backend command (`API_REFERENCE.md` §11). No abstraction is pre-built for them.
