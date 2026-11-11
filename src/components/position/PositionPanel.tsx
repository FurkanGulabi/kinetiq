'use client';

/**
 * Widget 3 — Coordinates & Jog. docs/ARCHITECTURE.md §10.4, docs/API_REFERENCE.md §8–9.
 *
 * Readout: work (primary) and machine (secondary) X/Y/Z from controller:state.
 * Per axis (AxisRow): Go to (absolute jog), Zero (G10 L20), Home ($H<axis>).
 * Jog: one `$J=` line per press through the CNCjs Feeder (corners: X and Y together); centre button = jog cancel (0x85).
 * Go to zero: `$J=G90` to work X0 Y0 (+ Z0 when "Include Z"; Z is raised first when below zero).
 * Floating, draggable, collapsible (FloatingWidget); collapsed, the header shows work X/Y/Z.
 * Probe Z is its own widget (ProbeSection).
 * Keyboard jog (opt-in, off by default, `kinetiq.keyboardJog`): arrows X/Y, PageUp/PageDown Z, Escape = Stop jog,
 * [ ] = step. One keydown = one step through the same send path and gate as the pad (sendStepJog, jogButtonView).
 * No optimistic state — the readout only changes when the controller reports a new position.
 */
import {
  ArrowDown,
  ArrowDownLeft,
  ArrowDownRight,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ArrowUpLeft,
  ArrowUpRight,
  Crosshair,
  Keyboard,
  Square,
} from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { sendCommand, sendGcode } from '@/lib/cnc/client';
import {
  goToZeroLines,
  isValidFeed,
  JOG_FEEDS,
  JOG_STEPS,
  jogLine,
  jogLineXY,
  MAX_JOG_FEED,
  type JogAxis,
  type Units,
} from '@/lib/cnc/commands';
import {
  axisControlsView,
  axisNotHomed,
  jogButtonView,
  jogView,
  keyboardJogView,
  positionView,
  reportUnits,
  travelView,
} from '@/lib/cnc/derive';
import { getState, useMachine } from '@/lib/cnc/store';
import { KEYBOARD_JOG_LEGEND, keyboardJogAction, loadKeyboardJog, saveKeyboardJog } from '@/lib/ui/keyboardJog';
import { getLayout, useLayout } from '@/lib/ui/layout';
import { Button } from '@/components/ui/Button';
import { FloatingWidget } from '@/components/ui/FloatingWidget';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AxisRow } from './AxisRow';
import { TravelSection } from './TravelSection';

const PREFS_KEY = 'kinetiq.jog';
const ZERO_Z_KEY = 'kinetiq.goZeroIncludeZ';

/** "Include Z" for Go to zero; off by default so Z never moves unless asked. Persisted per browser. */
function useIncludeZ(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(false);
  useEffect(() => {
    try {
      setValue(localStorage.getItem(ZERO_Z_KEY) === '1');
    } catch {
      // optional
    }
  }, []);
  const update = (next: boolean) => {
    setValue(next);
    try {
      localStorage.setItem(ZERO_Z_KEY, next ? '1' : '0');
    } catch {
      // optional
    }
  };
  return [value, update];
}

type JogPrefs = Record<Units, { step: number; feed: number }>;

const DEFAULT_PREFS: JogPrefs = {
  mm: { step: 1, feed: 1000 },
  in: { step: 0.1, feed: 40 },
};

function loadJogPrefs(): JogPrefs {
  try {
    const stored = JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') as Partial<JogPrefs>;
    return {
      mm: { ...DEFAULT_PREFS.mm, ...stored.mm },
      in: { ...DEFAULT_PREFS.in, ...stored.in },
    };
  } catch {
    return DEFAULT_PREFS;
  }
}

