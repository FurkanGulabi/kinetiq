# Travel limits

Kinetiq is set up for one machine: a DIY 3-axis router on FluidNC. It homes to the bottom-right corner (seen from above), which becomes machine X0 Y0. From there it can only move left (X−) and up (Y+). Both ends of X and Y have limit switches, so the hardware stops a crash; these limits are about the work area: they keep jogs inside it and check that a loaded program fits with the current work zero. Z has no switch and no homing, and is not limited.

## The numbers

All of them are in [`src/lib/machine/travel.ts`](../src/lib/machine/travel.ts):

| Constant | Value | Meaning |
|---|---|---|
| `TRAVEL_LIMIT_MM` | `{ x: 200, y: 200 }` | Default travel from the home switch. A measured value saved in `~/.kinetiqrc` (`kinetiq.travel`, see below) overrides it per axis. |
| `SAFETY_MARGIN_MM` | `2` | Kept free before the far end. |
| `HOME_CLEARANCE_MM` | `0` | Kept free before machine 0 on the home side. FluidNC sets machine 0 after pulling off the switch (`pulloff_mm`), so 0 is already clear of it. |
| `HOME_END` | `{ x: 'max', y: 'min' }` | X travel runs negative from 0, Y travel positive. |

With these, the allowed machine position is X −198 … 0 and Y 0 … 198.

## What Kinetiq does

- **Homed state** (backend, `TravelGuard`). An axis counts as homed after a homing cycle (`$H`, `$HX`, …) ends in Idle. It is cleared when FluidNC restarts and on any alarm except soft limit (2) and probe fail (4, 5). A soft reset sent by Kinetiq keeps it.
- **Jogs** (backend). Every `$J=` line, from the jog pad, Go to, Go to zero, a macro or typed in the console, is checked before it is sent. A jog that would leave the limits is shortened to end on them; a jog that cannot move, or that moves X or Y before they are homed, is not sent. The console shows a `[MSG:… Kinetiq: …]` line when this happens. Several jogs queued at once are checked from where the previous one will end.
- **Jobs** (UI, `programFitView`). Start is disabled until X and Y are homed and every move of the program, with the current work zero, stays inside the limits. The Job widget names the side and the distance (`X− by 12.5 mm`). `G53` moves in X/Y are checked in machine coordinates. Relative (`G91`) moves made before any absolute X/Y (e.g. a hole cut around wherever the bit is) are checked from the current machine position, and the check follows the machine while it is jogged. X/Y the program never sets (a `G0 Z5` before the first XY move) are not counted. What cannot be checked is listed as a warning and does not block: `G28`/`G30`, `G92`, `G10`, another work coordinate system, relative moves after `G53` or an offset change.
- **Height map**: probing does not start when the grid leaves the limits.
- **3D view**: the limits are drawn as a dashed rectangle once X and Y are homed, in red while the loaded program leaves them.

Not covered: `G0`/`G1` typed in the console, and program lines while a job runs. The firmware's soft limits are the layer for those.

## Measuring the travel ("reverse homing")

Both ends of an axis share one switch input, so FluidNC can only home to one end. The **Work area** box in the Position widget measures the other end instead:

1. Home the machine.
2. **Measure X** (or Y), confirm. The axis jogs at 200 mm/min (`MEASURE_FEED_MM_PER_MIN`) toward the far end, up to 600 mm (`MEASURE_SEARCH_MM`), past the envelope. Other jogs are refused meanwhile; **Stop** cancels it.
3. The far switch raises `ALARM:1`. The backend takes the machine position from the next status report, rounded down to 0.1 mm, as the travel.
4. **Use … mm** saves it in `~/.kinetiqrc` as `kinetiq.travel.<axis>` and rebuilds the envelope (the 2 mm safety margin still applies). **Discard** keeps the current value.
5. Recovery: **Reset** and **Unlock** in the top bar, **Back off 5 mm** (moves the axis toward home off the switch; allowed although the axis is not homed), then **Home**.

A move that ends without the alarm (stopped, or no switch within 600 mm) or another alarm fails the measurement. Saved values outside 50–1000 mm are ignored.

## Firmware soft limits

Set these in the machine settings editor so FluidNC enforces the same limits for everything, including other clients (Telnet, WebUI):

```yaml
axes:
  x:
    max_travel_mm: 200
    soft_limits: true
  y:
    max_travel_mm: 200
    soft_limits: true
```

Keep `max_travel_mm` equal to `TRAVEL_LIMIT_MM` when the measured values go in.

## Turning it off

`KINETIQ_TRAVEL_LIMITS=off` disables the limits (another machine, or the fake controller, whose travel is different). The protocol scenarios run with it off, except `10-travel-limits`.
