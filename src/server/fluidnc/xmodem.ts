/**
 * XModem-1K (CRC16) sender for uploading a file to FluidNC over the serial port.
 *
 * Written from FluidNC's reference implementation (breiler/fluid-installer src/utils/xmodem/xmodem.ts)
 * and checked against the v4.0.1 receiver (FluidNC/src/xmodem.cpp):
 *   - after `$Xmodem/Receive=<file>` the receiver sends 'C' (CRC mode) about every 2 s, 16 times
 *   - each block is STX, n, 255-n, 1024 data bytes, CRC16 big-endian; the receiver ACKs or NAKs
 *   - the last block is padded with Ctrl-Z, which the receiver strips from the final block only
 *   - EOT ends the transfer; the receiver ACKs, then prints "Received N bytes" and `ok`
 *   - CAN from the receiver means it gave up (for example, the file system is full)
 *
 * The caller must hold exclusive use of the port (no status polling) while this runs.
 *
 * SERVER-ONLY. See docs/SETTINGS_EDITOR.md §3.2.
 */
import type { EventEmitter } from 'node:events';

const STX = 0x02;
const EOT = 0x04;
const ACK = 0x06;
const LF = 0x0a;
const NAK = 0x15;
const CAN = 0x18;
const CTRL_Z = 0x1a;
const CRC_MODE = 0x43; // 'C'

const BLOCK = 1024;
const MAX_BLOCK_RETRIES = 5;

/** The raw serial port (serialport's SerialPort): a duplex stream with write(). */
export interface RawPort extends EventEmitter {
  write(data: Buffer, callback?: (err?: Error | null) => void): boolean;
  drain?(callback: (err?: Error | null) => void): void;
}

export function crc16(data: Buffer): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) {
      crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
    }
  }
  return crc;
}

/** Collects raw bytes from the port and lets the sender wait for single control bytes. */
class ByteReader {
  private queue: number[] = [];
  private waiter: (() => void) | null = null;
  private lastWasNewline = true;
  private readonly onData = (chunk: Buffer) => {
    for (const byte of chunk) this.queue.push(byte);
    this.waiter?.();
  };

  constructor(private readonly port: RawPort) {
    port.on('data', this.onData);
  }

  close(): void {
    this.port.removeListener('data', this.onData);
  }

  /** Discards everything received so far (for example a status report still in flight). */
  clear(): void {
    this.queue = [];
    this.lastWasNewline = true;
  }

  /** Next byte, or null after `timeoutMs`. */
  async next(timeoutMs: number): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    while (this.queue.length === 0) {
      const left = deadline - Date.now();
      if (left <= 0) return null;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiter = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.waiter = null;
    }
    return this.queue.shift() ?? null;
  }

  /**
   * Waits for the receiver's 'C'. A 'C' only counts at the start of a line, so the letter inside a
   * text line (an `[MSG:…]` or a late status report) is not mistaken for the handshake.
   */
  async waitForCrcMode(timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const byte = await this.next(Math.max(0, deadline - Date.now()));
      if (byte === null) return false;
      if (byte === CRC_MODE && this.lastWasNewline) return true;
      if (byte === CAN) throw new Error('The controller refused the upload (could not open the file)');
      this.lastWasNewline = byte === LF;
    }
  }

  /** Waits for ACK/NAK/CAN, ignoring stray handshake 'C's the receiver may still send. */
  async waitForReply(timeoutMs: number): Promise<number | null> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const byte = await this.next(Math.max(0, deadline - Date.now()));
      if (byte === null || byte === ACK || byte === NAK || byte === CAN) return byte;
    }
  }
}

function write(port: RawPort, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    port.write(data, (err) => (err ? reject(err) : port.drain ? port.drain((e) => (e ? reject(e) : resolve())) : resolve()));
  });
}

/**
 * Sends `data` once the receiver has been started. `start()` must send the `$Xmodem/Receive=…`
 * command; it is called after the reader is attached so the first 'C' cannot be missed.
 * Resolves after the receiver ACKs the EOT.
 */
export async function xmodemSend(port: RawPort, data: Buffer, start: () => void, onProgress?: (sent: number, total: number) => void): Promise<void> {
  const reader = new ByteReader(port);
  try {
    reader.clear();
    start();
    if (!(await reader.waitForCrcMode(8000))) {
      throw new Error('The controller did not start the XModem transfer');
    }

    const blocks = Math.max(1, Math.ceil(data.length / BLOCK));
    for (let n = 0; n < blocks; n++) {
      const payload = Buffer.alloc(BLOCK, CTRL_Z);
      data.copy(payload, 0, n * BLOCK, Math.min(data.length, (n + 1) * BLOCK));
      const number = (n + 1) & 0xff;
      const crc = crc16(payload);
      const packet = Buffer.concat([Buffer.from([STX, number, 0xff - number]), payload, Buffer.from([crc >> 8, crc & 0xff])]);

      let acked = false;
      for (let attempt = 0; attempt <= MAX_BLOCK_RETRIES && !acked; attempt++) {
        await write(port, packet);
        const reply = await reader.waitForReply(3000);
        if (reply === ACK) acked = true;
        else if (reply === CAN) throw new Error('The controller cancelled the upload (its file system may be full)');
        // NAK or timeout: send the block again
      }
      if (!acked) throw new Error(`Block ${n + 1} of ${blocks} was not accepted`);
      onProgress?.(Math.min(data.length, (n + 1) * BLOCK), data.length);
    }

    for (let attempt = 0; attempt < 5; attempt++) {
      await write(port, Buffer.from([EOT]));
      const reply = await reader.waitForReply(2000);
      if (reply === ACK) return;
      if (reply === CAN) throw new Error('The controller cancelled the upload at the end (its file system may be full)');
    }
    throw new Error('The controller did not confirm the end of the transfer');
  } catch (err) {
    // Tell the receiver to stop so it does not keep waiting for blocks.
    await write(port, Buffer.from([CAN, CAN, CAN])).catch(() => undefined);
    throw err;
  } finally {
    reader.close();
  }
}