function useJogPrefs(units: Units) {
  const [prefs, setPrefs] = useState<JogPrefs>(DEFAULT_PREFS);
  useEffect(() => setPrefs(loadJogPrefs()), []);

  const update = (patch: Partial<{ step: number; feed: number }>) => {
    setPrefs((prev) => {
      const next = { ...prev, [units]: { ...prev[units], ...patch } };
      try {
        localStorage.setItem(PREFS_KEY, JSON.stringify(next));
      } catch {
        // optional
      }
      return next;
    });
  };

  const current = prefs[units];
  const step = JOG_STEPS[units].includes(current.step) ? current.step : DEFAULT_PREFS[units].step;
  const feed = isValidFeed(current.feed, units) ? current.feed : DEFAULT_PREFS[units].feed;
  return { step, feed, setStep: (s: number) => update({ step: s }), setFeed: (f: number) => update({ feed: f }) };
}

/**
 * The one send path for a single step jog: the pad buttons and the keyboard keys both come through here,
 * so they send the same line under the same gate. Reads the machine state at the moment of the press.
 * Refuses when the report units changed since `step`/`feed` were chosen.
 */
function sendStepJog(axis: JogAxis, direction: 1 | -1, step: number, feed: number, units: Units): boolean {
  const s = getState();
  if (reportUnits(s) !== units || !jogButtonView(s, axis, direction).enabled) return false;
  sendGcode(jogLine(axis, direction, step, feed, units));
  return true;
}

/** Stop jog (0x85): the centre pad button and Escape. */
function sendJogCancel(): void {
  if (!jogView(getState()).canCancel) return;
  sendCommand('jogCancel');
}

/** Keyboard jog on/off; off by default (opt-in, accidental-motion risk). Persisted per browser. */
function useKeyboardJogPref(): [boolean, (value: boolean) => void] {
  const [value, setValue] = useState(false);
  useEffect(() => setValue(loadKeyboardJog()), []);
  const update = (next: boolean) => {
    setValue(next);
    saveKeyboardJog(next);
  };
  return [value, update];
}

interface KeyboardJogTarget {
  enabled: boolean;
  step: number;
  feed: number;
  units: Units;
  setStep: (step: number) => void;
}

/**
 * One window keydown listener, registered once (Strict Mode's second mount re-adds it after the cleanup
 * removed the first). It reads the latest panel values from a ref and the machine state from the store
 * at event time, so nothing goes stale. Bubble phase: React handlers (e.g. SegmentedControl arrows) run first.
 */
function useKeyboardJog(target: KeyboardJogTarget) {
  const ref = useRef(target);
  ref.current = target;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const current = ref.current;
      if (!current.enabled) return;
      const action = keyboardJogAction(event);
      if (!action) return;
      const s = getState();
      const view = keyboardJogView(s, { enabled: current.enabled, collapsed: getLayout().widgets.position.collapsed });
      if (!view.active) return;
      // The key is ours while keyboard jog is active, even when the gate refuses it: never scroll the page instead.
      event.preventDefault();
      if (action.type === 'jog') {
        sendStepJog(action.axis, action.direction, current.step, current.feed, current.units);
      } else if (action.type === 'cancel') {
        if (view.cancel.enabled) sendJogCancel();
      } else {
        const steps = JOG_STEPS[current.units];
        const next = steps[steps.indexOf(current.step) + action.delta];
        if (next !== undefined) current.setStep(next);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);
}

function JogButton({
  axis,
  direction,
  icon,
  disabled,
  reason,
  onJog,
  className = '',
}: {
  axis: JogAxis;
  direction: 1 | -1;
  icon: React.ReactNode;
  disabled: boolean;
  /** Why this direction is off (not homed, at the travel limit). */
  reason?: string;
  onJog: (axis: JogAxis, direction: 1 | -1) => void;
  className?: string;
}) {
  const label = `${axis}${direction > 0 ? '+' : '−'}`;
  return (
    <button
      type="button"
      aria-label={`Jog ${axis} ${direction > 0 ? 'positive' : 'negative'}`}
      title={disabled ? reason : undefined}
      disabled={disabled}
      onClick={() => onJog(axis, direction)}
      className={`pressable flex h-[52px] w-[52px] flex-col items-center justify-center gap-0.5 rounded-md border border-line bg-surface-2 text-ink hover-fine:border-ink-3 disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:border-line ${className}`}
    >
      <span className="font-mono text-[14px] font-semibold">{label}</span>
      <span className="text-ink-3" aria-hidden>
        {icon}
      </span>
    </button>
  );
}

