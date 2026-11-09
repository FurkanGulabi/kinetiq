/**
 * Streams a loaded G-code program to the controller (was src/server/cnc/lib/Sender.js, CNCjs).
 *
 * Character-counting streaming only: a line is written while it fits in the controller's RX
 * buffer (`bufferSize`, Kinetiq uses 128 - 8), and the bytes are released again by `next()`
 * after each `ok` / `error` acknowledgement (the controller calls `ack()` then `next()`).
 * `toJSON()` is sent to the browser as `sender:status` (protocol.ts SenderStatus), so its keys,
 * key order and values must not change.
 */
/* eslint max-classes-per-file: 0 */
import events from 'events';
import type { HoldReason, SenderStatus } from '../protocol';

// Kinetiq: only character counting is used; CNCjs's send-response mode (type 0) was removed.
export const SP_TYPE_CHAR_COUNTING = 1;

/** The context given to `load()`; the dataFilter may mutate it while streaming. */
export type SenderContext = Record<string, unknown>;

/**
 * Handles each line before it is written. The returned value replaces the line; a falsy value
 * (e.g. '' or undefined) turns it into an empty line, which is counted as sent and acked at once.
 */
export type SenderDataFilter = (line: string, context: SenderContext) => string | null | undefined | void;

export interface SPCharCountingOptions {
  bufferSize?: number | string;
}

export type SPCharCountingCallback = (sp: SPCharCounting) => void;

export interface SenderOptions extends SPCharCountingOptions {
  dataFilter?: SenderDataFilter;
}

export interface SPCharCountingState {
  bufferSize: number;
  dataLength: number;
  queue: number[];
  line: string;
}

export interface SenderState {
  hold: boolean;
  // undefined after hold() without a reason (plain gcode:pause), see protocol.ts SenderStatus
  holdReason: HoldReason | null | undefined;
  name: string;
  gcode: string;
  context: SenderContext;
  lines: string[];
  total: number;
  sent: number;
  received: number;
  startTime: number;
  finishTime: number;
  elapsedTime: number;
  remainingTime: number;
}

const noop: SPCharCountingCallback = () => {};

// Kinetiq: exported (CNCjs kept it module-private) so Sender.sp has a nameable type.
export class SPCharCounting {
  callback: SPCharCountingCallback | null = null;

  state: SPCharCountingState = {
    bufferSize: 128, // Defaults to 128
    dataLength: 0,
    queue: [],
    line: ''
  };

  constructor(options: SPCharCountingOptions | SPCharCountingCallback, callback: SPCharCountingCallback = noop) {
    if (typeof options === 'function') {
      callback = options;
      options = {};
    }

    // bufferSize
    const bufferSize = Number(options.bufferSize);
    if (bufferSize && bufferSize > 0) {
      this.state.bufferSize = bufferSize;
    }

    if (typeof callback === 'function') {
      this.callback = callback;
    }
  }

  process(): void {
    this.callback && this.callback(this);
  }

  reset(): void {
    this.state.bufferSize = 128; // Defaults to 128
    this.state.dataLength = 0;
    this.state.queue = [];
    this.state.line = '';
  }

  clear(): void {
    this.state.dataLength = 0;
    this.state.queue = [];
    this.state.line = '';
  }

  get type(): typeof SP_TYPE_CHAR_COUNTING {
    return SP_TYPE_CHAR_COUNTING;
  }

  get bufferSize(): number {
    return this.state.bufferSize;
  }

  // Kinetiq: CNCjs declared `set bufferSize(bufferSize = 0)`; a setter cannot have a default in
  // TS, so undefined is mapped to 0 here. Both end in the `!bufferSize` early return.
  set bufferSize(value: number | string | undefined) {
    const bufferSize = Number(value === undefined ? 0 : value);
    if (!bufferSize) {
      return;
    }

    // The buffer size cannot be reduced below the size of the data within the buffer.
    this.state.bufferSize = Math.max(bufferSize, this.state.dataLength);
  }

  get dataLength(): number {
    return this.state.dataLength;
  }

  set dataLength(dataLength: number) {
    this.state.dataLength = dataLength;
  }

  get queue(): number[] {
    return this.state.queue;
  }

  set queue(queue: number[]) {
    this.state.queue = queue;
  }

  get line(): string {
    return this.state.line;
  }

  set line(line: string) {
    this.state.line = line;
  }
}

class Sender extends events.EventEmitter {
  // streaming protocol
  sp: SPCharCounting | null = null;

  state: SenderState = {
    hold: false,
    holdReason: null,
    name: '',
    gcode: '',
    context: {},
    lines: [],
    total: 0,
    sent: 0,
    received: 0,
    startTime: 0,
    finishTime: 0,
    elapsedTime: 0,
    remainingTime: 0
  };

  stateChanged = false;

  dataFilter: SenderDataFilter | null = null;

