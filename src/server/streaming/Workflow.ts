/**
 * The program run state machine: idle -> running <-> paused -> idle
 * (was src/server/cnc/lib/Workflow.js, CNCjs). `state` is sent to the browser as `workflow:state`.
 * Invalid transitions are ignored silently and emit nothing.
 */
import events from 'events';
import type { WorkflowState } from '../protocol';

// Workflow State
export const WORKFLOW_STATE_RUNNING = 'running';
export const WORKFLOW_STATE_PAUSED = 'paused';
export const WORKFLOW_STATE_IDLE = 'idle';

class Workflow extends events.EventEmitter {
  state: WorkflowState = WORKFLOW_STATE_IDLE;

  isRunning(): boolean {
    return this.state === WORKFLOW_STATE_RUNNING;
  }

  isPaused(): boolean {
    return this.state === WORKFLOW_STATE_PAUSED;
  }

  isIdle(): boolean {
    return this.state === WORKFLOW_STATE_IDLE;
  }

  start(...args: unknown[]): void {
    if (this.state !== WORKFLOW_STATE_RUNNING) {
      this.state = WORKFLOW_STATE_RUNNING;
      this.emit('start', ...args);
    }
  }

  stop(...args: unknown[]): void {
    if (this.state !== WORKFLOW_STATE_IDLE) {
      this.state = WORKFLOW_STATE_IDLE;
      this.emit('stop', ...args);
    }
  }

  pause(...args: unknown[]): void {
    if (this.state === WORKFLOW_STATE_RUNNING) {
      this.state = WORKFLOW_STATE_PAUSED;
      this.emit('pause', ...args);
    }
  }

  resume(...args: unknown[]): void {
    if (this.state === WORKFLOW_STATE_PAUSED) {
      this.state = WORKFLOW_STATE_RUNNING;
      this.emit('resume', ...args);
    }
  }
}

export default Workflow;
