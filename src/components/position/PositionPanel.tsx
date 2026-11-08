'use client';

/**
 * Widget 3 — Coordinates & Jog. docs/ARCHITECTURE.md §10.4, docs/API_REFERENCE.md §8–9.
 *
 * Readout: work (primary) and machine (secondary) X/Y/Z from controller:state.
 * Per axis (AxisRow): Go to (absolute jog), Zero (G10 L20), Home ($H<axis>).
 * Jog: one `$J=` line per press through the CNCjs Feeder; centre button = jog cancel (0x85).
 * No optimistic state — the readout only changes when the controller reports a new position.
 */
import { ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Square } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { sendCommand, sendGcode } from '@/lib/cnc/client';
import { isValidFeed, JOG_FEEDS, JOG_STEPS, jogLine, MAX_JOG_FEED, type JogAxis, type Units } from '@/lib/cnc/commands';
import { axisControlsView, jogView, positionView, reportUnits } from '@/lib/cnc/derive';
import { useMachine } from '@/lib/cnc/store';
import { Panel } from '@/components/ui/Panel';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { AxisRow } from './AxisRow';

const PREFS_KEY = 'kinetiq.jog';

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

function JogButton({
  axis,
  direction,
  icon,
  disabled,
  onJog,
  className = '',
}: {
  axis: JogAxis;
  direction: 1 | -1;
  icon: React.ReactNode;
  disabled: boolean;
  onJog: (axis: JogAxis, direction: 1 | -1) => void;
  className?: string;
}) {
  const label = `${axis}${direction > 0 ? '+' : '−'}`;
  return (
    <button
      type="button"
      aria-label={`Jog ${axis} ${direction > 0 ? 'positive' : 'negative'}`}
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

  const onJog = (axis: JogAxis, direction: 1 | -1) => {
    if (!jog.canJog) return;
    sendGcode(jogLine(axis, direction, step, feed, units));
  };

  const feedValue = Number(feedText);
  const feedInvalid = feedText !== '' && !isValidFeed(feedValue, units);
  const commitFeed = () => {
    if (isValidFeed(feedValue, units)) setFeed(feedValue);
    else setFeedText(String(feed));
  };

  const arrow = 14;

  return (
    <Panel
      title="Position"
      actions={
        <span className="font-mono">
          {position.wcs} · {units}
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
            controls={axisControls}
            onPreview={onPreview}
          />
        ))}
      </div>

      <div className="my-5 h-px bg-line" aria-hidden />

      {/* Jog */}
      <h3 className="panel-label mb-3">Jog</h3>
      <div className="flex items-start justify-center gap-6">
        <div className="grid grid-cols-3 grid-rows-3 gap-1.5" role="group" aria-label="XY jog">
          <span />
          <JogButton axis="Y" direction={1} icon={<ArrowUp size={arrow} />} disabled={!jog.canJog} onJog={onJog} />
          <span />
          <JogButton axis="X" direction={-1} icon={<ArrowLeft size={arrow} />} disabled={!jog.canJog} onJog={onJog} />
          <button
            type="button"
            aria-label="Stop jog"
            title="Stop jog (cancel the current jog move)"
            disabled={!jog.canCancel}
            onClick={() => sendCommand('jogCancel')}
            className="pressable flex h-[52px] w-[52px] items-center justify-center rounded-md border border-line bg-surface text-ink-2 hover-fine:border-ink-3 hover-fine:text-ink disabled:cursor-not-allowed disabled:text-ink-3"
          >
            <Square size={16} fill="currentColor" aria-hidden />
          </button>
          <JogButton axis="X" direction={1} icon={<ArrowRight size={arrow} />} disabled={!jog.canJog} onJog={onJog} />
          <span />
          <JogButton axis="Y" direction={-1} icon={<ArrowDown size={arrow} />} disabled={!jog.canJog} onJog={onJog} />
          <span />
        </div>
        <div className="grid grid-rows-3 gap-1.5" role="group" aria-label="Z jog">
          <JogButton axis="Z" direction={1} icon={<ArrowUp size={arrow} />} disabled={!jog.canJog} onJog={onJog} />
          <span />
          <JogButton axis="Z" direction={-1} icon={<ArrowDown size={arrow} />} disabled={!jog.canJog} onJog={onJog} />
        </div>
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
        {preview ? <span className="text-accent">{preview}</span> : jog.reason ?? `Each press moves ${step} ${units} at ${feed} ${units}/min.`}
      </p>
    </Panel>
  );
}
