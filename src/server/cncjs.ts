/**
 * Kinetiq ↔ CNCjs bootstrap.
 *
 * Loads the *unmodified* CNCjs server build (`cncjs-app`, built from CNCJS-fork) and prepares
 * the process-wide singletons CNCEngine depends on. This replaces the ~20 lines of
 * CNCJS-fork/src/server/index.js (config load + secret) that Kinetiq needs.
 *
 * SERVER-ONLY: never import this file from src/app, src/components or src/lib.
 * See docs/BACKEND_INTEGRATION.md §5.1.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

const CNCJS_SERVER_DIR = (() => {
  try {
    return path.dirname(require.resolve('cncjs-app/server/index.js'));
  } catch {
    return null;
  }
})();

export interface CNCEngineInstance {
  io: { close(): void } | null;
  start(server: http.Server, controller?: string): void;
  stop(): void;
}

export interface CNCSettings {
  secret: string;
  rcfile: string;
  accessTokenLifetime: string;
  version: string;
}

interface ConfigStore {
  load(file: string): unknown;
  get<T = unknown>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): void;
}

interface CNCControllerLike {
  isOpen(): boolean;
  close(callback: (err?: unknown) => void): void;
  destroy(): void;
  workflow?: { state: string } | null;
}

interface ImmutableStore {
  get<T = unknown>(key: string, defaultValue?: T): T;
  unset(key: string): void;
}

export interface CNCjsBackend {
  settings: CNCSettings;
  engine: CNCEngineInstance;
  store: ImmutableStore;
}

/** Fails fast with instructions if the CNCjs server build is missing. */
function assertBuildPresent(): string {
  if (!CNCJS_SERVER_DIR || !fs.existsSync(path.join(CNCJS_SERVER_DIR, 'services/cncengine/CNCEngine.js'))) {
    throw new Error(
      [
        'The CNCjs server build was not found (package "cncjs-app").',
        'Build it from the fork, then reinstall Kinetiq dependencies:',
        '  cd ../CNCJS-fork && yarn install',
        '  mkdir -p dist/cncjs && cp -af src/package.json dist/cncjs/',
        '  NODE_ENV=production yarn babel -d dist/cncjs/server src/server --ignore "src/server/**/__tests__/**"',
        '  cp -af src/server/i18n src/server/views dist/cncjs/server/',
        '  cd ../new-cnc-app && npm install',
      ].join('\n'),
    );
  }
  return CNCJS_SERVER_DIR;
}

/**
 * Loads config + secret and constructs (but does not start) the CNC engine.
 * Must run after process.env.NODE_ENV is set: CNCjs evaluates its settings on first require.
 */
export function loadCNCjs(): CNCjsBackend {
  assertBuildPresent();

  // The CNCjs build is Babel output that references the global `regeneratorRuntime`
  // (CNCjs's own server-cli.js loads it the same way).
  require('regenerator-runtime/runtime');

  const settings: CNCSettings = require('cncjs-app/server/config/settings').default;
  const config: ConfigStore = require('cncjs-app/server/services/configstore').default;
  const logger = require('cncjs-app/server/lib/logger');
  const store: ImmutableStore = require('cncjs-app/server/store').default;
  const CNCEngine: new () => CNCEngineInstance =
    require('cncjs-app/server/services/cncengine/CNCEngine').default;

  logger.setLevel(process.env.KINETIQ_LOG_LEVEL || 'info');

  // Kinetiq keeps its own rc file so it never mixes configuration with an installed CNCjs (~/.cncrc).
  const rcfile = path.resolve(process.env.KINETIQ_RC || path.join(os.homedir(), '.kinetiqrc'));
  if (!fs.existsSync(rcfile)) {
    fs.writeFileSync(rcfile, '{}\n', { mode: 0o600 });
  }
  config.load(rcfile);
  settings.rcfile = rcfile;

  if (!config.get<string>('secret')) {
    config.set('secret', crypto.randomBytes(32).toString('hex'));
  }
  settings.secret = config.get<string>('secret');

  return { settings, engine: new CNCEngine(), store };
}

/** Closes every open serial port through the CNCjs controller API (used on shutdown). */
export function closeAllControllers(store: ImmutableStore, log: (msg: string) => void): Promise<void> {
  const controllers = store.get<Record<string, CNCControllerLike | undefined>>('controllers', {});
  const tasks = Object.entries(controllers).map(([port, controller]) => new Promise<void>((resolve) => {
    if (!controller) {
      resolve();
      return;
    }
    const workflow = controller.workflow?.state;
    if (workflow && workflow !== 'idle') {
      log(`WARNING: closing "${port}" while a job is ${workflow}. The controller will run out moves it has already buffered.`);
    }
    if (!controller.isOpen()) {
      resolve();
      return;
    }
    controller.close(() => {
      store.unset(`controllers[${JSON.stringify(port)}]`);
      controller.destroy();
      resolve();
    });
  }));
  return Promise.all(tasks).then(() => undefined);
}
