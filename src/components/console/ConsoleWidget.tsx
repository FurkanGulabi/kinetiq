'use client';

/**
 * Console widget (IMPLEMENTATION_PLAN M3, ARCHITECTURE §10.8): the controller's traffic and a line
 * to type commands into. Floating like the other widgets; collapsed (the default), the header
 * shows the latest meaningful line.
 *
 * - Rows are classed per API_REFERENCE §6.1: errors and alarms in red, [MSG:] lines with their
 *   level, `ok` de-emphasised, writes prefixed with › (another tab's writes and Kinetiq's own
 *   server-side sequences are labelled).
 * - Follows the newest line until the user scrolls up; "Jump to latest" brings it back.
 * - While the controller is in Alarm, the latest ALARM line stays pinned at the top.
 * - Input: Enter sends with `writeln` (consoleView guard), ↑/↓ walk this tab's history, Esc clears.
 */
import { AlertTriangle, ArrowDown, CornerDownLeft, Eraser, Info, OctagonX } from 'lucide-react';
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { FloatingWidget } from '@/components/ui/FloatingWidget';
import { Button } from '@/components/ui/Button';
import { sendLine } from '@/lib/cnc/client';
import { clearConsole, loadHistory, pushHistory, useConsole, type ConsoleEntry } from '@/lib/cnc/console-store';
import { consoleView } from '@/lib/cnc/derive';
import { useMachine } from '@/lib/cnc/store';

const LIST_HEIGHT = 300;
/** Distance from the bottom (px) within which the list counts as "at the latest line". */
const STICK_SLACK = 24;

const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const Row = memo(function Row({ entry }: { entry: ConsoleEntry }) {
  const title = timeFormat.format(entry.time);
  switch (entry.kind) {
    case 'out':
      return (
        <div className="flex gap-2 text-ink" title={title}>
          <span className={entry.origin === 'self' ? 'text-accent' : 'text-ink-3'} aria-hidden>
            ›
          </span>
          <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{entry.text}</span>
          {entry.origin !== 'self' ? (
            <span className="shrink-0 self-center rounded bg-surface-2 px-1 text-[10px] tracking-[0.04em] text-ink-3 uppercase">
              {entry.origin === 'other' ? 'other tab' : 'kinetiq'}
            </span>
          ) : null}
        </div>
      );
    case 'ok':
      return (
        <div className="pl-4 text-[11.5px] text-ink-3/70" title={title}>
          ok
        </div>
      );
    case 'error':
    case 'alarm':
      return (
        <div
          className={`-mx-2 flex gap-1.5 rounded px-2 py-px text-crit ${entry.kind === 'alarm' ? 'bg-crit/12 font-semibold' : 'bg-crit/8'}`}
          title={title}
        >
          <OctagonX size={12} className="mt-[3px] shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{entry.text}</span>
        </div>
      );
    case 'msg': {
      const Icon = entry.level === 'err' ? OctagonX : entry.level === 'warn' ? AlertTriangle : Info;
      const tone = entry.level === 'err' ? 'text-crit' : entry.level === 'warn' ? 'text-warn' : 'text-[#8fb8d6]';
      return (
        <div className={`flex gap-1.5 pl-4 ${tone}`} title={title}>
          <Icon size={12} className="mt-[3px] shrink-0" aria-hidden />
          <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{entry.text}</span>
        </div>
      );
    }
    case 'program':
      return (
        <div className="pl-4 text-ink-3 italic" title={title}>
          {entry.text}
        </div>
      );
    default: // status, response
      return (
        <div className="pl-4 break-all whitespace-pre-wrap text-ink-2" title={title}>
          {entry.text}
        </div>
      );
  }
});

/** The log rows; re-rendered only when the entries change (typing in the input does not). */
const Rows = memo(function Rows({ entries }: { entries: ConsoleEntry[] }) {
  return entries.map((entry) => <Row key={entry.id} entry={entry} />);
});

/** Collapsed header: the newest line that says something (not `ok`). */
function Summary({ entries }: { entries: ConsoleEntry[] }) {
  let last: ConsoleEntry | undefined;
  for (let i = entries.length - 1; i >= 0; i--) {
    if (entries[i].kind !== 'ok') {
      last = entries[i];
      break;
    }
  }
  if (!last) return <span className="text-ink-3">No traffic yet</span>;
  const tone =
    last.kind === 'error' || last.kind === 'alarm' || last.level === 'err'
      ? 'text-crit'
      : last.level === 'warn'
        ? 'text-warn'
        : last.kind === 'out'
          ? 'text-ink'
          : 'text-ink-2';
  return (
    <span className={`truncate font-mono text-[11.5px] ${tone}`} title={last.text}>
      {last.kind === 'out' ? '› ' : ''}
      {last.text}
    </span>
  );
}

