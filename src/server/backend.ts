/**
 * Kinetiq CNC backend bootstrap.
 *
 * The backend is the CNCjs GRBL server code, being rewritten into TypeScript in phases
 * (docs/BACKEND_REWRITE_PLAN.md): CNCEngine is still JavaScript in src/server/cnc/; the
 * controller (src/server/controller/), Sender/Feeder/Workflow, SerialConnection and the
 * config/store/logger services are TypeScript. No Marlin/Smoothie/TinyG controllers, no Express app.
 * This file does what CNCjs's server/index.js did for it: load the rc file and the secret.
 *
 * SERVER-ONLY: never import this file from src/app, src/components or src/lib.
 * See docs/BACKEND_INTEGRATION.md §5.1.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type http from 'node:http';

export interface CNCEngineInstance {
  io: { close(): void } | null;
  start(server: http.Server, controller?: string): void;
  stop(): void;
}

export interface CNCSettings {
  secret: string;
  rcfile: string;
  accessTokenLifetime: string;
}

interface ConfigStore {
  load(file: string): unknown;
  get<T = unknown>(key: string, defaultValue?: T): T;
  set(key: string, value: unknown): void;
}

/** The parts of the controller (src/server/controller/GrblController.ts) used on shutdown. */
interface CNCControllerLike {
  /** null (falsy) when there is no connection (CNCjs quirk). */
  isOpen(): boolean | null;
  close(callback: (err?: unknown) => void): void;
  destroy(): void;
  workflow?: { state: string } | null;
}

interface ImmutableStore {
  get<T = unknown>(key: string, defaultValue?: T): T;
  unset(key: string): void;
}

export interface CNCBackend {
  settings: CNCSettings;
  engine: CNCEngineInstance;
  store: ImmutableStore;
}

/**
 * Loads config + secret and constructs (but does not start) the CNC engine.
 * Must run after process.env.NODE_ENV is set: the settings module reads it on first require.
 */
export function loadBackend(): CNCBackend {
  // Required lazily so NODE_ENV (set in server.ts) is in effect when these modules evaluate.
  const settings: CNCSettings = require('./config/settings').default;
  const config: ConfigStore = require('./config/ConfigStore').default;
  const { setLevel } = require('./logger') as { setLevel(level: string): void };
  const store: ImmutableStore = require('./store').default;
  const CNCEngine: new () => CNCEngineInstance = require('./cnc/services/cncengine/CNCEngine').default;

  setLevel(process.env.KINETIQ_LOG_LEVEL || 'info');

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

/** Closes every open serial port through the controller API (used on shutdown). */
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
