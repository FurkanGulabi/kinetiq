/**
 * Kinetiq — single-process custom server.
 *
 *   http.Server (127.0.0.1:8000)
 *    ├── GET /api/kinetiq/session → JWT for the Socket.IO handshake
 *    ├── /api/kinetiq/jobs/*     → job library (uploaded G-code + recent runs)
 *    ├── /socket.io/*            → CNCEngine (src/server/cnc, Socket.IO 2.2)
 *    └── everything else         → Next.js
 *
 * See docs/BACKEND_INTEGRATION.md §5 for the boot order and shutdown behaviour.
 */
import http from 'node:http';
import { parse } from 'node:url';

const dev = process.env.NODE_ENV !== 'production';
// The backend evaluates its settings on first require, so NODE_ENV must be set before loadBackend().
(process.env as Record<string, string>).NODE_ENV = dev ? 'development' : 'production';

const hostname = process.env.KINETIQ_HOST || '127.0.0.1';
const port = Number(process.env.KINETIQ_PORT || process.env.PORT || 8000);

const log = (msg: string) => console.log(`[kinetiq] ${msg}`);

async function main() {
  // Imported lazily so NODE_ENV above is in effect when the backend loads.
  const { loadBackend, closeAllControllers } = await import('./src/server/backend');
  const { handleSession, SESSION_PATH } = await import('./src/server/session');
  const { handleJobs, JOBS_PATH } = await import('./src/server/jobs');
  const next = (await import('next')).default;

  const { settings, engine, store } = loadBackend();
  log(`CNC backend loaded (config: ${settings.rcfile})`);

  let handle: ((req: http.IncomingMessage, res: http.ServerResponse) => Promise<void>) | null = null;

  const server = http.createServer((req, res) => {
    const url = parse(req.url || '/', true);

    if (url.pathname === SESSION_PATH) {
      handleSession(req, res, settings);
      return;
    }
    if (url.pathname === JOBS_PATH || url.pathname?.startsWith(`${JOBS_PATH}/`)) {
      void handleJobs(req, res, settings);
      return;
    }
    // Socket.IO requests never reach this handler: Engine.IO (attached by CNCEngine) wraps the
    // server's 'request' listeners and answers /socket.io/* itself.
    if (!handle) {
      res.writeHead(503).end('Kinetiq is starting');
      return;
    }
    handle(req, res).catch((err) => {
      console.error(err);
      if (!res.headersSent) {
        res.writeHead(500).end('Internal Server Error');
      }
    });
  });

  // Only the GRBL controller is registered (FluidNC speaks GRBL-compatible serial).
  engine.start(server, 'Grbl');

  const app = next({ dev, hostname, port, httpServer: server });
  await app.prepare();
  const requestHandler = app.getRequestHandler();
  handle = (req, res) => requestHandler(req, res);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, hostname, () => resolve());
  });
  log(`Kinetiq ready on http://${hostname}:${port} (${dev ? 'development' : 'production'})`);

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    log(`${signal} received — closing serial ports`);
    server.close();
    await closeAllControllers(store, log);
    engine.stop();
    await app.close?.();
    log('Shutdown complete');
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(`[kinetiq] Failed to start:\n${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
