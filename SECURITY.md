# Security

Kinetiq moves a machine. Anyone who can reach its web interface can jog the machine and start a job, so the question of who can reach it matters more than for an ordinary web app.

## How Kinetiq is exposed

- **Kinetiq has no login.** It is meant for one operator on the computer next to the machine.
- **It listens on `127.0.0.1` by default**, so only programs on that computer can connect.
- **Requests must use a loopback host name** (`localhost`, `127.0.0.1` or `[::1]`). The session endpoint and the HTTP APIs refuse any other `Host` header. This is a defence against DNS rebinding from a web page. It is not authentication: a program that can reach the port can send any header it likes.
- **The socket needs a session token**, which Kinetiq hands to any page loaded from a loopback host. The token is signed with a secret that Kinetiq generates on first start and keeps in `~/.kinetiqrc`.

## What to avoid

- **Do not set `KINETIQ_HOST` to `0.0.0.0` or a LAN address.** That offers machine control to the whole network with no login in front of it.
- **Do not put Kinetiq behind a public reverse proxy or port forward.**
- **Do not share `~/.kinetiqrc`.** It holds the session secret. The `events` list in that file runs shell commands, so treat the file like a script: do not copy one from a source you do not trust.

To use Kinetiq from another computer, tunnel to it instead of exposing it, for example `ssh -L 8000:127.0.0.1:8000 user@machine-pc`, and open `http://127.0.0.1:8000` on your side. Stay within sight of the machine while it moves.

## G-code files and macros

G-code lines may contain bracketed expressions (`[posx + 10]`) and `%var=` assignments, inherited from CNCjs. They are evaluated in a restricted sandbox on the computer that runs Kinetiq. The sandbox was hardened against known escapes ([docs/BACKEND_INTEGRATION.md](docs/BACKEND_INTEGRATION.md) §7.3), but a G-code file is still a program for your machine: only run files you made or checked.

## The controller's own interfaces

FluidNC can serve its own WebUI and Telnet over Wi-Fi. Those bypass Kinetiq completely, including its travel limits. Secure or disable them in the FluidNC configuration if you do not use them.

## Reporting a vulnerability

Please report security problems privately through GitHub: **Security → Report a vulnerability** on this repository. Do not open a public issue for something that lets a third party move a machine or run code. Include the version (commit), what an attacker needs, and what they gain.

This is a hobby project maintained in spare time; there is no guaranteed response time.
