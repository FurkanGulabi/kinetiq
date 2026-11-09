/**
 * Program streaming: the `gcode:*` commands and the Sender / Workflow side of the controller
 * (moved out of src/server/cnc/controllers/Grbl/GrblController.js, CNCjs 1.11.5).
 *
 *   load / unload / start / stop / pause / resume   the gcode:* command handlers (commands.ts)
 *   onSenderData                                    Sender 'data': a program line to the port
 *   onWorkflowStart / Stop / Pause / Resume         Workflow transitions → workflow:state, Sender
 *   onOk / onError                                  acknowledgements while a program runs or pauses
 *
 * Program lines are written straight to the connection and are never echoed as `serialport:write`
 * (only Feeder and client writes are). The line filter (`%wait`, M0/M1/M6, `[expr]`) is in
 * filters.ts; the end-of-program detection is in StatusPoller.ts.
 */
import _ from 'lodash';
import config from '../config/ConfigStore';
import logger from '../logger';
import delay from '../util/delay';
import {
  WORKFLOW_STATE_IDLE,
  WORKFLOW_STATE_PAUSED,
  WORKFLOW_STATE_RUNNING
} from '../streaming/Workflow';
import type Feeder from '../streaming/Feeder';
import type Sender from '../streaming/Sender';
import type { SenderContext } from '../streaming/Sender';
import type Workflow from '../streaming/Workflow';
import type EventTrigger from '../events/EventTrigger';
import type { GcodeLoadCallback, HoldReason } from '../protocol';
import type { GrblCodeEntry } from '../grbl/constants';
import type { GrblErrorPayload } from '../grbl/parser/GrblLineParserResultError';
import type { GrblOkPayload } from '../grbl/parser/GrblLineParserResultOk';
import {
  GRBL_ACTIVE_STATE_RUN,
  GRBL_ACTIVE_STATE_HOLD,
} from '../grbl/constants';
import type GrblController from './GrblController';

const log = logger('controller:Grbl');

const noop: GcodeLoadCallback = () => {};

/** A runner event payload: the parser payload plus the raw line. */
type WithRaw<T> = T & { raw: string };

class JobRunner {
  constructor(private readonly controller: GrblController) {}

  // The controller's parts are null only after destroy(). A call that still arrives then throws a
  // TypeError on the null part, exactly as the JavaScript controller did (`this.sender.load` …).
  private get sender(): Sender {
    return this.controller.sender!;
  }

  private get feeder(): Feeder {
    return this.controller.feeder!;
  }

  private get workflow(): Workflow {
    return this.controller.workflow!;
  }

  private get event(): EventTrigger {
    return this.controller.event!;
  }

  // `gcode:load` (name, gcode, [context], [callback]); the context may be left out with the
  // callback in its place. Parameter defaults apply to undefined only, like CNCjs's destructuring
  // defaults (`let [name, gcode, context = {}, callback = noop] = args`).
  load(name: string, gcode: string, context: SenderContext | GcodeLoadCallback = {}, callback: GcodeLoadCallback = noop): void {
    if (typeof context === 'function') {
      callback = context;
      context = {};
    }

    // G4 P0 or P with a very small value will empty the planner queue and then
    // respond with an ok when the dwell is complete. At that instant, there will
    // be no queued motions, as long as no more commands were sent after the G4.
    // This is the fastest way to do it without having to check the status reports.
    const dwell = '%wait ; Wait for the planner to empty';
    const ok = this.sender.load(name, gcode + '\n' + dwell, context);
    if (!ok) {
      callback(new Error(`Invalid G-code: name=${name}`));
      return;
    }

    this.controller.emit('gcode:load', name, this.sender.state.gcode, context);
    this.event.trigger('gcode:load');

    log.debug(`Load G-code: name="${this.sender.state.name}", size=${this.sender.state.gcode.length}, total=${this.sender.state.total}`);

    this.workflow.stop();

    callback(null, this.sender.toJSON());
  }

  unload(): void {
    this.workflow.stop();

    // Sender
    this.sender.unload();

    this.controller.emit('gcode:unload');
    this.event.trigger('gcode:unload');
  }

  start(): void {
    this.event.trigger('gcode:start');

    this.workflow.start();

    // Feeder
    this.feeder.reset();

    // Sender
    this.sender.next();
  }

  // @param {object} options The options object.
  // @param {boolean} [options.force] Whether to force stop a G-code program. Defaults to false.
  // Force stop: `!` (hold) if the last broadcast state says Run, then 500 ms later a soft reset
  // (0x18) if it says Hold. The state read is the controller's broadcast copy, not runner.state.
  async stop(options?: { force?: boolean }): Promise<void> {
    this.event.trigger('gcode:stop');

    this.workflow.stop();

    const { force = false } = { ...options };
    if (force) {
      let activeState;

      activeState = _.get(this.controller.state, 'status.activeState', '');
      if (activeState === GRBL_ACTIVE_STATE_RUN) {
        this.controller.write('!'); // hold
      }

      await delay(500); // delay 500ms

      activeState = _.get(this.controller.state, 'status.activeState', '');
      if (activeState === GRBL_ACTIVE_STATE_HOLD) {
        this.controller.write('\x18'); // ^x
      }
    }
  }