  // @param {number} [type] Streaming protocol type. Only SP_TYPE_CHAR_COUNTING (1) is supported.
  // @param {object} [options] The options object.
  // @param {number} [options.bufferSize] The buffer size used in character-counting streaming protocol. Defaults to 127.
  // @param {function} [options.dataFilter] A function to be used to handle the data. The function accepts two arguments: The data to be sent to the controller, and the context.
  constructor(type: number = SP_TYPE_CHAR_COUNTING, options: SenderOptions = {}) {
    super();

    if (typeof options.dataFilter === 'function') {
      this.dataFilter = options.dataFilter;
    }

    // character-counting
    if (type === SP_TYPE_CHAR_COUNTING) {
      this.sp = new SPCharCounting(options, (sp) => {
        // Release the bytes of the oldest line in the RX buffer (one call per ok/error)
        if (sp.queue.length > 0) {
          const lineLength = sp.queue.shift() as number;
          sp.dataLength -= lineLength;
        }

        while (!this.state.hold && (this.state.sent < this.state.total)) {
          // Remove leading and trailing whitespace from both ends of a string.
          // A line held back by the buffer check below stays in sp.line (already filtered) and
          // is retried on the next call. CNCjs quirk: it then goes through dataFilter a second time.
          sp.line = sp.line || this.state.lines[this.state.sent].trim();

          if (this.dataFilter) {
            sp.line = this.dataFilter(sp.line, this.state.context) || '';
          }

          // The newline character (\n) consumed the RX buffer space
          if ((sp.line.length > 0) && ((sp.dataLength + sp.line.length + 1) >= sp.bufferSize)) {
            break;
          }

          this.state.sent++;
          this.emit('change');

          if (sp.line.length === 0) {
            this.ack(); // ack empty line
            continue;
          }

          const line = sp.line + '\n';
          sp.line = '';
          sp.dataLength += line.length;
          sp.queue.push(line.length);
          this.emit('data', line, this.state.context);
        }
      });
    }

    this.on('change', () => {
      this.stateChanged = true;
    });
  }

  toJSON(): SenderStatus {
    return {
      // CNCjs quirk: throws when sp is null (unsupported type); never happens in Kinetiq.
      sp: this.sp!.type,
      hold: this.state.hold,
      holdReason: this.state.holdReason,
      name: this.state.name,
      context: this.state.context,
      size: this.state.gcode.length,
      total: this.state.total,
      sent: this.state.sent,
      received: this.state.received,
      startTime: this.state.startTime,
      finishTime: this.state.finishTime,
      elapsedTime: this.state.elapsedTime,
      remainingTime: this.state.remainingTime
    };
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

  // @return {boolean} Returns true on success, false otherwise.
  load(name: string, gcode: string = '', context: SenderContext = {}): boolean {
    if (typeof gcode !== 'string' || !gcode) {
      return false;
    }

    const lines = gcode.split('\n')
      .filter(line => (line.trim().length > 0));

    if (this.sp) {
      this.sp.clear();
    }
    this.state.hold = false;
    this.state.holdReason = null;
    this.state.name = name;
    this.state.gcode = gcode;
    this.state.context = context;
    this.state.lines = lines;
    this.state.total = this.state.lines.length;
    this.state.sent = 0;
    this.state.received = 0;
    this.state.startTime = 0;
    this.state.finishTime = 0;
    this.state.elapsedTime = 0;
    this.state.remainingTime = 0;

    this.emit('load', name, gcode, context);
    this.emit('change');

    return true;
  }

  unload(): void {
    if (this.sp) {
      this.sp.clear();
    }
    this.state.hold = false;
    this.state.holdReason = null;
    this.state.name = '';
    this.state.gcode = '';
    this.state.context = {};
    this.state.lines = [];
    this.state.total = 0;
    this.state.sent = 0;
    this.state.received = 0;
    this.state.startTime = 0;
    this.state.finishTime = 0;
    this.state.elapsedTime = 0;
    this.state.remainingTime = 0;

    this.emit('unload');
    this.emit('change');
  }

  // Tells the sender an acknowledgement has received.
  // @return {boolean} Returns true on success, false otherwise.
  ack(): boolean {
    if (!this.state.gcode) {
      return false;
    }

    if (this.state.received >= this.state.sent) {
      return false;
    }

    this.state.received++;
    this.emit('change');

    return true;
  }

  // Tells the sender to send more data.
  // @return {boolean} Returns true on success, false otherwise.
  next(): boolean {
    if (!this.state.gcode) {
      return false;
    }

    const now = new Date().getTime();

    if (this.state.total > 0 && this.state.sent === 0) {
      this.state.startTime = now;
      this.state.finishTime = 0;
      this.state.elapsedTime = 0;
      this.state.remainingTime = 0;
      this.emit('start', this.state.startTime);
      this.emit('change');
    }

    if (this.sp) {
      this.sp.process();
    }

    // Elapsed Time
    this.state.elapsedTime = now - this.state.startTime;

    // Make a 1 second delay before estimating the remaining time
    if (this.state.elapsedTime >= 1000 && this.state.received > 0) {
      const timePerCode = this.state.elapsedTime / this.state.received;
      this.state.remainingTime = (timePerCode * this.state.total - this.state.elapsedTime);
    }

    if (this.state.received >= this.state.total) {
      if (this.state.finishTime === 0) {
        // avoid issue 'end' multiple times
        this.state.finishTime = now;
        this.emit('end', this.state.finishTime);
        this.emit('change');
      }
    }

    return true;
  }

  // Rewinds the internal array pointer.
  // @return {boolean} Returns true on success, false otherwise.
  rewind(): boolean {
    if (!this.state.gcode) {
      return false;
    }

    if (this.sp) {
      this.sp.clear();
    }
    this.state.hold = false; // clear hold off state
    this.state.holdReason = null;
    this.state.sent = 0;
    this.state.received = 0;
    this.emit('change');

    return true;
  }

  // Checks if there are any state changes. It also clears the stateChanged flag.
  // @return {boolean} Returns true on state changes, false otherwise.
  peek(): boolean {
    const stateChanged = this.stateChanged;
    this.stateChanged = false;
    return stateChanged;
  }
}

export default Sender;
