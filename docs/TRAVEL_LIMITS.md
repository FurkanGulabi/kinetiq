# Travel limits

Kinetiq is set up for one machine: a DIY 3-axis router on FluidNC. It homes to the bottom-right corner (seen from above), which becomes machine X0 Y0. From there it can only move left (X−) and up (Y+). Both ends of X and Y have limit switches, so the hardware stops a crash; these limits are about the work area: they keep jogs inside it and check that a loaded program fits with the current work zero. Z has no switch and no homing, and is not limited.

## The numbers

All of them are in [`src/lib/machine/travel.ts`](../src/lib/machine/travel.ts):

| Constant | Value | Meaning |
|---|---|---|
| `TRAVEL_LIMIT_MM` | `{ x: 200, y: 200 }` | Travel from the home switch. **Provisional**: the physical travel is about 400 / 410 mm and not measured yet. Put the measured values here. |
| `SAFETY_MARGIN_MM` | `2` | Kept free before the far end. |
| `HOME_CLEARANCE_MM` | `1` | Kept free before the home switch. Equal to `pulloff_mm`: homing leaves the machine exactly here. |
| `HOME_END` | `{ x: 'max', y: 'min' }` | X travel runs negative from 0, Y travel positive. |

With these, the allowed machine position is X −198 … −1 and Y 1 … 198.

## What Kinetiq does

- **Homed state** (backend, `TravelGuard`). An axis counts as homed after a homing cycle (`$H`, `$HX`, …) ends in Idle. It is cleared when FluidNC restarts and on any alarm except soft limit (2) and probe fail (4, 5). A soft reset sent by Kinetiq keeps it.
- **Jogs** (backend). Every `$J=` line, from the jog pad, Go to, Go to zero or typed in the console, is checked before it is sent. A jog that would leave the limits is shortened to end on them; a jog that cannot move, or that moves X or Y before they are homed, is not sent. The console shows a `[MSG:… Kinetiq: …]` line when this happens. Several jogs queued at once are checked from where the previous one will end.
- **Jobs** (UI, `programFitView`). Start is disabled until X and Y are homed and every move of the program, with the current work zero, stays inside the limits. The Job widget names the side and the distance (`X− by 12.5 mm`). `G53` moves in X/Y are checked in machine coordinates. What cannot be checked is listed as a warning and does not block: `G28`/`G30`, `G92`, `G10`, another work coordinate system, relative moves from the start position.
- **Height map**: probing does not start when the grid leaves the limits.
- **3D view**: the limits are drawn as a dashed rectangle once X and Y are homed, in red while the loaded program leaves them.

Not covered: `G0`/`G1` typed in the console, and program lines while a job runs. The firmware's soft limits are the layer for those.

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
