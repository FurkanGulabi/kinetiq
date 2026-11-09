/**
 * The serial port connection to the controller
 * (was src/server/cnc/lib/SerialConnection.js, CNCjs 1.11.5).
 *
 * Wraps a `serialport` v10 SerialPort with a '\n' ReadlineParser and re-emits:
 *   'data'   one received line (a string without the '\n'; a trailing '\r' is kept)
 *   'open'   the port opened
 *   'close'  the port closed by itself (e.g. USB unplugged), with the disconnect error if any.
 *            Not emitted for close(): the listeners are removed before the port is closed.
 *   'error'  a port error
 * Every write() goes through `writeFilter` first (GrblController uses it to track `$13`).
 *
 * `port` is the raw SerialPort while open: GrblController sets DTR/RTS on it and the FluidNC
 * XModem upload (src/server/fluidnc/xmodem.ts) writes bytes to it directly, bypassing writeFilter.
 */
import { EventEmitter } from 'events';
import { SerialPort, SerialPortOpenOptions } from 'serialport';
import type { AutoDetectTypes } from '@serialport/bindings-cpp';
import { ReadlineParser } from '@serialport/parser-readline';

/** Called with every write() before it reaches the port; returns the data to send. */
export type SerialConnectionWriteFilter = (data: string, context?: unknown) => string;

export type SerialConnectionDataBits = 5 | 6 | 7 | 8;
export type SerialConnectionStopBits = 1 | 2;
export type SerialConnectionParity = 'none' | 'even' | 'mark' | 'odd' | 'space';

/**
 * Constructor options. Everything except `writeFilter` is merged over the defaults below and
 * passed on to SerialPort, unknown keys included. The constructor validates at run time, so a
 * wrong value throws a TypeError rather than being caught here.
 */
export interface SerialConnectionOptions {
  /** Required (any truthy value passes the check). */
  path?: string;
  /** Must be a number (default 115200). */
  baudRate?: number;
  dataBits?: SerialConnectionDataBits;
  stopBits?: SerialConnectionStopBits;
  parity?: SerialConnectionParity;
  /**
   * Must be booleans. An explicit `undefined` overrides the default `false` and throws
   * (CNCjs quirk: Object.assign copies undefined), which is why SocketEngine passes `!!rtscts`.
   */
  rtscts?: boolean;
  xon?: boolean;
  xoff?: boolean;
  xany?: boolean;
  writeFilter?: SerialConnectionWriteFilter;
  [option: string]: unknown;
}

/** The validated settings (`connection.settings`, read-only). */
export interface SerialConnectionSettings {
  path: string;
  baudRate: number;
  dataBits: SerialConnectionDataBits;
  stopBits: SerialConnectionStopBits;
  parity: SerialConnectionParity;
  rtscts: boolean;
  xon: boolean;
  xoff: boolean;
  xany: boolean;
  [option: string]: unknown;
}

export type SerialConnectionCallback = (err: Error | null) => void;

// Validation
const DATABITS = Object.freeze([5, 6, 7, 8]);
const STOPBITS = Object.freeze([1, 2]);
const PARITY = Object.freeze(['none', 'even', 'mark', 'odd', 'space']);
const FLOWCONTROLS = Object.freeze(['rtscts', 'xon', 'xoff', 'xany']);

const defaultSettings = Object.freeze({
  baudRate: 115200,
  dataBits: 8,
  stopBits: 1,
  parity: 'none',
  rtscts: false,
  xon: false,
  xoff: false,
  xany: false
});

const toIdent = (options?: { path?: unknown } | null): string => {
  // Only the path option is required for generating the ident property
  const { path } = { ...options };
  return JSON.stringify({ type: 'serial', path: path });
};

class SerialConnection extends EventEmitter {
  type = 'serial';

  // Readline parser
  parser: ReadlineParser | null = null;

  // SerialPort
  port: SerialPort | null = null;

  writeFilter: SerialConnectionWriteFilter = (data) => data;

