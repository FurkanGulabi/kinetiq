/// <reference path="../../types/spawn-default-shell.d.ts" />
/**
 * Shell runner for the rc file's `events` (was src/server/cnc/services/taskrunner/TaskRunner.js
 * + index.js, CNCjs). Emits 'start' (taskId), 'finish' (taskId, code) and 'error' (taskId, err).
 * The default export is the process-wide singleton (SocketEngine listens to its events).
 *
 * SECURITY RULE: commands passed to run() come ONLY from the rc file's `events` entries
 * (via events/EventTrigger.ts), never from socket, HTTP or other frontend input.
 * See docs/BACKEND_INTEGRATION.md §7.2, "Security rule: shell commands".
 */
import events from 'events';
import type { SpawnOptions } from 'child_process';
import defaultShell from 'spawn-default-shell';
import shortid from 'shortid';
import logger from '../logger';

const log = logger('service:taskrunner');

export class TaskRunner extends events.EventEmitter {
    tasks: string[] = [];

    run(command: string, options?: SpawnOptions): string;
    run(command: string, title: string, options?: SpawnOptions): string;
    run(command: string, title?: string | SpawnOptions | null, options?: SpawnOptions | null): string {
      if (options === undefined && typeof title === 'object') {
        options = title;
        title = '';
      }

      const taskId = shortid.generate(); // task id
      const child = defaultShell.spawn(command, {
        detached: true,
        ...options
      });
      child.unref();

      this.tasks.push(taskId);
      this.emit('start', taskId);

      // stdio is piped (the default), so stdout/stderr are set.
      child.stdout!.on('data', (data) => {
        process.stdout.write(`PID:${child.pid}> ${data}`);
      });
      child.stderr!.on('data', (data) => {
        process.stderr.write(`PID:${child.pid}> ${data}`);
      });
      child.on('error', (err) => {
        // Listen for error event can prevent from throwing an unhandled exception
        log.error(`Failed to start a child process: err=${JSON.stringify(err)}`);

        this.tasks = this.tasks.filter(id => id !== taskId); // was lodash without()
        this.emit('error', taskId, err);
      });
      // The 'exit' event is emitted after the child process ends.
      // Note that the 'exit' event may or may not fire after an error has occurred.
      // It is important to guard against accidentally invoking handler functions multiple times.
      child.on('exit', (code) => {
        if (this.contains(taskId)) {
          this.tasks = this.tasks.filter(id => id !== taskId); // was lodash without()
          this.emit('finish', taskId, code);
        }
      });

      return taskId;
    }

    contains(taskId: string): boolean {
      return this.tasks.indexOf(taskId) >= 0;
    }
}

// SECURITY (Kinetiq): taskRunner.run() spawns a shell. Its only callers are the EventTrigger
// callbacks in SocketEngine and GrblController, and the commands they pass come from the `events`
// entries of the rc file (~/.kinetiqrc), which only the machine owner can edit.
// Never pass socket, HTTP or other frontend input to run(), and never add an API that writes
// `events` (or any other value later handed to run()) into the config. The future Automation UI
// must use a fixed allow-list of server-defined actions instead. See docs/BACKEND_INTEGRATION.md §7.2.
const taskRunner = new TaskRunner();

export default taskRunner;