/** Corner of the XY pad: X and Y together by one step each. */
function DiagonalJogButton({
  x,
  y,
  icon,
  disabled,
  reason,
  onJog,
}: {
  x: 1 | -1;
  y: 1 | -1;
  icon: React.ReactNode;
  disabled: boolean;
  reason?: string;
  onJog: (x: 1 | -1, y: 1 | -1) => void;
}) {
  const sign = (d: 1 | -1) => (d > 0 ? '+' : '−');
  return (
    <button
      type="button"
      aria-label={`Jog X ${x > 0 ? 'positive' : 'negative'} and Y ${y > 0 ? 'positive' : 'negative'}`}
      title={disabled ? reason : `X${sign(x)} Y${sign(y)} together`}
      disabled={disabled}
      onClick={() => onJog(x, y)}
      className="pressable flex h-[52px] w-[52px] flex-col items-center justify-center gap-0.5 rounded-md border border-line bg-surface text-ink-2 hover-fine:border-ink-3 hover-fine:text-ink disabled:cursor-not-allowed disabled:text-ink-3 disabled:hover:border-line"
    >
      <span className="font-mono text-[10px] font-semibold leading-none">
        X{sign(x)}Y{sign(y)}
      </span>
      <span className="text-ink-3" aria-hidden>
        {icon}
      </span>
    </button>
  );
}

function fmtRoom(room: number | null, units: Units): string {
  return room === null ? '—' : room.toFixed(units === 'in' ? 2 : 1);
}

