# Protocol scenarios (serial traffic diff)

The safety net for the backend rewrite (docs/BACKEND_REWRITE_PLAN.md §4): record exactly what the backend writes to the serial port in fixed scenarios, then diff against the baseline recorded with the CNCjs JavaScript backend. There are no automated tests in this project; this is the check for each rewrite phase.

```bash
npm run protocol:record -- --out /tmp/proto-new            # all scenarios (about 2 minutes)
npm run protocol:record -- --out /tmp/proto-new 04-job-stop 08-settings-editor   # some of them
npm run protocol:compare -- scripts/protocol-scenarios/baseline /tmp/proto-new
```

`compare` prints one line per scenario, the poll cadence, and a unified diff for each scenario that differs. It exits 1 on any difference. A difference the phase meant to make (one of the removals in plan §3, or a fixed bug) is accepted by re-recording the baseline: `npm run protocol:record -- --out scripts/protocol-scenarios/baseline`, then commit it together with the change.

Record options: `--out DIR` (default: a new directory in `$TMPDIR`), `--port N` (server port, default 8077; 8000 is refused), `--keep` (keep each scenario's temp dir with `fake.log`, `server.log` and `events.log`, the socket events seen by the driver; failed scenarios always keep it).

## What one run does

For each scenario, in a fresh temp dir:

1. `scripts/fake-controller.py --link <tmp>/fake0 --rc <tmp>/kinetiq.rc --trace <tmp>/serial.trace` plus the scenario's flags.
2. `server.ts` with `KINETIQ_HEADLESS=1` (backend and HTTP APIs, no Next.js), on its own port, with `KINETIQ_RC`, `KINETIQ_JOBS_DIR`, `KINETIQ_CONFIG_BACKUP_DIR` and `HOME` inside the temp dir.
3. A Socket.IO client connects like the UI does (session token, `startup` → `list` → `open`), runs the scenario, then closes the port.
4. Both processes are stopped. The trace is copied to `<out>/<scenario>.trace`.

**Safety.** The driver only opens the fake port it started: the exact path, which must resolve to a pseudo-terminal. Before the first command it checks that the workflow is idle, no program is loaded, and the controller is Idle (Alarm for scenario 6). It refuses port 8000 and a port already in use. It kills every process it started, also on failure and Ctrl-C. Nothing reads or writes `~/.kinetiqrc` or `~/.kinetiq`.

## Trace format and normalizing

The fake writes one record per received unit: `<ms since start>\t<record>`. A record is a line as received, a real-time byte (`<?>`, `<!>`, `<~>`, `<0x18>`, `<0xC2>`, …), or one `XMODEM …` summary per file transfer (name, bytes, blocks, NAKs, sha256 of the content). See docs/FAKE_CONTROLLER.md.

`compare.mjs` drops the times. It takes the status polls (`<?>` and `$G`) out of the sequence, because how many land between two commands depends on timing. Everything else must match exactly and in order. For the polls it prints the count and the median / p90 / max interval for both runs. A median that moves by more than max(25 ms, 10 %) fails the compare when the baseline has at least 10 samples (`--ignore-cadence` reports it without failing). With fewer samples the numbers are only shown: a few `$G` intervals stretched by probe moves, which the controller answers in order, have no stable median.

## Scenarios

| Trace | Fake flags | What the client does |
| --- | --- | --- |
| `01-connect-idle` | | Connect and stay idle for 10 s: `$$` on the first status, then the polling cadence |
| `02-jog` | | Jog X+10, Y+10, Z−10, X−10 (`jogLine`, Feeder), Go to zero with Z (two `$J=G90` lines queued at once), a 100 mm jog cancelled with `jogCancel` while it runs |
| `03-job-m0-m6-hold` | | `fixtures/job-m0-m6.nc`: start, Resume at M0, Resume at M6, Pause / Resume on the last long move once every line is sent, finish |
| `04-job-stop` | | `fixtures/job-long.nc`: Stop mid-way with lines still unsent, as `client.ts stopJob()` does it (pause → Hold:0 → `gcode:stop {force:true}` → soft reset) |
| `05-overrides` | | `fixtures/job-long.nc` with feed and spindle overrides (+10, −10, +1, −1, reset) in three groups while it streams, then finish |
| `06-alarm-unlock-home` | `--alarm` | Unlock (`$X`), then Home (`$H`) |
| `07-probe-z` | | Z probe with a 1.5 mm plate: the `probe.ts` sequence, one line at a time |
| `07-probe-miss` | `--probe-miss` | The same probe, failing with `ALARM:5`, then Unlock |
| `08-settings-editor` | | Settings HTTP API: read, save an edited `config.yaml` (XModem upload in exclusive mode, swap, verify), restart (`$Bye`), read again to check the restart loaded it |
| `09-leveling` | | Z probe (plate 0), the `leveling/run.ts` 3×3 probe grid over 20×20 mm, then `fixtures/job-level.nc` compensated with `compensate()` and run |
| `10-travel-limits` | | Travel limits on (`KINETIQ_TRAVEL_LIMITS=on`, off in every other scenario): X jog blocked before homing, Z jog sent, Home, jogs inside, shortened to the limit and blocked at it, two queued jogs, a jog typed in the console. See docs/TRAVEL_LIMITS.md |
| `11-macros` | | Macro API: create a 6-line macro over HTTP (with `%var=`, `[expr]` and a `$J=` line), `macro:run` while a job is paused at M0 (refused, nothing sent; job stopped), `macro:run` twice at once (first runs line by line, second refused: Feeder busy), delete it over HTTP, `macro:run` again (refused: unknown id). Added 2026-11-11 with its own baseline |

### Reproducible timing

Commands go out at points in the serial stream that are the same in every run, so that real-time bytes always land between the same two lines:

- The driver follows the trace file and waits for backend events (`workflow:state`, `controller:state`, `serialport:read` `ok`) instead of fixed sleeps. Idle means "Idle in the status for 750 ms".
- Pause / Resume in scenario 3 happen after the `%wait` dwell (`G4 P0.5`) is on the wire, so every line has been sent.
- Stop (4) and the overrides (5) happen during streaming. `job-long.nc` is 0.5 s per move at the fake's default `--speed 4`. After the first burst, lines arrive one per completed move. The driver waits for that steady state (300 ms with no line), then for the next line, and acts at once, with a whole move before the next line.
- The leveled program depends on the probed heights. The fake's surface is a fixed function and the driver builds the height map with a fixed id, so the program is the same in every run.

### Where the driver differs from the UI

The UI's sequencing code (`src/lib/cnc/client.ts`, `lineSequence.ts`, `probe.ts`, `src/lib/leveling/run.ts`) needs the browser store, React and the socket singleton, so it can't be imported in Node. `record.mts` mirrors it, and each mirror names its source. The pure builders are imported as they are: `commands.ts` (jog / go-to-zero lines, `WCS_P`), `heightmap.ts` (`gridAxis`, `probeOrder`) and `compensate.ts`. If one of the mirrored UI functions changes, update the mirror and re-record the baseline.

- Probe failure: after a failed step the UI immediately sends the restore line unless the last status says Alarm. The driver waits 750 ms (three status polls) before it decides, so the result does not depend on whether a status report arrived in between. With `ALARM:5` both end up not sending it.
- Leveling: the map id and time are fixed (`emptyMap()` uses `Date.now()` and a random id). The UI's checks before applying the map (offset drift, job area) send nothing and are skipped. The `?`/`$G` polls are the backend's own timer, as in the UI.
- The job library is not used. Jobs are loaded with `gcode:load` directly, as `library.ts` does after its HTTP fetch, which sends nothing to the serial port.
- UI timeouts are not mirrored. They only matter for a stuck machine.

## Files

- `record.mts`: the driver (run by `tsx`: `npm run protocol:record`)
- `compare.mjs`: normalizer and diff (`npm run protocol:compare`)
- `fixtures/`: the G-code programs the scenarios load
- `baseline/`: traces recorded with the CNCjs JavaScript backend (2026-11-09); later Kinetiq scenarios (`11-macros`) were recorded when they were added
