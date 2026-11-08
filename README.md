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

Kinetiq listens on `http://127.0.0.1:8000`. Override with `KINETIQ_PORT` / `KINETIQ_HOST`. Configuration lives in `~/.kinetiqrc` (override with `KINETIQ_RC`).

## Documentation

See [`docs/`](docs): CNCjs analysis, backend integration, architecture and design system, API reference, implementation plan.
