'use client';

/**
 * Machine settings (FluidNC config) — stage S1, read only. docs/SETTINGS_EDITOR.md §4.
 *
 * Opens as a panel *below* the top bar (Radix Dialog, non-modal), so Hold and Reset stay reachable.
 * Shows the saved config file, the running config, boot warnings, values that differ between the
 * two, and local file system usage.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, ChevronDown, ChevronRight, FileText, Loader2, RefreshCw, Settings, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { settingsView } from '@/lib/cnc/derive';
import { useMachine } from '@/lib/cnc/store';
import { readMachineConfig, useMachineConfig, type MachineConfigSnapshot } from '@/lib/fluidnc/machineConfig';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

type View = 'saved' | 'running';

/** Path of each YAML line ("axes/x/homing/cycle"), from indentation — enough for FluidNC's block style. */
function linePaths(text: string): (string | null)[] {
  const stack: { indent: number; key: string }[] = [];
  return text.split('\n').map((line) => {
    const m = /^(\s*)([^\s#:][^:#]*?):(\s|$)/.exec(line);
    if (!m) return null;
    const indent = m[1].length;
    while (stack.length && stack[stack.length - 1].indent >= indent) stack.pop();
    stack.push({ indent, key: m[2].trim() });
    return stack.map((e) => e.key).join('/').toLowerCase();
  });
}

function CodeView({ text, differences }: { text: string; differences: Map<string, string> | null }) {
  const lines = useMemo(() => text.replace(/\n$/, '').split('\n'), [text]);
  const paths = useMemo(() => (differences ? linePaths(text) : []), [text, differences]);
  return (
    <div className="min-h-0 overflow-auto rounded-md border border-line bg-bg font-mono text-[12px] leading-[20px]">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => {
            const path = paths[i];
            const running = path && differences ? differences.get(path) : undefined;
            return (
              <tr key={i} className={running !== undefined ? 'bg-warn/10' : undefined}>
                <td className="w-12 pr-3 text-right align-top text-ink-3 select-none">{i + 1}</td>
                <td className="pr-4 whitespace-pre text-ink">
                  {line || ' '}
                  {running !== undefined ? (
                    <span className="ml-3 text-warn" title="Value currently running in FluidNC">
                      ← running: {running || '(empty)'}
                    </span>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function BootLog({ snapshot }: { snapshot: MachineConfigSnapshot }) {
  const [open, setOpen] = useState(false);
  const problems = snapshot.bootLog.filter((l) => l.level === 'warn' || l.level === 'error');
  return (
    <div className="rounded-md border border-line">
      {problems.length > 0 ? (
        <ul className="divide-y divide-line">
          {problems.map((p, i) => (
            <li key={i} className="flex items-start gap-2 px-3 py-2 text-[13px] text-ink">
              <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${p.level === 'error' ? 'text-crit' : 'text-warn'}`} aria-hidden />
              <span>
                <span className={p.level === 'error' ? 'text-crit' : 'text-warn'}>{p.level === 'error' ? 'Boot error' : 'Boot warning'}:</span>{' '}
                {p.text.trim()}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="px-3 py-2 text-[13px] text-ink-2">No warnings or errors in the boot log.</p>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="pressable flex w-full items-center gap-1 border-t border-line px-3 py-1.5 text-[12px] text-ink-3 hover-fine:text-ink"
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        Boot log ({snapshot.bootLog.length} lines)
      </button>
      {open ? (
        <pre className="max-h-56 overflow-auto border-t border-line bg-bg px-3 py-2 font-mono text-[12px] leading-[18px] text-ink-2">
          {snapshot.bootLog.map((l) => `${l.level === 'other' ? '' : `[${l.level.toUpperCase()}] `}${l.text}`).join('\n')}
        </pre>
      ) : null}
    </div>
  );
}

function Sidebar({ snapshot }: { snapshot: MachineConfigSnapshot }) {
  return (
    <aside className="flex min-h-0 flex-col gap-4 overflow-auto">
      <section>
        <h3 className="panel-label mb-2">Saved vs running</h3>
        {snapshot.differences.length === 0 ? (
          <p className="text-[13px] text-ink-2">Every value in {snapshot.filename} matches what FluidNC is running.</p>
        ) : (
          <ul className="space-y-2">
            {snapshot.differences.map((d) => (
              <li key={d.path} className="rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-[12px]">
                <div className="font-mono text-ink">{d.path}</div>
                <div className="mt-1 text-ink-2">
                  file <span className="font-mono text-ink">{d.saved || '(empty)'}</span> · running{' '}
                  <span className="font-mono text-warn">{d.running || '(empty)'}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-2 text-[12px] text-ink-3">
          FluidNC also runs {snapshot.defaultsCount} default values that are not written in the file. See “Running”.
        </p>
      </section>
      <section>
        <h3 className="panel-label mb-2">Controller storage</h3>
        <p className="text-[13px] text-ink-2">
          {snapshot.fs.free ?? '?'} free of {snapshot.fs.total ?? '?'}
        </p>
        <ul className="mt-2 space-y-1">
          {snapshot.fs.files.map((f) => (
            <li key={f.name} className="flex items-center gap-2 text-[12px] text-ink-2">
              <FileText size={12} className="shrink-0 text-ink-3" aria-hidden />
              <span className={`flex-1 truncate font-mono ${f.name === snapshot.filename ? 'text-ink' : ''}`}>{f.name}</span>
              <span className="tabular-nums text-ink-3">{f.size.toLocaleString()} B</span>
            </li>
          ))}
        </ul>
      </section>
    </aside>
  );
}

export function SettingsPanel() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>('saved');
  const machine = useMachine((s) => s);
  const availability = settingsView(machine);
  const { status, snapshot, error } = useMachineConfig();
  const loading = status === 'loading';

  // First open with a usable controller: read once. Later opens keep the last snapshot (Reload refreshes).
  useEffect(() => {
    if (open && availability.enabled && status === 'idle') void readMachineConfig();
  }, [open, availability.enabled, status]);

  const differences = useMemo(
    () => (snapshot ? new Map(snapshot.differences.map((d) => [d.path.toLowerCase(), d.running])) : null),
    [snapshot],
  );

  const firmware = machine.controller.firmware;
  const readAt = snapshot ? new Date(snapshot.readAt).toLocaleTimeString() : null;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" title="Machine settings (FluidNC config)">
          <Settings size={14} aria-hidden />
          Settings
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        {/* Covers the workspace only: the 48 px top bar (Hold/Reset) stays clickable. */}
        <div className="kq-overlay fixed inset-x-0 top-12 bottom-0 z-30 bg-black/60" data-state={open ? 'open' : 'closed'} aria-hidden />
        <Dialog.Content
          className="kq-overlay fixed inset-x-0 top-12 bottom-0 z-30 flex justify-center p-4 outline-none"
          onInteractOutside={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <div className="flex h-full w-full max-w-[1100px] flex-col rounded-lg border border-line bg-surface shadow-2xl">
            <header className="flex items-center gap-3 border-b border-line px-4 py-3">
              <div className="min-w-0 flex-1">
                <Dialog.Title className="text-[15px] font-semibold text-ink">Machine settings</Dialog.Title>
                <p className="truncate text-[12px] text-ink-3">
                  {[snapshot?.filename ?? 'FluidNC config', firmware, readAt ? `read ${readAt}` : null].filter(Boolean).join(' · ')}
                </p>
              </div>
              <SegmentedControl
                ariaLabel="Config view"
                segments={[
                  { value: 'saved', label: 'Saved' },
                  { value: 'running', label: 'Running' },
                ]}
                value={view}
                onChange={setView}
                disabled={!snapshot}
              />
              <Button
                variant="secondary"
                onClick={() => void readMachineConfig()}
                disabled={!availability.enabled || loading}
                disabledReason={loading ? 'Reading…' : availability.reason}
                title="Read the config from the controller again"
              >
                {loading ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
                Reload
              </Button>
              <Dialog.Close asChild>
                <button type="button" className="pressable rounded p-1.5 text-ink-3 hover-fine:text-ink" aria-label="Close settings">
                  <X size={16} aria-hidden />
                </button>
              </Dialog.Close>
            </header>

            {error ? (
              <div role="alert" className="flex items-center gap-2 border-b border-crit/40 bg-crit/10 px-4 py-2 text-[13px] text-ink">
                <AlertTriangle size={14} className="text-crit" aria-hidden />
                <span>Could not read the config: {error}</span>
              </div>
            ) : null}

            <div className="min-h-0 flex-1 p-4">
              {snapshot ? (
                <div className="grid h-full min-h-0 grid-cols-[1fr_300px] gap-4">
                  <div className="flex min-h-0 flex-col gap-3">
                    <BootLog snapshot={snapshot} />
                    <CodeView
                      text={view === 'saved' ? snapshot.saved : snapshot.running}
                      differences={view === 'saved' ? differences : null}
                    />
                  </div>
                  <Sidebar snapshot={snapshot} />
                </div>
              ) : (
                <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[13px] text-ink-2">
                  {loading ? (
                    <>
                      <Loader2 size={18} className="animate-spin text-ink-3" aria-hidden />
                      Reading the config from the controller…
                    </>
                  ) : !availability.enabled ? (
                    <>
                      <Settings size={18} className="text-ink-3" aria-hidden />
                      {availability.reason}
                    </>
                  ) : (
                    <Button variant="primary" onClick={() => void readMachineConfig()}>
                      Read config
                    </Button>
                  )}
                </div>
              )}
            </div>

            <footer className="flex items-center gap-2 border-t border-line px-4 py-2 text-[12px] text-ink-3">
              <span className="flex-1">
                Read-only. Editing and saving come in the next stage. Reading pauses jog, homing and job start for about two
                seconds.
              </span>
              {snapshot && !availability.enabled && !loading ? <span>Reload unavailable: {availability.reason}</span> : null}
            </footer>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
