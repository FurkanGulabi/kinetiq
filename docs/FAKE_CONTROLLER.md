# Fake controller (development only)

`scripts/fake-controller.py` stands in for a FluidNC board so the UI can be developed and tested without a machine: on a laptop away from the CNC, in a cloud session, or to reproduce a state (alarm, probe failure) on demand. It is **not** a motion simulator and says nothing about how real hardware behaves. Hardware sessions (`docs/hardware/`) remain the reference.

## Run it

```bash
npm run fake-controller   # terminal 1
npm run dev:fake          # terminal 2
```

1. The fake opens a pseudo-terminal, symlinks it to `$TMPDIR/kinetiq-fake0`, and writes `$TMPDIR/kinetiq-fake.rc`. That rc file lists the port under `ports`, the backend's list of extra ports (`list` in `src/server/engine/SocketEngine.ts`).
2. `npm run dev:fake` is `npm run dev` with `KINETIQ_RC` pointing at that rc file. Your real `~/.kinetiqrc` is not touched.
3. In Kinetiq, pick **kinetiq-fake0** and Connect.

Requirements: Python 3.8+ on macOS or Linux (it uses the standard `pty` module, no packages).

**Windows:** the fake controller cannot run natively (no `pty`; it exits with a message). Run both commands inside WSL (Ubuntu) from a clone of the repo in the WSL filesystem, with Node and Python installed there; open `http://127.0.0.1:8000` in the Windows browser (WSL forwards localhost). `npm run dev:fake` itself is cross-platform (a Node launcher, `scripts/dev-fake.mjs`).

Options (`npm run fake-controller -- --help`):

| Option | Effect |
| --- | --- |
| `--speed N` | Motion runs at N × the programmed feed (default 4), so jobs finish quickly |
| `--alarm` | Start in Alarm, as after power-up with homing enabled; `$H` or `$X` clears it |
| `--surface-z Z` | Machine Z of the probe surface at X0 Y0 (default −20). It tilts and waves slightly across X/Y, so bed leveling draws a real height map |
| `--flat` | Flat probe surface |
| `--probe-miss` | Probing never touches: `ALARM:5` |
| `-v` | Log every line received |
| `--trace FILE` | Append every received unit to FILE in arrival order, one record per line: `<ms>\t<record>` (time since start). A record is a line as received (bytes outside printable ASCII as `\xNN`), a real-time byte as a token (`<?>`, `<!>`, `<~>`, `<0x18>`, `<0x85>`, …), or one `XMODEM <file> bytes=… blocks=… naks=… noise=… sha256=…` summary per transfer instead of its blocks. Used by the protocol diff (`scripts/protocol-scenarios/`) |
| `--link`, `--rc` | Other paths for the port symlink and the rc file |

## What it answers

| Area | Behaviour |
| --- | --- |
| Status | `?` → `<State\|MPos\|FS\|WCO\|Ov>`; states Idle, Run, Jog, Hold:0, Home, Alarm |
| Info | `$I` (FluidNC v4.0.1 (fake)), `$G`, `$#` (G54 and PRB), `$$` |
| Motion | G0/G1 (G2/G3 as straight lines), G90/G91, G53, F, M3/M5, G4 dwell; G-codes GRBL does not know (`G999`) → `error:20`. A queue of 12 moves stands in for the planner: `ok` is held while it is full, so the Sender streams as it would to real hardware |
| Work zero | `G10 L20 P1 X… Y… Z…` after the queued moves finish |
| Jog | `$J=` (relative, absolute, G53); jog cancel `0x85`; Feed hold cancels a jog |
| Realtime | `!` hold, `~` resume, `Ctrl-X` reset (clears the queue and prints the banner), feed/rapid/spindle overrides |
| Homing, alarm | `$H` (about 1 s, ends at machine 0,0,0), `$X` unlock; motion in Alarm → `error:9` |
| Probing | `G38.2` / `G38.3` against the surface above; `[PRB:…:1]` on contact, `ALARM:5` on a miss with G38.2 |
| Config file | `$Config/Filename`, `$LocalFS/List` / `Show` / `Delete` / `Rename`, `$CD`, `$SS`, `$Xmodem/Receive` (XModem-1K, CRC16). Files are kept in memory; Reset or `$Bye` loads the saved `config.yaml` as the running config |

Like real FluidNC over USB, it does not print a banner when the port is opened, only after a reset.

## Limits

- Arcs are drawn by Kinetiq from the program, but the fake moves in straight lines between arc end points.
- No acceleration, no soft limits, no limit switches, no spindle feedback; no `Pn:` pin report (the probe always reads open), and no `Bf:` (the Sender keeps its conservative 120-byte buffer, as with real FluidNC, see BACKEND_INTEGRATION F7).
- One client at a time; quitting the fake removes the port symlink.
