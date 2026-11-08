# Bed leveling (height map)

**Status:** built 2026-11-09. Compensation verified numerically and in the UI; probing a real grid not yet run on the machine.

Top bar → **Leveling** opens a panel below the top bar (Hold/Reset stay reachable).

## Flow
1. **Prepare:** machine homed and Idle, work X/Y zero at the job origin, **Z0 on the stock surface** (Probe Z), probe clip on the bit and the probe wire on the stock. The checklist shows live machine state and the probe input.
2. **Probe area:** X/Y range in work coordinates ("Use job area" takes the loaded job's cutting area plus a margin) and the number of points along X and Y (2–20 each, ≤ 200 total, ≥ 2 mm apart).
3. **Probing:** clearance (work Z between points), probe depth (how far below Z0 a probe may go), feed. Estimated time is shown.
4. **Probe height map:** `G21 G90`, `G0 Z<clearance>`, then per point in snake order `G0 X Y` → `G38.2 Z-<depth> F<feed>` → `G0 Z<clearance>`, then the previous G90/G91 and units are restored. The map fills in live.
5. **Level this job:** produces a leveled copy of the loaded program; **Load leveled program** replaces the loaded one (name gets "(leveled)", Job panel shows "Leveled").

## Safety rules
- Probing lines go one at a time (`lib/cnc/lineSequence.ts`, shared with Probe Z). Any `error:`, `ALARM:`, probe report without contact, out-of-range contact height, timeout or lost connection stops the run; the previous map is kept. Cancel = no further lines, Feed hold, Reset.
- Probing needs Idle, no job, no other Kinetiq operation, and the probe not already touching. While it runs, jog, homing, zero, go-to, job load/start, Settings and Probe Z are blocked.
- The map stores the work offset and WCS it was probed with. Leveling a job and starting a leveled job are **blocked if work X/Y/Z zero or the WCS changed** (0.005 mm tolerance).
- Moves between points do not stop on contact: clearance must be above every clamp.

## Compensation (`lib/leveling/compensate.ts`)
Z += bilinear surface height at every written point. Feed moves are split every quarter grid cell (0.5–5 mm); arcs (any plane, IJK or R, helical) are turned into lines first; rapids get their end point corrected.

It **refuses** (shows the reasons, loads nothing) rather than guess:
- a cutting move before X, Y and Z are known, or after G53/G28/G30/$H until they are set again (a feed move from an unknown start that ends above the highest probed point is treated as positioning);
- programs that never set Z (2D jobs), relative moves (G91), inverse-time feed (G93);
- G10 / G92 / G43.1, a WCS other than the map's, probing (G38.x), canned cycles (G73/G76/G81–G89);
- cutting outside the probed area (no extrapolation). Rapids outside it use the nearest edge height (warning).
M6 gives a warning (the new tool must be zeroed at the same surface point).

Why not CNCjs's `autolevel:*` commands (kept in the backend, unused): they queue the whole probe program at once (the Feeder keeps going after an error), keep I/J on split arc segments, add Z to moves made before Z is known, extrapolate outside the grid, and `autolevel:loadFromFile`/`saveToFile` read and write any server path sent over the socket.

## Verification (2026-11-09)
- CNCjs example programs with a tilted, warped test map: every accepted program's leveled points match the original path plus the surface to output rounding (0.0005 mm in mm programs, 0.0013 mm in inch programs); the 188k-line `github.gcode` levels in about a second; every refused file has a real ambiguity (plunge at an unknown position, no Z, G91, G92).
- 21 edge cases (cuts outside the map, G10/G38/G81/G55/G91, G53 then cut, R/negative-R/too-small-R arcs, off-circle IJK arc, helical, XZ plane, rapid outside, first-line retract, unknown-position plunge, M6, inch program, comments kept).
- UI with a synthetic map: heatmap, stats, alignment check, leveling and loading a 188k-line job, Start block logic.
- **Not yet run:** probing a real grid on the machine.
