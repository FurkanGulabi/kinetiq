/**
 * Runs the rc file's `events` entries for a backend event (was src/server/cnc/lib/EventTrigger.js, CNCjs).
 *
 * SECURITY RULE: the commands handed to the callback, and from there to events/TaskRunner.ts
 * (trigger 'system' = shell), come ONLY from the rc file's `events` entries (~/.kinetiqrc), which
 * only the machine owner can edit. Never from socket, HTTP or other frontend input.
 * See src/server/cnc/README.md, "Security rule: shell commands".
 */
import config from '../config/ConfigStore';

/** One entry of the rc file's `events` list, as written by the machine owner (not validated). */
export interface RcEvent {
  id?: string;
  enabled?: boolean;
  event?: string;
  trigger?: string; // 'system' (shell command) or 'gcode'
  commands?: string;
}

export type EventTriggerCallback = (
  event: string | undefined,
  trigger: string | undefined,
  commands: string | undefined
) => void;

const noop: EventTriggerCallback = () => {};

// SECURITY (Kinetiq): `commands` come only from the rc file's `events` entries. A 'system'
// trigger runs them through the shell (services/taskrunner), so they must never come from
// frontend input. See events/TaskRunner.ts.

class EventTrigger {
  callback: EventTriggerCallback;

  constructor(callback: EventTriggerCallback = noop) {
    this.callback = callback || noop;
  }

  // `callback` is unused (kept from CNCjs for the call signature).
  trigger(eventKey: string, callback: (() => void) | null = null): void {
    if (!eventKey) {
      return;
    }

    const events = config.get<Array<RcEvent | null | undefined>>('events', []);

    events
      .filter(event => event && event.event === eventKey)
      .forEach(options => {
        const {
          enabled = false,
          event,
          trigger,
          commands
        } = { ...options };

        if (!enabled) {
          return;
        }

        if (typeof this.callback === 'function') {
          this.callback(event, trigger, commands);
        }
      });
  }
}

export default EventTrigger;
