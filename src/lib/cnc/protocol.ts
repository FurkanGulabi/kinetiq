/**
 * Typed mirror of the CNCjs Socket.IO contract (GRBL controller).
 * Every name and payload here is verified in source — see docs/API_REFERENCE.md §2–4.
 */

export type Axis = 'x' | 'y' | 'z' | 'a' | 'b' | 'c';
export type AxisValues = Partial<Record<Axis, string>>;

export interface GrblState {
  status: {
    activeState: string; // '' until the first status report; 'Idle' | 'Run' | 'Hold' | 'Jog' | 'Alarm' | ...
    subState?: number;
    mpos: AxisValues;
    wpos: AxisValues;
    wco?: AxisValues;
    ov: number[];
    feedrate?: number;
    spindle?: number;
    buf?: { planner: number; rx: number };
    ln?: number;
    pinState?: string;
    accessoryState?: string;
  };
  parserstate: {
    modal: {
      motion: string;
      wcs: string;
      plane: string;
      units: 'G20' | 'G21' | string;
      distance: string;
      feedrate: string;
      program: string;
      spindle: string;
      coolant: string | string[];
    };
    tool: string;
    feedrate: string;
    spindle: string;
  };
}

export interface GrblSettings {
  version: string;
  parameters: Record<string, unknown>;
  settings: Record<string, string>;
}

export interface SenderStatus {
  sp: number;
  hold: boolean;
  holdReason: null | { data?: string; msg?: string; err?: boolean };
  name: string;
  context: Record<string, unknown>;
  size: number;
  total: number;
  sent: number;
  received: number;
  startTime: number;
  finishTime: number;
  elapsedTime: number;
  remainingTime: number;
}

export interface FeederStatus {
  hold: boolean;
  holdReason: null | { data?: string; msg?: string };
  queue: number;
  pending: boolean;
  changed: boolean;
}

export type WorkflowState = 'idle' | 'running' | 'paused';

export interface SerialPortInfo {
  port: string;
  manufacturer?: string;
  inuse: boolean;
}

export interface OpenOptions {
  controllerType: 'Grbl';
  baudrate: number;
  rtscts?: boolean;
  pin?: { dtr?: boolean; rts?: boolean };
}

export interface WriteContext {
  source?: 'client' | 'feeder' | string;
  __sender__?: string;
  [key: string]: unknown;
}

/** Server → client events (CNCEngine.js / GrblController.js). */
export interface ServerEvents {
  startup: (payload: { loadedControllers: string[]; baudrates: number[]; ports: unknown[] }) => void;
  'serialport:list': (ports: SerialPortInfo[]) => void;
  'serialport:open': (payload: { port: string; baudrate: number; controllerType: string; inuse: boolean }) => void;
  'serialport:change': (payload: { port: string; inuse: boolean }) => void;
  'serialport:close': (payload: { port: string; inuse: boolean }) => void;
  'serialport:error': (payload: { err: unknown; port: string }) => void;
  'serialport:read': (line: string) => void;
  'serialport:write': (data: string, context: WriteContext) => void;
  'controller:state': (type: string, state: GrblState) => void;
  'controller:settings': (type: string, settings: GrblSettings) => void;
  'feeder:status': (status: FeederStatus) => void;
  'sender:status': (status: SenderStatus) => void;
  'workflow:state': (state: WorkflowState) => void;
  'gcode:load': (name: string, gcode: string, context: unknown) => void;
  'gcode:unload': () => void;
}

export type ServerEventName = keyof ServerEvents;

export const SERVER_EVENTS: ServerEventName[] = [
  'startup',
  'serialport:list',
  'serialport:open',
  'serialport:change',
  'serialport:close',
  'serialport:error',
  'serialport:read',
  'serialport:write',
  'controller:state',
  'controller:settings',
  'feeder:status',
  'sender:status',
  'workflow:state',
  'gcode:load',
  'gcode:unload',
];

export const DEFAULT_BAUDRATE = 115200;
export const BAUDRATES = [250000, 230400, 115200, 57600, 38400, 19200, 9600];
