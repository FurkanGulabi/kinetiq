/**
 * The rc file store (was src/server/cnc/services/configstore/index.js, CNCjs).
 *
 * Holds the parsed rc file (~/.kinetiqrc, or KINETIQ_RC), watches it with fs.watchFile() and
 * reloads it when its mtime changes ('change' event). set()/unset() reload the file first, then
 * write the whole config back as 4-space-indented JSON. The default export is the process-wide
 * singleton; there must be only one instance, because several modules share its state.
 *
 * SECURITY (Kinetiq): the rc file's `events` entries are run as shell commands by
 * events/TaskRunner.ts (via events/EventTrigger.ts). Only the machine owner may write them:
 * never set `events` (or any other value later handed to taskRunner.run()) from socket, HTTP or
 * other frontend input. See src/server/cnc/README.md, "Security rule: shell commands".
 */
import events from 'events';
import fs from 'fs';
import _ from 'lodash';
import chalk from 'chalk';
import logger from '../logger';
import x from '../util/jsonStringify';

const log = logger('service:configstore');

/** The parsed rc file. `state` is always present after reload(). */
export type ConfigData = Record<string, unknown>;

/** A key for get/set/has/unset: a dotted / bracketed path string or a path array (lodash). */
export type ConfigKey = _.PropertyPath;

export interface ConfigSetOptions {
  silent?: boolean;
}

const defaultState = { // default state
  allowAnonymousUsageDataCollection: false,
  checkForUpdates: true,
  controller: {
    exception: {
      ignoreErrors: false
    }
  }
};

export class ConfigStore extends events.EventEmitter {
    file = '';

    config: ConfigData = {};

    watcher: fs.StatWatcher | null = null;

    // @param {string} file The path to a filename.
    // @return {object} The config object.
    load(file: string): ConfigData {
      this.file = file;
      this.reload();
      this.emit('load', this.config); // emit load event

      if (this.watcher) {
        // Stop watching for changes
        // Note (carried over from CNCjs): fs.StatWatcher has no close() on current Node, so a second
        // load() throws a TypeError here. backend.ts calls load() exactly once.
        (this.watcher as unknown as { close(): void }).close();
        this.watcher = null;
      }

      try {
        if (!fs.existsSync(this.file)) {
          const content = JSON.stringify({});
          fs.writeFileSync(this.file, content, 'utf8');
        }

        this.watcher = fs.watchFile(this.file, (curr, prev) => {
          log.debug(`fs.watchFile(curr=${x(curr)}, prev=${x(prev)})`);

          if (curr?.mtimeMs !== prev?.mtimeMs) {
            log.info(`"${this.file}" has been changed`);
            const ok = this.reload();
            ok && this.emit('change', this.config); // it is ok to emit change event
          }
        });
      } catch (err) {
        log.error(err);
        this.emit('error', err); // emit error event
      }

      return this.config;
    }

    reload(): boolean {
      try {
        if (fs.existsSync(this.file)) {
          this.config = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        }
      } catch (err) {
        (err as { fileName?: string }).fileName = this.file;
        log.error(`Unable to load data from ${chalk.yellow(JSON.stringify(this.file))}: err=${err}`);
        this.emit('error', err); // emit error event
        return false;
      }

      if (!_.isPlainObject(this.config)) {
        log.error(`"${this.file}" does not contain valid JSON`);
        this.config = {};
      }

      this.config.state = {
        ...defaultState,
        // Whatever the rc file holds is spread as-is (object spread ignores null/undefined/numbers).
        ...(this.config.state as Record<string, unknown> | undefined)
      };

      return true;
    }

    sync(): boolean {
      try {
        const content = JSON.stringify(this.config, null, 4);
        fs.writeFileSync(this.file, content, 'utf8');
      } catch (err) {
        log.error(`Unable to write data to "${this.file}"`);
        this.emit('error', err); // emit error event
        return false;
      }

      return true;
    }

    has(key: ConfigKey): boolean {
      return _.has(this.config, key);
    }

    get(): ConfigData;
    get<T = unknown>(key: ConfigKey | undefined, defaultValue?: T): T;
    get<T = unknown>(key?: ConfigKey, defaultValue?: T): T | ConfigData {
      if (!this.config) {
        this.reload();
      }

      return (key !== undefined)
        ? _.get(this.config, key, defaultValue) as T
        : this.config;
    }

    set(key: ConfigKey | undefined, value: unknown, options?: ConfigSetOptions): void {
      const { silent = false } = { ...options };

      if (key === undefined) {
        return;
      }

      const ok = this.reload(); // reload before making changes
      _.set(this.config, key, value);
      ok && !silent && this.sync(); // it is ok to write
    }

    unset(key: ConfigKey | undefined): void {
      if (key === undefined) {
        return;
      }

      const ok = this.reload(); // reload before making changes
      _.unset(this.config, key);
      ok && this.sync(); // it is ok to write
    }
}

const configstore = new ConfigStore();

export default configstore;
