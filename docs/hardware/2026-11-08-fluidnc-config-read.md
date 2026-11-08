# Hardware session: reading the FluidNC config (2026-11-08)

**Goal:** find out how Kinetiq can read the FluidNC configuration for a settings editor.
**Setup:** ESP32 + FluidNC v4.0.1 on `/dev/tty.usbserial-110`, 115200 baud. Commands sent through the Kinetiq backend (production build, `writeln`), one at a time, each waiting for `ok`.
**Safety:** read-only `$` commands only. Before sending, the machine was in **Alarm** and the workflow was **idle**. No motion. The port was closed and released afterwards.

## Results

| Command | Reply | Time | Notes |
|---|---|---|---|
| `$Config/Filename` | `$Config/Filename=config.yaml` | 11 ms | Active config file name |
| `$LocalFS/List` | `[FILE: config.yaml\|SIZE:1946]`, `favicon.ico`, `index.html.gz`, `preferences2.json`, then `[/littlefs/ Free:52.00 KB Used:140.00 KB Total:192.00 KB]` | 216 ms | Note the space after `FILE:` |
| `$LocalFS/Show=config.yaml` | The saved file, 86 lines, one serial line per YAML line | 209 ms | Exact file text. This file has no comments |
| `$/axes/x` | `/axes/x:` header, then the running X subtree as YAML | 68 ms | Same formatting as `$CD` (see below) |
| `$/axes/x/steps_per_mm` | `$/axes/x/steps_per_mm=400.000` | 13 ms | Single values come back as `$<path>=<value>` |
| `$CD` | The running config, **187 lines** | 392 ms | Every key including defaults (`spi`, `sdcard`, `meta`, `kinematics: Cartesian`, `segments`, `settle_ms`, …) |
| `$SS` | Boot log as `[MSG:INFO: …]` / `[MSG:WARN: …]` lines | 140 ms | Shows config warnings from boot |

Every reply ended with `ok`. The backend did not forward status reports (`<…>`) or the `ok` of its own `$G` polls as `serialport:read`, so none were mixed into the replies.

## How `$CD` differs from the saved file

`$CD` (and `$/…`) is not the saved file reformatted, so it must not be written back as the file text:

| Saved file (`$LocalFS/Show`) | Running config (`$CD`) |
|---|---|
| `x:` | `X:` (axis keys upper-case) |
| `limit_pos_pin: NO_PIN` | `limit_pos_pin: NO PIN` (space, not underscore) |
| `direction_pin: gpio.33:low` | `direction_pin: 'gpio.33:low'` (quoted when there are attributes) |
| `steps_per_mm: 400` | `steps_per_mm: 400.000000` |
| `kinematics: {}` | `kinematics:` / `  Cartesian:` |
| 86 lines | 187 lines (defaults included) |

**For the editor:** show and edit the saved file (`$LocalFS/Show`). Use `$CD` or `$/<path>` only to show the values actually in effect, and to spot keys whose running value differs from the file.

## Findings worth acting on

- **Config warning at boot:** `[MSG:WARN:   Motor0 switches do not support positive homing dir]` for **X**. `axes/x/homing/positive_direction: true`, but X only has `limit_neg_pin: gpio.5:low`, so homing X goes the opposite way from its only switch. Check this before homing X.
- **Network:** FluidNC is now in station mode on the local Wi-Fi (it was in access-point mode in the M1 session), with HTTP on port 80, **Telnet on port 23** and mDNS `fluidnc.local`. Telnet gives unauthenticated machine control to anything on the LAN. (SSID and IP left out of this note.)
- **Space:** 52 KB free in LocalFS, and the config is 1.9 KB, so a backup copy can also be kept on the controller.

## Saved `config.yaml` (as read)

