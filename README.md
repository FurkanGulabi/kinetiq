# Kinetiq

**Advanced Motion Control.** A modern control interface for GRBL-compatible CNC machines (first target: FluidNC on ESP32). It is one Next.js application that embeds the unmodified CNCjs backend for serial communication, streaming and safety logic.

> **Safety:** Kinetiq's Hold and Reset are software commands. They do **not** replace a hard-wired emergency-stop circuit.

## Prerequisites

- Node.js 20 or newer
- The CNCjs server build from `../CNCJS-fork`, made once and again after each fork update:

```bash
cd ../CNCJS-fork && ELECTRON_SKIP_BINARY_DOWNLOAD=1 yarn install
mkdir -p dist/cncjs && cp -af src/package.json dist/cncjs/
NODE_ENV=production yarn babel -d dist/cncjs/server src/server --ignore "src/server/**/__tests__/**"
cp -af src/server/i18n src/server/views dist/cncjs/server/
```

Then install Kinetiq. `.npmrc` sets `install-links=true`, so the build is copied into `node_modules`; re-run this after rebuilding the fork:

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