  pause(): void {
    this.event.trigger('gcode:pause');

    this.workflow.pause();
    this.controller.write('!');
  }

  resume(): void {
    this.event.trigger('gcode:resume');

    this.controller.write('~');
    this.workflow.resume();
  }

  /** Sender 'data': a filtered program line that fits in the RX buffer. */
  onSenderData(line: string = '', context: SenderContext = {}): void {
    if (this.controller.isClose()) {
      log.error(`Serial port "${this.controller.options.port}" is not accessible`);
      return;
    }

    if (this.workflow.state === WORKFLOW_STATE_IDLE) {
      log.error(`Unexpected workflow state: ${this.workflow.state}`);
      return;
    }

    line = String(line).trim();
    if (line.length === 0) {
      log.warn(`Expected non-empty line: N=${this.sender.state.sent}`);
      return;
    }

    this.controller.connection!.write(line + '\n');
    log.silly(`> ${line}`);
  }

  onWorkflowStart(): void {
    this.controller.emit('workflow:state', this.workflow.state);
    this.sender.rewind();
  }

  onWorkflowStop(): void {
    this.controller.emit('workflow:state', this.workflow.state);
    this.sender.rewind();
  }

  // Workflow 'pause' with the pause() arguments: a hold reason (M0/M1/M6, error), or none for a
  // plain gcode:pause (the Sender then holds without a reason: holdReason undefined).
  onWorkflowPause(...args: HoldReason[]): void {
    this.controller.emit('workflow:state', this.workflow.state);

    if (args.length > 0) {
      const reason = { ...args[0] };
      this.sender.hold(reason); // Hold reason
    } else {
      this.sender.hold();
    }
  }

  onWorkflowResume(): void {
    this.controller.emit('workflow:state', this.workflow.state);

    // Reset feeder prior to resume program execution
    this.feeder.reset();

    // Resume program execution
    this.sender.unhold();
    this.sender.next();
  }

  /**
   * Runner 'ok' that did not close a `$G` query. Returns true when it acknowledged a program line
   * (workflow running, or paused with lines still in flight); otherwise the controller forwards it
   * to the console and the Feeder.
   */
  onOk(_res: WithRaw<GrblOkPayload>): boolean {
    const { hold, sent, received } = this.sender.state;

    if (this.workflow.state === WORKFLOW_STATE_RUNNING) {
      if (hold && (received + 1 >= sent)) {
        log.debug(`Continue sending G-code: hold=${hold}, sent=${sent}, received=${received + 1}`);
        this.sender.unhold();
      }
      this.sender.ack();
      this.sender.next();
      return true;
    }

    if ((this.workflow.state === WORKFLOW_STATE_PAUSED) && (received < sent)) {
      if (!hold) {
        log.error('The sender does not hold off during the paused state');
      }
      if (received + 1 >= sent) {
        log.debug(`Stop sending G-code: hold=${hold}, sent=${sent}, received=${received + 1}`);
      }
      this.sender.ack();
      this.sender.next();
      return true;
    }

    return false;
  }

  /**
   * Runner 'error' (`code`/`error` looked up by the controller). While a program runs: report the
   * failing line, pause unless `state.controller.exception.ignoreErrors` is set in the rc file,
   * acknowledge and continue, and return true. Otherwise return false (console + Feeder).
   */
  onError(res: WithRaw<GrblErrorPayload>, code: number | undefined, error: GrblCodeEntry | undefined): boolean {
    if (this.workflow.state === WORKFLOW_STATE_RUNNING) {
      const ignoreErrors = config.get('state.controller.exception.ignoreErrors');
      const pauseError = !ignoreErrors;
      const { lines, received } = this.sender.state;
      // lines[-1] is undefined before the first ack (CNCjs: `ensureString(…)` → '')
      const line = (lines[received - 1] ?? '').trim();
      const ln = received + 1;

      this.controller.emit('serialport:read', `> ${line} (ln=${ln})`);
      if (error) {
        // Grbl v1.1
        this.controller.emit('serialport:read', `error:${code} (${error.message})`);

        if (pauseError) {
          this.workflow.pause({
            err: true,
            msg: `error:${code} (${error.message})`,
          });
        }
      } else {
        // Grbl v0.9
        this.controller.emit('serialport:read', res.raw);

        if (pauseError) {
          this.workflow.pause({
            err: true,
            msg: res.raw,
          });
        }
      }

      this.sender.ack();
      this.sender.next();

      return true;
    }

    return false;
  }
}

export default JobRunner;