```yaml
board: ESP32 Custom CNC
name: 3-Axis Spindle Probe Config
kinematics: {}
axes:
  shared_stepper_disable_pin: gpio.32:high
  shared_stepper_reset_pin: NO_PIN
  homing_runs: 2
  x:
    steps_per_mm: 400
    max_rate_mm_per_min: 1000
    acceleration_mm_per_sec2: 25
    max_travel_mm: 1000
    soft_limits: false
    homing:
      cycle: 1
      positive_direction: true
      mpos_mm: 0.0
      seek_mm_per_min: 500.0
      feed_mm_per_min: 100.0
    motor0:
      limit_neg_pin: gpio.5:low
      limit_pos_pin: NO_PIN
      limit_all_pin: NO_PIN
      hard_limits: true
      pulloff_mm: 1
      standard_stepper:
        step_pin: gpio.25
        direction_pin: gpio.33:low
  y:
    steps_per_mm: 400
    max_rate_mm_per_min: 1000
    acceleration_mm_per_sec2: 25
    max_travel_mm: 1000
    soft_limits: false
    homing:
      cycle: 1
      positive_direction: false
      mpos_mm: 0.0
      seek_mm_per_min: 500.0
      feed_mm_per_min: 100.0
    motor0:
      limit_neg_pin: gpio.4:low
      limit_pos_pin: NO_PIN
      limit_all_pin: NO_PIN
      hard_limits: true
      pulloff_mm: 1
      standard_stepper:
        step_pin: gpio.27
        direction_pin: gpio.26:low
  z:
    steps_per_mm: 400
    max_rate_mm_per_min: 1000
    acceleration_mm_per_sec2: 25
    max_travel_mm: 1000
    soft_limits: false
    motor0:
      limit_neg_pin: NO_PIN
      limit_pos_pin: NO_PIN
      limit_all_pin: NO_PIN
      hard_limits: false
      pulloff_mm: 1
      standard_stepper:
        step_pin: gpio.12
        direction_pin: gpio.14
PWM:
  pwm_hz: 5000
  output_pin: gpio.16
  enable_pin: gpio.17
  direction_pin: NO_PIN
  disable_with_s0: false
  s0_with_disable: true
  spinup_ms: 1000
  spindown_ms: 1000
  tool_num: 0
  speed_map: 0=0.0% 10000=100.0%
probe:
  pin: gpio.22:low
  check_mode_start: true
  hard_stop: false
  toolsetter_pin: NO_PIN
stepping:
  engine: RMT
  idle_ms: 250
  pulse_us: 4
  dir_delay_us: 0
  disable_delay_us: 0
```

## Boot log (`$SS`, Wi-Fi lines redacted)

```
[MSG:INFO: FluidNC v4.0.1 https://github.com/bdring/FluidNC]
[MSG:INFO: Local filesystem type is littlefs]
[MSG:INFO: Configuration file:config.yaml]
[MSG:INFO: Machine 3-Axis Spindle Probe Config]
[MSG:INFO: Board ESP32 Custom CNC]
[MSG:INFO: Stepping:RMT Pulse:4us Dsbl Delay:0us Dir Delay:0us Idle Delay:250ms]
[MSG:INFO: Axis count 3]
[MSG:INFO: Shared stepper disable gpio.32]
[MSG:INFO: Axis X (-1000.000,0.000)]
[MSG:INFO:   Motor0]
[MSG:INFO:     standard_stepper Step:gpio.25 Dir:gpio.33:low Disable:NO PIN]
[MSG:INFO:  X Neg Limit gpio.5:low]
[MSG:WARN:   Motor0 switches do not support positive homing dir]
[MSG:INFO: Axis Y (0.000,1000.000)]
[MSG:INFO:   Motor0]
[MSG:INFO:     standard_stepper Step:gpio.27 Dir:gpio.26:low Disable:NO PIN]
[MSG:INFO:  Y Neg Limit gpio.4:low]
[MSG:INFO: Axis Z (-1000.000,0.000)]
[MSG:INFO:   Motor0]
[MSG:INFO:     standard_stepper Step:gpio.12 Dir:gpio.14 Disable:NO PIN]
[MSG:INFO: Kinematic system: Cartesian]
[MSG:INFO: Connecting to STA SSID:<redacted>]
[MSG:INFO: Connecting.]
[MSG:INFO: Connecting..]
[MSG:INFO: Connecting...]
[MSG:INFO: Connected - IP is <redacted>]
[MSG:INFO: WiFi on]
[MSG:INFO: Start mDNS with hostname:http://fluidnc.local/]
[MSG:INFO: HTTP started on port 80]
[MSG:INFO: Telnet started on port 23]
[MSG:INFO:     Max frequency of LEDC set at 9765; duty resolution: 13; channel 0]
[MSG:INFO: PWM Spindle Ena:gpio.17 Out:gpio.16 Dir:NO PIN Freq:5000Hz Period:8191]
[MSG:INFO: Probe gpio.22:low]
```
