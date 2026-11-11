# Troubleshooting

Kinetiq prints its log in the terminal where you started it. The UI cannot show why a port failed to open (the reason does not survive the trip to the browser), so the terminal is the first place to look. For more detail, start Kinetiq with `KINETIQ_LOG_LEVEL=silly`, which logs every serial line.

Setting a variable for one run:

| Shell | Command |
|---|---|
| macOS / Linux | `KINETIQ_LOG_LEVEL=silly npm start` |
| Windows PowerShell | `$env:KINETIQ_LOG_LEVEL = "silly"; npm start` |
| Windows cmd | `set "KINETIQ_LOG_LEVEL=silly" && npm start` |

## The page does not load

| Symptom | Cause and fix |
|---|---|
| `npm start` says `dist/server.js not found` | Run `npm run build` first. |
| The terminal says the address is in use | Another program has port 8000. Start with another port: `KINETIQ_PORT=8080`. |
| The page loads but reports that the backend is offline | Check that Kinetiq is still running in its terminal. Open the page as `http://127.0.0.1:8000` or `http://localhost:8000`, on the computer that runs Kinetiq. Any other host name or address is refused ([SECURITY.md](../SECURITY.md)). |

## The serial port is not in the list

1. Press the refresh icon next to the port list.
2. Check the cable. Many USB cables only charge; use one that carries data.
3. Install the driver for the board's USB-serial chip. ESP32 boards mostly use a **CH340** or a **CP210x**. Recent Windows, macOS and Linux versions include both, but older ones need the vendor's driver.
4. On Linux, your user needs access to the port: `sudo usermod -aG dialout $USER`, then log out and in again.
5. If the system has the port but Kinetiq does not list it, add it to the `ports` list in `~/.kinetiqrc`:

   ```json
   { "ports": [{ "path": "/dev/ttyUSB0" }] }
   ```

   Keep the other keys that are already in the file.

## The port does not open

Only one program can hold a serial port. Close other G-code senders, serial monitors and the Arduino IDE, and check that a second Kinetiq is not running. A port that this Kinetiq already holds is marked "in use" in the list; connecting to it attaches to the open connection.

If nothing else holds the port, read the reason in the terminal.

## Connected, but nothing can move

Every disabled control states its reason under or next to it. The usual ones:

| State | What to do |
|---|---|
| **Alarm** after connecting | Normal for a controller with homing enabled. Press **Home** or **Unlock** in the top bar. **Reset** alone does not clear it. |
| "X and Y not homed" | With the travel limits on, X and Y only jog after homing. Home the machine, or turn the limits off ([TRAVEL_LIMITS.md](TRAVEL_LIMITS.md)). |
| Jog disabled during a job | By design. Extra lines sent while a program streams would break the flow control. Hold and Reset stay available. |
| "Waiting for controller…" does not go away | The controller sends no status reports. Check the baud rate (FluidNC and GRBL default to 115200) and that the board has finished booting. |

## A jog is shorter than asked, or is not sent

The travel limits shortened or refused it. The console shows a `[MSG:… Kinetiq: …]` line with the reason. If the limits do not match your machine, measure the travel or turn the limits off ([TRAVEL_LIMITS.md](TRAVEL_LIMITS.md)).

## Start is disabled

The reason is shown at the left of the buttons. Besides "no program" and "controller not idle" it is usually one of these:

- **Home the machine first**: the fit check needs homed X and Y.
- **Outside travel limits**: the program does not fit with the current work zero. The message names the side and the distance. Move the work zero or the stock.
- **Leveled program no longer lines up**: the work zero or coordinate system changed after probing the height map. Probe again or load the original program ([BED_LEVELING.md](BED_LEVELING.md)).

## A job paused by itself

- **M0, M1 or M6 in the program**: Kinetiq pauses there on purpose. M6 is always a manual tool change. Press Resume to go on.
- **`error:` from the controller**: the job pauses at the offending line and shows it. Fix the program; do not resume past an error you do not understand.

## The connection dropped during a job

Streaming stops, but the controller still runs the moves it had already received. Use your emergency stop if that is not safe. After reconnecting, check the position before doing anything else; if the controller restarted, home again.

Closing the browser tab does not stop a job. The backend keeps streaming, and a reopened tab shows the running job.

## Other programs can still move the machine

FluidNC's own WebUI, Telnet and Wi-Fi interfaces work independently of Kinetiq, and Kinetiq's travel limits do not apply to them. Set the firmware soft limits ([TRAVEL_LIMITS.md](TRAVEL_LIMITS.md)) and secure or disable the network interfaces you do not use.

## Reporting a problem

Open an issue with the firmware and version, the operating system, what you did, and the terminal log around the problem. Check the log for anything private before you post it.
