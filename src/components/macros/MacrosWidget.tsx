'use client';

/**
 * Macros widget (ARCHITECTURE §10.10): saved G-code snippets, each with Run, Edit and Delete, plus
 * Add macro. Starts collapsed; collapsed, the header shows the number of macros or what the Feeder
 * is doing.
 *
 * - Run sends only the macro id (`macro:run`); the backend reads the content, refuses when the
 *   machine is not ready (console `[MSG:WARN: Kinetiq: …]`) and queues the lines on the Feeder, so
 *   jogs stay inside the travel limits. The gate is derive.macroView, the same rules as the backend.
 * - A running macro is stopped with the top-bar controls: Hold stops the motion, Reset clears the
 *   lines still queued (stated in the widget while lines are being sent).
 * - The list comes from the macro API (lib/macros/library.ts), not from machine state; editing needs
 *   no connection.
 */
import { AlertTriangle, ListPlus, Pause, Pencil, Play, Plus, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { FloatingWidget } from '@/components/ui/FloatingWidget';
import { runMacro } from '@/lib/cnc/client';
import { macroView } from '@/lib/cnc/derive';
import { useMachine } from '@/lib/cnc/store';
import { deleteMacro, refreshMacros, useMacroLibrary, type Macro } from '@/lib/macros/library';
import { macroLines } from '@/lib/macros/macro';
import { useLayout } from '@/lib/ui/layout';
import { MacroDialog } from './MacroDialog';

export function MacrosWidget() {
  const library = useMacroLibrary();
  const collapsed = useLayout((l) => l.widgets.macros.collapsed);
  // Primitive selections only (status reports arrive several times a second).
  const runReason = useMachine((s) => {
    const run = macroView(s).run;
    return run.enabled ? null : (run.reason ?? 'Not available');
  });
  const feederPhase = useMachine((s) => macroView(s).feeder?.phase ?? null);
  const feederQueued = useMachine((s) => macroView(s).feeder?.queued ?? 0);

  const [editing, setEditing] = useState<{ macro: Macro | null } | null>(null);
  const [deleting, setDeleting] = useState<Macro | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // Refresh on mount, whenever the widget is opened, and when the tab comes back into view, so a
  // change made in another tab shows up.
  useEffect(() => {
    if (!collapsed) void refreshMacros();
  }, [collapsed]);
  useEffect(() => {
    void refreshMacros();
    const onVisible = () => {
      if (document.visibilityState === 'visible') void refreshMacros();
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  const macros = library.macros;
  const canRun = runReason === null;

  const summary =
    feederPhase === 'held' ? (
      <span className="flex items-center gap-1.5 text-warn">
        <Pause size={12} aria-hidden /> Commands held
      </span>
    ) : feederPhase === 'sending' ? (
      <span className="flex items-center gap-1.5 text-accent">
        <Play size={12} aria-hidden /> Sending · {feederQueued} queued
      </span>
    ) : (
      <span className="text-ink-3">
        {library.status === 'ready' ? `${macros.length} macro${macros.length === 1 ? '' : 's'}` : library.status === 'error' ? 'Unavailable' : ''}
      </span>
    );

  const onDelete = async (macro: Macro) => {
    setNotice(null);
    try {
      await deleteMacro(macro.id);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not delete the macro');
    }
  };

  return (
    <FloatingWidget id="macros" index={4} title="Macros" summary={summary}>
      <div className="flex flex-col gap-2.5">
        {library.status === 'error' && macros.length === 0 ? (
          <p className="flex items-start gap-2 py-4 text-[12px] text-ink-2">
            <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-crit" />
            <span>Could not load the macros: {library.error}</span>
          </p>
        ) : library.status !== 'ready' && macros.length === 0 ? (
          <p className="py-6 text-center text-[12px] text-ink-3">Loading macros…</p>
        ) : macros.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-5 text-center">
            <ListPlus size={20} aria-hidden className="text-ink-3" />
            <p className="max-w-[300px] text-[12px] leading-[17px] text-ink-2">
              No macros yet. A macro is a named set of G-code lines, such as parking the spindle, that you run with one click.
            </p>
            <Button variant="primary" onClick={() => setEditing({ macro: null })}>
              <Plus size={14} aria-hidden />
              Add macro
            </Button>
          </div>
        ) : (
          <ul className="-mx-1 max-h-[280px] overflow-y-auto" aria-label="Macros">
            {macros.map((macro) => {
              const lines = macroLines(macro.content);
              return (
                <li key={macro.id} className="flex items-center gap-2 rounded-md px-1 py-1.5 hover-fine:bg-surface-2/50">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-[13px] text-ink" title={macro.name}>
                      {macro.name}
                    </div>
                    <div className="truncate font-mono text-[11px] text-ink-3" title={macro.content}>
                      {lines.length} line{lines.length === 1 ? '' : 's'} · {lines[0] ?? ''}
                    </div>
                  </div>
                  <Button
                    variant="secondary"
                    onClick={() => runMacro(macro.id)}
                    disabled={!canRun}
                    disabledReason={runReason ?? undefined}
                    title={`Run “${macro.name}”: sends ${lines.length} line${lines.length === 1 ? '' : 's'} to the controller now`}
                    aria-label={`Run ${macro.name}`}
                  >
                    <Play size={13} aria-hidden />
                    Run
                  </Button>
                  <Button variant="ghost" onClick={() => setEditing({ macro })} title="Edit" aria-label={`Edit ${macro.name}`} className="w-8 px-0!">
                    <Pencil size={14} aria-hidden />
                  </Button>
                  <Button variant="ghost" onClick={() => setDeleting(macro)} title="Delete" aria-label={`Delete ${macro.name}`} className="w-8 px-0!">
                    <Trash2 size={14} aria-hidden />
                  </Button>
                </li>
              );
            })}
          </ul>
        )}

        {notice ? (
          <p role="alert" className="flex items-start gap-2 text-[12px] text-ink-2">
            <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-crit" />
            <span>{notice}</span>
          </p>
        ) : null}

        {feederPhase ? (
          <p role="status" className="flex items-start gap-2 rounded-md border border-line bg-surface-2/60 px-2.5 py-2 text-[12px] text-ink-2">
            {feederPhase === 'held' ? (
              <Pause size={13} aria-hidden className="mt-0.5 shrink-0 text-warn" />
            ) : (
              <Play size={13} aria-hidden className="mt-0.5 shrink-0 text-accent" />
            )}
            <span>
              {feederPhase === 'held' ? (
                <>
                  <span className="text-warn">Commands held</span> at M0/M1/M6. Reset in the top bar clears them.
                </>
              ) : (
                <>
                  <span className="text-accent">Sending</span>
                  {feederQueued > 0 ? ` · ${feederQueued} line${feederQueued === 1 ? '' : 's'} queued` : ''}. To stop: Hold, then Reset in the top bar
                  (Reset clears the queued lines).
                </>
              )}
            </span>
          </p>
        ) : null}

        {macros.length > 0 ? (
          <div className="flex items-center gap-2">
            <Button variant="secondary" onClick={() => setEditing({ macro: null })}>
              <Plus size={14} aria-hidden />
              Add macro
            </Button>
            <span className="min-w-0 flex-1 truncate text-right text-[12px] text-ink-3" title={runReason ?? undefined}>
              {runReason ? `Run unavailable: ${runReason}` : 'Run sends the lines immediately, motion included.'}
            </span>
          </div>
        ) : null}
      </div>

      <MacroDialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)} macro={editing?.macro ?? null} />
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title="Delete macro?"
        description={
          <>
            “{deleting?.name}” will be removed for every browser using this Kinetiq server. This cannot be undone.
          </>
        }
        confirmLabel="Delete"
        cancelLabel="Keep"
        onConfirm={() => {
          if (deleting) void onDelete(deleting);
        }}
      />
    </FloatingWidget>
  );
}
