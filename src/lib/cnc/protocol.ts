/**
 * The CNCjs Socket.IO contract (GRBL controller), as seen by the browser.
 * The types live in src/server/protocol.ts, shared with the backend so both sides use one
 * definition (types and plain constants only, safe for the browser bundle). See also
 * docs/API_REFERENCE.md §2–4.
 */
export * from '@/server/protocol';

// Client-only: the backend has no default baud rate; these feed the connection bar.
export const DEFAULT_BAUDRATE = 115200;
export const BAUDRATES = [250000, 230400, 115200, 57600, 38400, 19200, 9600];