export function ConsoleWidget() {
  const entries = useConsole();
  // Primitive selections only: status reports arrive several times a second, and the log should
  // re-render when its lines change, not on every report.
  const blockedReason = useMachine((s) => {
    const g = consoleView(s);
    return g.enabled ? null : (g.reason ?? 'Not available');
  });
  const gate = blockedReason === null ? { enabled: true as const, reason: undefined } : { enabled: false as const, reason: blockedReason };
  const inAlarm = useMachine((s) => s.controller.state?.status.activeState === 'Alarm');

  const listRef = useRef<HTMLDivElement>(null);
  const [stick, setStick] = useState(true);
  const seenId = useRef(0); // newest entry id seen while following
  const [unread, setUnread] = useState(0);

  const [text, setText] = useState('');
  const [history, setHistory] = useState<string[]>([]);
  const historyIndex = useRef<number | null>(null);
  const draft = useRef('');
  useEffect(() => setHistory(loadHistory()), []);

  const pinnedAlarm = useMemo(() => {
    if (!inAlarm) return null;
    for (let i = entries.length - 1; i >= 0; i--) if (entries[i].kind === 'alarm') return entries[i];
    return null;
  }, [entries, inAlarm]);

  // Follow the newest line, or count what arrived while the user reads further up.
  useLayoutEffect(() => {
    const el = listRef.current;
    const newest = entries.length ? entries[entries.length - 1].id : 0;
    if (!el) return;
    if (stick) {
      el.scrollTop = el.scrollHeight;
      seenId.current = newest;
      setUnread(0);
    } else {
      setUnread(entries.filter((e) => e.id > seenId.current).length);
    }
  }, [entries, stick]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const atBottom = el.scrollTop + el.clientHeight >= el.scrollHeight - STICK_SLACK;
    if (atBottom !== stick) setStick(atBottom);
  };

  const jumpToLatest = () => {
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth' });
    setStick(true);
  };

  const send = () => {
    const line = text.trim();
    if (!line || !gate.enabled) return;
    sendLine(line);
    setHistory((h) => pushHistory(h, line));
    historyIndex.current = null;
    setText('');
    setStick(true);
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send();
    } else if (e.key === 'Escape') {
      setText('');
      historyIndex.current = null;
    } else if (e.key === 'ArrowUp' && history.length) {
      e.preventDefault();
      if (historyIndex.current === null) {
        draft.current = text;
        historyIndex.current = history.length - 1;
      } else historyIndex.current = Math.max(0, historyIndex.current - 1);
      setText(history[historyIndex.current]);
    } else if (e.key === 'ArrowDown' && historyIndex.current !== null) {
      e.preventDefault();
      const next = historyIndex.current + 1;
      if (next >= history.length) {
        historyIndex.current = null;
        setText(draft.current);
      } else {
        historyIndex.current = next;
        setText(history[next]);
      }
    }
  };

  return (
    <FloatingWidget id="console" index={3} title="Console" summary={<Summary entries={entries} />}>
      <div className="relative">
        <div
          ref={listRef}
          onScroll={onScroll}
          role="log"
          aria-live="polite"
          aria-label="Controller console"
          className="overflow-y-auto rounded-lg border border-line bg-black/25 px-2 py-1.5 font-mono text-[12.5px] leading-[1.5]"
          style={{ height: LIST_HEIGHT }}
        >
          {pinnedAlarm ? (
            <div className="sticky -top-1.5 z-10 -mx-2 -mt-1.5 mb-1 flex gap-1.5 border-b border-crit/40 bg-[#2a1416]/95 px-2 py-1 font-semibold text-crit backdrop-blur">
              <OctagonX size={12} className="mt-[3px] shrink-0" aria-hidden />
              <span className="min-w-0 flex-1 break-all">{pinnedAlarm.text}</span>
            </div>
          ) : null}
          {entries.length === 0 ? (
            <p className="py-6 text-center font-sans text-[12px] text-ink-3">
              Lines to and from the controller appear here. Try <span className="font-mono text-ink-2">$I</span> or{' '}
              <span className="font-mono text-ink-2">?</span>.
            </p>
          ) : (
            <Rows entries={entries} />
          )}
        </div>
        {!stick && unread > 0 ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="kq-alert pressable glass absolute right-3 bottom-3 flex items-center gap-1.5 rounded-full px-3 py-1 text-[12px] text-ink"
          >
            <ArrowDown size={12} aria-hidden />
            Jump to latest · {unread > 999 ? '999+' : unread}
          </button>
        ) : null}
      </div>

      <form
        className="mt-2 flex items-center gap-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          send();
        }}
      >
        <input
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            historyIndex.current = null;
          }}
          onKeyDown={onKeyDown}
          disabled={!gate.enabled}
          aria-label="Command"
          placeholder={gate.enabled ? 'Command: $$, $I, ?, G0 X10…' : gate.reason}
          spellCheck={false}
          autoCapitalize="off"
          autoComplete="off"
          className="h-8 min-w-0 flex-1 rounded-md border border-line bg-surface-2 px-2.5 font-mono text-[12.5px] text-ink placeholder:font-sans placeholder:text-ink-3 focus:border-accent focus:outline-none disabled:cursor-not-allowed disabled:opacity-60"
        />
        <Button type="submit" variant="primary" disabled={!gate.enabled || !text.trim()} disabledReason={gate.enabled ? undefined : gate.reason} aria-label="Send">
          <CornerDownLeft size={14} aria-hidden />
        </Button>
        <Button type="button" variant="ghost" onClick={clearConsole} title="Clear the console view" aria-label="Clear console" className="w-8 px-0!">
          <Eraser size={14} aria-hidden />
        </Button>
      </form>
      <p className="mt-1.5 text-[11px] text-ink-3">
        Sent directly to the controller. Lines run immediately, including motion; no confirmation.
      </p>
    </FloatingWidget>
  );
}
