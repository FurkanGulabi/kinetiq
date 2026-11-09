/**
 * Queues manual lines (console, jog, macros) for the controller (was src/server/cnc/lib/Feeder.js, CNCjs).
 *
 * One line is written at a time: `next()` emits 'data' for the next queued line and marks the
 * Feeder pending until the controller's `ok` / `error` calls `next()` again.
 * `toJSON()` is sent to the browser as `feeder:status` (protocol.ts FeederStatus), so its keys,
 * key order and values must not change.
 */
import events from 'events';
import type { FeederStatus, HoldReason } from '../protocol';

/** The context given to `feed()`; handed to the dataFilter and the 'data' event. */
export type FeederContext = Record<string, unknown>;

/**
 * Handles each line before it is written. The returned value replaces the line; a falsy value
 * (e.g. '' or undefined) drops the line and the next queued one is tried.
 */
export type FeederDataFilter = (command: string, context: FeederContext) => string | null | undefined | void;

export interface FeederOptions {
  dataFilter?: FeederDataFilter;
}

export interface FeederQueueItem {
  command: string;
  context: FeederContext;
}

export interface FeederState {
  hold: boolean;
  // CNCjs quirk: hold() stores whatever it is given, so this is undefined after hold() without a reason.
  holdReason: HoldReason | null | undefined;
  queue: FeederQueueItem[];
  pending: boolean;
  changed: boolean;
}

// Kinetiq: plain-TS copy of ensure-type's ensureArray(value) (default value []): null/undefined
// become [], an array is returned as is, anything else is wrapped by [].concat(value).
const ensureArray = <T>(value: T | T[] | null | undefined): T[] => {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : ([] as T[]).concat(value);
};

class Feeder extends events.EventEmitter {
  state: FeederState = {
    hold: false,
    holdReason: null,
    queue: [],
    pending: false,
    changed: false,
  };

  dataFilter: FeederDataFilter | null = null;

  // @param {object} [options] The options object.
  // @param {function} [options.dataFilter] A function to be used to handle the data. The function accepts two arguments: The data to be sent to the controller, and the context.
  constructor(options: FeederOptions) {
    super();

    if (typeof options.dataFilter === 'function') {
      this.dataFilter = options.dataFilter;
    }

    this.on('change', () => {
      this.state.changed = true;
    });
  }

  toJSON(): FeederStatus {
    return {
      hold: this.state.hold,
      // CNCjs quirk: undefined after hold() without a reason (protocol.ts FeederStatus says
      // `HoldReason | null`; the key is then dropped from the JSON payload).
      holdReason: this.state.holdReason as HoldReason | null,
      queue: this.state.queue.length,
      pending: this.state.pending,
      changed: this.state.changed,
    };
  }

  // @param {string[]} data The data to be added to the queue.
  // @param {object} [context] The context associated with the data.
  feed(data: string | string[] | null | undefined, context: FeederContext = {}): void {
    // Clear pending state when the feeder queue is empty
    if (this.state.queue.length === 0) {
      this.state.pending = false;
    }

    const commands = ensureArray(data);
    if (commands.length > 0) {
      const queueItems = commands.map(command => ({
        command,
        context,
      }));
      this.state.queue = this.state.queue.concat(queueItems);
      this.emit('change');
    }
  }

  hold(reason?: HoldReason | null): void {
    if (this.state.hold) {
      return;
    }
    this.state.hold = true;
    this.state.holdReason = reason;
    this.emit('hold');
    this.emit('change');
  }

  unhold(): void {
    if (!this.state.hold) {
      return;
    }
    this.state.hold = false;
    this.state.holdReason = null;
    this.emit('unhold');
    this.emit('change');
  }

  clear(): void {
    this.state.queue = [];
    this.state.pending = false;
    this.emit('change');
  }

  reset(): void {
    this.state.hold = false;
    this.state.holdReason = null;
    this.state.queue = [];
    this.state.pending = false;
    this.emit('change');
  }

  size(): number {
    return this.state.queue.length;
  }

  next(): boolean {
    while (!this.state.hold && this.state.queue.length > 0) {
      let { command, context } = this.state.queue.shift() as FeederQueueItem;

      if (this.dataFilter) {
        command = this.dataFilter(command, context) || '';
        if (!command) { // Ignore blank lines
          continue;
        }
      }

      this.state.pending = true;
      this.emit('data', command, context);
      this.emit('change');
      break;
    }

    // Clear pending state when the feeder queue is empty
    if (this.state.queue.length === 0) {
      this.state.pending = false;
    }

    return this.state.pending;
  }

  isPending(): boolean {
    return this.state.pending;
  }

  // Returns true if any state have changes
  peek(): boolean {
    const changed = this.state.changed;
    this.state.changed = false;
    return changed;
  }
}

export default Feeder;
