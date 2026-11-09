/**
 * The query timer (moved out of src/server/cnc/controllers/Grbl/GrblController.js, CNCjs 1.11.5).
 *
 * Every 250 ms, while the port is open:
 *   1. the controller broadcasts what changed (feeder:status, sender:status, controller:settings,
 *      controller:state; GrblController.broadcastChanges()),
 *   2. nothing more while the port is in exclusive use (Kinetiq, settings editor XModem upload),
 *   3. before the controller is ready (no startup banner and no status report yet): a `?` at most
 *      every 2 s, trailing edge only (#889),
 *   4. once ready: `?` (status report) unless one is outstanding (given up after 5 s), and `$G`
 *      (parser state, throttled to 500 ms) unless one is outstanding; during a program `$G` is not
 *      forced after 10 s, because it costs RX buffer bytes (#176, #186),
 *   5. after the Sender has sent the last line: `gcode:stop` once the machine has been Idle with an
 *      unchanged work position for more than 500 ms.
 *
 * The action masks also decide which `?` / `$G` replies reach the console (`serialport:read`):
 * only those the user asked for with write()/writeln(), never the timer's own.
 *
 * Timings, throttle options and the order of the checks are CNCjs's, unchanged.
 */
import _ from 'lodash';
import logger from '../logger';
import { SP_TYPE_CHAR_COUNTING } from '../streaming/Sender';
import { WORKFLOW_STATE_IDLE } from '../streaming/Workflow';
import type { GrblOkPayload } from '../grbl/parser/GrblLineParserResultOk';
import type { GrblParserStatePayload } from '../grbl/parser/GrblLineParserResultParserState';
import type { GrblStatusPayload } from '../grbl/parser/GrblLineParserResultStatus';
import type GrblController from './GrblController';

const log = logger('controller:Grbl');

/** A runner event payload: the parser payload plus the raw line. */
type WithRaw<T> = T & { raw: string };

export interface ActionMask {
  queryParserState: {
    state: boolean; // wait for a message containing the current G-code parser modal state
    reply: boolean; // wait for an `ok` or `error` response
  };
  queryStatusReport: boolean;

  // Respond to user input
  replyParserState: boolean; // $G
  replyStatusReport: boolean; // ?
}

export interface ActionTime {
  queryParserState: number;
  queryStatusReport: number;
  senderFinishTime: number;
}

class StatusPoller {
  actionMask: ActionMask = {
    queryParserState: {
      state: false, // wait for a message containing the current G-code parser modal state
      reply: false // wait for an `ok` or `error` response
    },
    queryStatusReport: false,

    // Respond to user input
    replyParserState: false, // $G
    replyStatusReport: false // ?
  };

  actionTime: ActionTime = {
    queryParserState: 0,
    queryStatusReport: 0,
    senderFinishTime: 0
  };

  // CNCjs `queryTimer`
  private queryTimer: ReturnType<typeof setInterval> | null = null;

  private readonly queryActivity: () => void;

  private readonly queryParserState: () => void;

  constructor(private readonly controller: GrblController) {
    // Restrict the function to execute once within the specified time interval, occurring only on the trailing edge of the timeout.
    this.queryActivity = _.throttle(() => {
      if (this.controller.isOpen()) {
        this.controller.connection!.write('?');
      }
    }, 2000, {
      // For grbl-Mega, it is essential to allow a specific delay before querying the status report to avoid blocking the connection.
      // Therefore, the `leading` option must be set to false.
      // @see https://github.com/cncjs/cncjs/issues/889
      leading: false,
      trailing: true,
    });

    this.queryParserState = _.throttle(() => {
      // Check the ready flag
      if (!(this.controller.ready)) {
        return;
      }

      const now = new Date().getTime();

      // Do not force query parser state ($G) when running a G-code program,
      // it will consume 3 bytes from the receive buffer in each time period.
      // @see https://github.com/cncjs/cncjs/issues/176
      // @see https://github.com/cncjs/cncjs/issues/186
      if ((this.controller.workflow!.state === WORKFLOW_STATE_IDLE) && this.controller.runner!.isIdle()) {
        const lastQueryTime = this.actionTime.queryParserState;
        if (lastQueryTime > 0) {
          const timespan = Math.abs(now - lastQueryTime);
          const toleranceTime = 10000; // 10 seconds

          // Check if it has not been updated for a long time
          if (timespan >= toleranceTime) {
            log.debug(`Continue parser state query: timespan=${timespan}ms`);
            this.actionMask.queryParserState.state = false;
            this.actionMask.queryParserState.reply = false;
          }
        }
      }

      if (this.actionMask.queryParserState.state || this.actionMask.queryParserState.reply) {
        return;
      }

      if (this.controller.isOpen()) {
        this.actionMask.queryParserState.state = true;
        this.actionMask.queryParserState.reply = false;
        this.actionTime.queryParserState = now;
        this.controller.connection!.write('$G\n');
      }
    }, 500);
  }

  /** Starts the 250 ms timer (CNCjs started it at the end of the controller constructor). */
  start(): void {
    this.queryTimer = setInterval(() => this.tick(), 250);
  }

  stop(): void {
    if (this.queryTimer) {
      clearInterval(this.queryTimer);
      this.queryTimer = null;
    }
  }