export function PositionPanel() {
  const machine = useMachine((s) => s);
  const units = reportUnits(machine);
  const position = positionView(machine);
  const jog = jogView(machine);
  const axisControls = axisControlsView(machine);
  const [previews, setPreviews] = useState<Partial<Record<JogAxis, string>>>({});
  const onPreview = useCallback((axis: JogAxis, text: string | null) => {
    setPreviews((prev) => {
      if ((prev[axis] ?? null) === text) return prev;
      const next = { ...prev };
      if (text) next[axis] = text;
      else delete next[axis];
      return next;
    });
  }, []);
  const preview = Object.values(previews)[0] ?? null;
  const { step, feed, setStep, setFeed } = useJogPrefs(units);
  const [feedText, setFeedText] = useState<string>('');
  const decimals = units === 'in' ? 4 : 3;

  useEffect(() => setFeedText(String(feed)), [feed]);

  const [includeZ, setIncludeZ] = useIncludeZ();
  const [zeroHover, setZeroHover] = useState(false);
  const fmt = (v: number) => v.toFixed(decimals);
  const work = Object.fromEntries(position.axes.map((a) => [a.axis, a.work])) as Record<JogAxis, number | null>;
  const atZero =
    work.X !== null && work.Y !== null && Math.abs(work.X) < 1e-4 && Math.abs(work.Y) < 1e-4 && (!includeZ || (work.Z !== null && Math.abs(work.Z) < 1e-4));
  const zBelowZero = work.Z !== null && work.Z < 0;
  const travel = travelView(machine);
  const zeroNotHomed = axisNotHomed(machine, 'X') ?? axisNotHomed(machine, 'Y') ?? (includeZ ? axisNotHomed(machine, 'Z') : null);
  const goZero =
    axisControls.goTo.enabled && !atZero && !zeroNotHomed
      ? { enabled: true }
      : { enabled: false, reason: atZero ? 'Already at work zero' : axisControls.goTo.reason ?? zeroNotHomed ?? undefined };
  /** Jog-pad button state: the shared jog gating, then this direction's travel limit (same gate as the keys). */
  const pad = (axis: JogAxis, direction: 1 | -1) => {
    const view = jogButtonView(machine, axis, direction);
    return { disabled: !view.enabled, reason: view.reason };
  };
  const [keyboardJog, setKeyboardJog] = useKeyboardJogPref();
  const collapsed = useLayout((l) => l.widgets.position.collapsed);
  const keyboard = keyboardJogView(machine, { enabled: keyboardJog, collapsed });
  useKeyboardJog({ enabled: keyboardJog, step, feed, units, setStep });
  const limitedAxes = (['X', 'Y', 'Z'] as const).filter((a) => travel.axes[a].range);
  const notHomedAxes = limitedAxes.filter((a) => !travel.axes[a].homed);
  let zeroPreview: string;
  if (!includeZ) {
    zeroPreview = `Move to X0 Y0 at ${feed} ${units}/min — Z stays at ${work.Z !== null ? fmt(work.Z) : '—'}`;
    if (zBelowZero) zeroPreview += ' (below work zero: XY moves at this depth)';
  } else {
    zeroPreview = zBelowZero
      ? `Raise Z to 0 first, then move to X0 Y0 at ${feed} ${units}/min`
      : `Move to X0 Y0, then lower Z to 0 at ${feed} ${units}/min`;
  }

  const onGoZero = () => {
    if (!goZero.enabled) return;
    for (const line of goToZeroLines(includeZ, work.Z, feed, units)) sendGcode(line);
  };

  const onJog = (axis: JogAxis, direction: 1 | -1) => {
    sendStepJog(axis, direction, step, feed, units);
  };

  /** Diagonal: off when either of its two directions is off (not homed, at a travel limit). */
  const diag = (x: 1 | -1, y: 1 | -1) => {
    const px = pad('X', x);
    const py = pad('Y', y);
    return { disabled: px.disabled || py.disabled, reason: px.disabled ? px.reason : py.reason };
  };
  const onDiagonal = (x: 1 | -1, y: 1 | -1) => {
    if (diag(x, y).disabled) return;
    sendGcode(jogLineXY(x, y, step, feed, units));
  };

  const feedValue = Number(feedText);
  const feedInvalid = feedText !== '' && !isValidFeed(feedValue, units);
  const commitFeed = () => {
    if (isValidFeed(feedValue, units)) setFeed(feedValue);
    else setFeedText(String(feed));
  };

  const arrow = 14;

  return (
    <FloatingWidget
      id="position"
      index={0}
      title="Position"
      actions={
        <span className="font-mono">
          {position.wcs} · {units}
        </span>
      }
      summary={
        <span className="flex gap-3 font-mono tabular-nums">
          {position.axes.map((a) => (
            <span key={a.axis}>
              <span className="text-ink-3">{a.axis}</span> <span className="text-ink">{a.work === null ? '—' : fmt(a.work)}</span>
            </span>
          ))}
        </span>
      }
    >
      {/* Readout + per-axis controls */}
      <div
        role="table"
        aria-label="Axis positions"
        className="grid grid-cols-[20px_1fr_76px_auto_auto] items-center gap-x-3 gap-y-3"
      >
        <div role="row" className="contents">
          <span role="columnheader" />
          <span role="columnheader" className="panel-label text-right">Work</span>
          <span role="columnheader" className="panel-label text-right">Machine</span>
          <span role="columnheader" className="panel-label">Go to</span>
          <span role="columnheader">
            <span className="sr-only">Axis actions</span>
          </span>
        </div>
        {position.axes.map((a) => (
          <AxisRow
            key={a.axis}
            axis={a.axis}
            work={a.work}
            machine={a.machine}
            decimals={decimals}
            units={units}
            feed={feed}
            wcs={position.wcs}
            controls={
              axisControls.goTo.enabled && axisNotHomed(machine, a.axis)
                ? { ...axisControls, goTo: { enabled: false, reason: axisNotHomed(machine, a.axis)! } }
                : axisControls
            }
            onPreview={onPreview}
          />
        ))}
      </div>

      <div className="my-5 h-px bg-line" aria-hidden />

      {/* Jog */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="panel-label">Jog</h3>
        <button
          type="button"
          role="switch"
          aria-checked={keyboardJog}
          onClick={() => setKeyboardJog(!keyboardJog)}
          title={
            keyboardJog
              ? 'Keyboard jog is on: arrow keys and PageUp/PageDown jog one step per press. Click to turn off.'
              : 'Turn on keyboard jog: arrow keys and PageUp/PageDown jog one step per press'
          }
          className={`pressable inline-flex h-7 items-center gap-1.5 rounded-md border px-2 text-[12px] ${
            keyboardJog ? 'border-accent text-accent' : 'border-line text-ink-2 hover-fine:border-ink-3 hover-fine:text-ink'
          }`}
        >
          <Keyboard size={14} aria-hidden />
          Keyboard jog
          <span className={`font-mono text-[11px] font-semibold ${keyboardJog ? '' : 'text-ink-3'}`}>{keyboardJog ? 'On' : 'Off'}</span>
        </button>
      </div>
      <div className="flex items-start justify-center gap-6">
        <div className="grid grid-cols-3 grid-rows-3 gap-1.5" role="group" aria-label="XY jog">
          <DiagonalJogButton x={-1} y={1} icon={<ArrowUpLeft size={arrow} />} {...diag(-1, 1)} onJog={onDiagonal} />
          <JogButton axis="Y" direction={1} icon={<ArrowUp size={arrow} />} {...pad('Y', 1)} onJog={onJog} />
          <DiagonalJogButton x={1} y={1} icon={<ArrowUpRight size={arrow} />} {...diag(1, 1)} onJog={onDiagonal} />
          <JogButton axis="X" direction={-1} icon={<ArrowLeft size={arrow} />} {...pad('X', -1)} onJog={onJog} />
          <button
            type="button"
            aria-label="Stop jog"
            title="Stop jog (cancel the current jog move)"
            disabled={!jog.canCancel}
            onClick={sendJogCancel}
            className="pressable flex h-[52px] w-[52px] items-center justify-center rounded-md border border-line bg-surface text-ink-2 hover-fine:border-ink-3 hover-fine:text-ink disabled:cursor-not-allowed disabled:text-ink-3"
          >
            <Square size={16} fill="currentColor" aria-hidden />
          </button>
          <JogButton axis="X" direction={1} icon={<ArrowRight size={arrow} />} {...pad('X', 1)} onJog={onJog} />
          <DiagonalJogButton x={-1} y={-1} icon={<ArrowDownLeft size={arrow} />} {...diag(-1, -1)} onJog={onDiagonal} />
          <JogButton axis="Y" direction={-1} icon={<ArrowDown size={arrow} />} {...pad('Y', -1)} onJog={onJog} />
          <DiagonalJogButton x={1} y={-1} icon={<ArrowDownRight size={arrow} />} {...diag(1, -1)} onJog={onDiagonal} />
        </div>
        <div className="grid grid-rows-3 gap-1.5" role="group" aria-label="Z jog">
          <JogButton axis="Z" direction={1} icon={<ArrowUp size={arrow} />} {...pad('Z', 1)} onJog={onJog} />
          <span />
          <JogButton axis="Z" direction={-1} icon={<ArrowDown size={arrow} />} {...pad('Z', -1)} onJog={onJog} />
        </div>
      </div>

      {/* Keyboard jog key map (only while it is on) */}
      {keyboardJog ? (
        <div
          role="note"
          aria-label="Keyboard jog keys"
          className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1.5 text-[12px] text-ink-2"
        >
          <span className="inline-flex items-center gap-1 text-accent">
            <Keyboard size={13} aria-hidden />
            Keys
          </span>
          {KEYBOARD_JOG_LEGEND.map((item) => (
            <span key={item.label} className="inline-flex items-center gap-1">
              {item.keys.map((k) => (
                <kbd key={k} className="rounded border border-line bg-surface-2 px-1 font-mono text-[11px] leading-[18px] text-ink">
                  {k}
                </kbd>
              ))}
              <span className="text-ink-3">{item.label}</span>
            </span>
          ))}
        </div>
      ) : null}
      {keyboardJog && keyboard.active && keyboard.reason === null ? (
        <p className="mt-1.5 text-center text-[11px] text-ink-3">One step per key press. Keys are ignored while typing or in a dialog.</p>
      ) : null}

      {/* Travel limits: room left on each limited axis, or what to home */}
      {travel.active && position.ready ? (
        <p className={`mt-3 text-center font-mono text-[11px] tabular-nums ${notHomedAxes.length ? 'text-warn' : 'text-ink-3'}`}>
          {notHomedAxes.length
            ? `${notHomedAxes.join(' and ')} not homed — home the machine to move ${notHomedAxes.join(' and ')}`
            : limitedAxes
                .map((a) => `${a}− ${fmtRoom(travel.axes[a].roomNeg, units)} · ${a}+ ${fmtRoom(travel.axes[a].roomPos, units)}`)
                .join(' · ') + ` ${units} to the travel limits`}
        </p>
      ) : null}

      <TravelSection machine={machine} />

      {/* Go to work zero */}
      <div className="mt-4 flex items-center justify-center gap-4">
        <Button
          variant="secondary"
          onClick={onGoZero}
          disabled={!goZero.enabled}
          disabledReason={goZero.reason}
          onPointerEnter={() => setZeroHover(true)}
          onPointerLeave={() => setZeroHover(false)}
          onFocus={() => setZeroHover(true)}
          onBlur={() => setZeroHover(false)}
          title={goZero.enabled ? zeroPreview : undefined}
          className="min-w-[132px]"
        >
          <Crosshair size={14} aria-hidden />
          Go to zero
        </Button>
        <label className="flex cursor-pointer items-center gap-2 text-[13px] text-ink-2 select-none hover-fine:text-ink">
          <input
            type="checkbox"
            checked={includeZ}
            onChange={(e) => setIncludeZ(e.target.checked)}
            className="h-4 w-4 cursor-pointer accent-accent"
          />
          Include Z
        </label>
      </div>

      <div className="mt-5 grid grid-cols-[44px_1fr] items-center gap-x-3 gap-y-2.5">
        <span className="panel-label">Step</span>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <SegmentedControl
              ariaLabel={`Jog step (${units})`}
              segments={JOG_STEPS[units].map((v) => ({ value: v, label: String(v) }))}
              value={step}
              onChange={setStep}
            />
          </div>
          <span className="w-14 text-[12px] text-ink-3">{units}</span>
        </div>

        <span className="panel-label">Feed</span>
        <div className="flex items-center gap-2">
          <div className="flex-1">
            <SegmentedControl
              ariaLabel={`Jog feed rate (${units}/min)`}
              segments={JOG_FEEDS[units].map((v) => ({ value: v, label: String(v) }))}
              value={JOG_FEEDS[units].includes(feed) ? feed : null}
              onChange={setFeed}
            />
          </div>
          <input
            aria-label={`Custom jog feed rate (${units}/min)`}
            aria-invalid={feedInvalid}
            inputMode="decimal"
            value={feedText}
            onChange={(e) => setFeedText(e.target.value.replace(/[^\d.]/g, ''))}
            onBlur={commitFeed}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            }}
            className={`h-8 w-14 rounded-md border bg-surface-2 px-1.5 text-right font-mono text-[12px] tabular-nums text-ink outline-none focus-visible:border-accent ${
              feedInvalid ? 'border-crit' : 'border-line'
            }`}
          />
        </div>
        <span />
        <span className={`text-[12px] ${feedInvalid ? 'text-crit' : 'text-ink-3'}`}>
          {feedInvalid ? `Feed must be between 0 and ${MAX_JOG_FEED[units]} ${units}/min` : `${units}/min · firmware limits still apply`}
        </span>
      </div>

      <p role="status" className={`mt-4 text-[12px] ${jog.canJog ? 'text-ink-3' : 'text-ink-2'}`}>
        {preview ? (
          <span className="text-accent">{preview}</span>
        ) : zeroHover && goZero.enabled ? (
          <span className={!includeZ && zBelowZero ? 'text-warn' : 'text-accent'}>{zeroPreview}</span>
        ) : (
          jog.reason ?? `Each press moves ${step} ${units} at ${feed} ${units}/min.`
        )}
      </p>
    </FloatingWidget>
  );
}
