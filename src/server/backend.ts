/**
 * Kinetiq CNC backend bootstrap.
 *
 * The backend is the CNCjs 1.11.5 GRBL server code, rewritten into TypeScript in phases
 * (docs/BACKEND_REWRITE_PLAN.md): the Socket.IO engine (engine/SocketEngine.ts), the controller
 * (controller/), Sender/Feeder/Workflow, SerialConnection and the config/store/logger services.
 * No Marlin/Smoothie/TinyG controllers, no Express app.
 * This file does what CNCjs's server/index.js did for it: load the rc file and the secret.
 *
 * SERVER-ONLY: never import this file from src/app, src/components or src/lib.
 * See docs/BACKEND_INTEGRATION.md §5.1.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Type-only imports: erased at compile time, so they load nothing (see loadBackend()).
import type { Settings } from './config/settings';
import type { ImmutableStore } from './store';
import type GrblController from './controller/GrblController';
import type SocketEngine from './engine/SocketEngine';

/** The backend settings object (config/settings.ts); `rcfile` and `secret` are set by loadBackend(). */
export type CNCSettings = Settings;

export interface CNCBackend {
  settings: CNCSettings;
  engine: SocketEngine;
  store: ImmutableStore;
}

/**
 * Loads config + secret and constructs (but does not start) the CNC engine.
 * Must run after process.env.NODE_ENV is set: the settings module reads it when it first evaluates.
 */
export async function loadBackend(): Promise<CNCBackend> {
  // Imported lazily (dynamic import(), compiled to require() in the CommonJS server build) so the
  // NODE_ENV set in server.ts is in effect when these modules evaluate. A static import would
  // evaluate config/settings.ts (directly, and through the engine, logger and session imports) as
  // soon as this file loads. Same order as before: settings, config, logger, store, engine.
  const { default: settings } = await import('./config/settings');
  const { default: config } = await import('./config/ConfigStore');
  const { setLevel } = await import('./logger');
  const { default: store } = await import('./store');
  const { default: SocketEngine } = await import('./engine/SocketEngine');

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

  return { settings, engine: new SocketEngine(), store };
}

/** Closes every open serial port through the controller API (used on shutdown). */
export function closeAllControllers(store: ImmutableStore, log: (msg: string) => void): Promise<void> {
  const controllers = store.get<Record<string, GrblController | undefined>>('controllers', {});
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