  clearActionValues(): void {
    this.actionMask.queryParserState.state = false;
    this.actionMask.queryParserState.reply = false;
    this.actionMask.queryStatusReport = false;
    this.actionMask.replyParserState = false;
    this.actionMask.replyStatusReport = false;
    this.actionTime.queryParserState = 0;
    this.actionTime.queryStatusReport = 0;
    this.actionTime.senderFinishTime = 0;
  }

  /** write(): a `?` or `$G` from the user gets its reply forwarded to the console. */
  onWrite(cmd: string): void {
    this.actionMask.replyStatusReport = (cmd === '?') || this.actionMask.replyStatusReport;
    this.actionMask.replyParserState = (cmd === '$G') || this.actionMask.replyParserState;
  }

  /** Sender 'start'. */
  onSenderStart(): void {
    this.actionTime.senderFinishTime = 0;
  }

  /** Sender 'end': every line acknowledged; step 5 above waits for the machine to stop. */
  onSenderEnd(finishTime: number): void {
    this.actionTime.senderFinishTime = finishTime;
  }

  /**
   * Runner 'status', after the controller set its ready/initialized flags: clears the outstanding
   * `?`, forwards a user-requested report, and grows the Sender's buffer to the reported RX size.
   */
  onStatus(res: WithRaw<GrblStatusPayload>): void {
    this.actionMask.queryStatusReport = false;

    if (this.actionMask.replyStatusReport) {
      this.actionMask.replyStatusReport = false;
      this.controller.emit('serialport:read', res.raw);
    }

    // Check if the receive buffer is available in the status report
    // @see https://github.com/cncjs/cncjs/issues/115
    // @see https://github.com/cncjs/cncjs/issues/133
    const rx = Number(_.get(res, 'buf.rx', 0)) || 0;
    if (rx > 0) {
      const sender = this.controller.sender!;

      // Do not modify the buffer size when running a G-code program
      if (this.controller.workflow!.state !== WORKFLOW_STATE_IDLE) {
        return;
      }

      // Check if the streaming protocol is character-counting streaming protocol
      if (sender.sp!.type !== SP_TYPE_CHAR_COUNTING) {
        return;
      }

      // Check if the queue is empty
      if (sender.sp!.dataLength !== 0) {
        return;
      }

      // Deduct the receive buffer length to prevent from buffer overrun
      const bufferSize = (rx - 8); // TODO
      if (bufferSize > sender.sp!.bufferSize) {
        sender.sp!.bufferSize = bufferSize;
      }
    }
  }

  /**
   * Runner 'ok'. Returns true when the `ok` closed the timer's (or the user's) `$G` query and must
   * not reach the Sender or Feeder.
   */
  onOk(res: WithRaw<GrblOkPayload>): boolean {
    if (this.actionMask.queryParserState.reply) {
      if (this.actionMask.replyParserState) {
        this.actionMask.replyParserState = false;
        this.controller.emit('serialport:read', res.raw);
      }
      this.actionMask.queryParserState.reply = false;
      return true;
    }
    return false;
  }

  /** Runner 'parserstate': the `[GC:…]` line arrived; its `ok` follows. */
  onParserState(res: WithRaw<GrblParserStatePayload>): void {
    this.actionMask.queryParserState.state = false;
    this.actionMask.queryParserState.reply = true;

    if (this.actionMask.replyParserState) {
      this.controller.emit('serialport:read', res.raw);
    }
  }

  private queryStatusReport(): void {
    // Check the ready flag
    if (!(this.controller.ready)) {
      return;
    }

    const now = new Date().getTime();

    // The status report query (?) is a realtime command, it does not consume the receive buffer.
    const lastQueryTime = this.actionTime.queryStatusReport;
    if (lastQueryTime > 0) {
      const timespan = Math.abs(now - lastQueryTime);
      const toleranceTime = 5000; // 5 seconds

      // Check if it has not been updated for a long time
      if (timespan >= toleranceTime) {
        log.debug(`Continue status report query: timespan=${timespan}ms`);
        this.actionMask.queryStatusReport = false;
      }
    }

    if (this.actionMask.queryStatusReport) {
      return;
    }

    if (this.controller.isOpen()) {
      this.actionMask.queryStatusReport = true;
      this.actionTime.queryStatusReport = now;
      this.controller.connection!.write('?');
    }
  }

  private tick(): void {
    const controller = this.controller;

    if (controller.isClose()) {
      // Serial port is closed
      return;
    }

    // Feeder / Sender status, Grbl settings and state (compared before the state is replaced)
    const zeroOffset = controller.broadcastChanges();

    // Kinetiq: no polling while another component has exclusive use of the serial port
    if (controller.exclusive) {
      return;
    }

    // Check the ready flag
    if (!(controller.ready)) {
      this.queryActivity();
      return;
    }

    // ? - Status Report
    this.queryStatusReport();

    // $G - Parser State
    this.queryParserState();

    // Check if the machine has stopped movement after completion
    if (this.actionTime.senderFinishTime > 0) {
      const machineIdle = zeroOffset && controller.runner!.isIdle();
      const now = new Date().getTime();
      const timespan = Math.abs(now - this.actionTime.senderFinishTime);
      const toleranceTime = 500; // in milliseconds

      if (!machineIdle) {
        // Extend the sender finish time
        this.actionTime.senderFinishTime = now;
      } else if (timespan > toleranceTime) {
        log.silly(`Finished sending G-code: timespan=${timespan}`);

        this.actionTime.senderFinishTime = 0;

        // Stop workflow
        controller.command('gcode:stop');
      }
    }
  }
}

export default StatusPoller;