  eventListener = {
    data: (data: string): void => {
      this.emit('data', data);
    },
    open: (): void => {
      this.emit('open');
    },
    close: (err?: Error | null): void => {
      this.emit('close', err);
    },
    error: (err: Error): void => {
      this.emit('error', err);
    }
  };

  // Defined in the constructor as a non-writable, enumerable own property (as in CNCjs).
  declare readonly settings: SerialConnectionSettings;

  constructor(options?: SerialConnectionOptions) {
    super();

    const { writeFilter, ...rest } = { ...options };

    if (writeFilter) {
      if (typeof writeFilter !== 'function') {
        throw new TypeError(`"writeFilter" must be a function: ${writeFilter}`);
      }

      this.writeFilter = writeFilter;
    }

    const settings: Record<string, unknown> = Object.assign({}, defaultSettings, rest);

    if (settings.port) {
      throw new TypeError('"port" is an unknown option, did you mean "path"?');
    }

    if (!settings.path) {
      throw new TypeError(`"path" is not defined: ${settings.path}`);
    }

    if (settings.baudrate) {
      throw new TypeError('"baudrate" is an unknown option, did you mean "baudRate"?');
    }

    if (typeof settings.baudRate !== 'number') {
      throw new TypeError(`"baudRate" must be a number: ${settings.baudRate}`);
    }

    if ((DATABITS as readonly unknown[]).indexOf(settings.dataBits) < 0) {
      throw new TypeError(`"databits" is invalid: ${settings.dataBits}`);
    }

    if ((STOPBITS as readonly unknown[]).indexOf(settings.stopBits) < 0) {
      // CNCjs quirk: prints `settings.stopbits` (lowercase), which is always undefined.
      throw new TypeError(`"stopbits" is invalid: ${settings.stopbits}`);
    }

    if ((PARITY as readonly unknown[]).indexOf(settings.parity) < 0) {
      throw new TypeError(`"parity" is invalid: ${settings.parity}`);
    }

    FLOWCONTROLS.forEach((control) => {
      if (typeof settings[control] !== 'boolean') {
        throw new TypeError(`"${control}" is not boolean: ${settings[control]}`);
      }
    });

    Object.defineProperties(this, {
      settings: {
        enumerable: true,
        value: settings,
        writable: false
      }
    });
  }

  get ident(): string {
    return toIdent(this.settings);
  }

  // CNCjs quirk: null (not false) while there is no port.
  get isOpen(): boolean | null {
    return this.port && this.port.isOpen;
  }

  get isClose(): boolean {
    return !this.isOpen;
  }

  // @param {function} callback The error-first callback.
  open(callback: SerialConnectionCallback): void {
    if (this.port) {
      const err = new Error(`Cannot open serial port "${this.settings.path}"`);
      callback(err);
      return;
    }

    // The settings were validated above; SerialPort checks them again and throws on bad values.
    this.port = new SerialPort({
      ...this.settings,
      autoOpen: false
    } as SerialPortOpenOptions<AutoDetectTypes>);
    this.port.on('open', this.eventListener.open);
    this.port.on('close', this.eventListener.close);
    this.port.on('error', this.eventListener.error);

    this.parser = this.port.pipe(new ReadlineParser({ delimiter: '\n' }));
    this.parser.on('data', this.eventListener.data);

    this.port.open(callback);
  }

  // @param {function} callback The error-first callback.
  close(callback?: SerialConnectionCallback): void {
    if (!this.port) {
      const err = new Error(`Cannot close serial port "${this.settings.path}"`);
      callback && callback(err);
      return;
    }

    this.port.removeListener('open', this.eventListener.open);
    this.port.removeListener('close', this.eventListener.close);
    this.port.removeListener('error', this.eventListener.error);
    // `parser` is set together with `port` in open().
    this.parser!.removeListener('data', this.eventListener.data);

    this.port.close(callback);

    this.port = null;
    this.parser = null;
  }

  write(data: string, context?: unknown): void {
    if (!this.port) {
      return;
    }

    data = this.writeFilter(data, context);

    this.port.write(data);
  }
}

export { toIdent };
export default SerialConnection;
