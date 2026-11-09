# Kinetiq

**Advanced Motion Control.** A modern control interface for GRBL-compatible CNC machines (first target: FluidNC on ESP32). It is one Next.js application with a built-in CNC backend (the CNCjs GRBL server code, carried into [`src/server/cnc`](src/server/cnc)) for serial communication, streaming and safety logic.

> **Safety:** Kinetiq's Hold and Reset are software commands. They do **not** replace a hard-wired emergency-stop circuit.

## Prerequisites

- Node.js 20 or newer

Install dependencies:

```bash
npm install
```

## Run

```bash
npm run dev
```

Production:

```bash
npm run build && npm start
```

Kinetiq listens on `http://127.0.0.1:8000`. Override with `KINETIQ_PORT` / `KINETIQ_HOST`. Configuration lives in `~/.kinetiqrc` (override with `KINETIQ_RC`). Uploaded jobs are kept in `~/.kinetiq/jobs` and FluidNC config backups in `~/.kinetiq/config-backups` (override with `KINETIQ_JOBS_DIR` / `KINETIQ_CONFIG_BACKUP_DIR`). `KINETIQ_LOG_LEVEL` sets the backend log level (default `info`).

Type-check app and server with `npm run typecheck`.

No machine at hand? Run a fake FluidNC controller on a pseudo-terminal (macOS / Linux, Python 3):

```bash
npm run fake-controller   # terminal 1
npm run dev:fake          # terminal 2, then pick "kinetiq-fake0" and Connect
```

See [`docs/FAKE_CONTROLLER.md`](docs/FAKE_CONTROLLER.md).

## Documentation

See [`docs/`](docs): CNCjs analysis, backend integration, architecture and design system, API reference, implementation plan, bed leveling, machine settings editor, fake controller, and hardware session logs ([`docs/hardware/`](docs/hardware)).
