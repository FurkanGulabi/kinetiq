'use client';

/**
 * Widget 4: Job Status and job controls (docs/ARCHITECTURE.md §10.5, API_REFERENCE.md §7).
 * State comes from workflow:state + sender:status; gating and timing live in derive.jobView().
 * Floating widget; collapsed, the header keeps the status badge, progress and file name.
 */
import { AlertTriangle, FileCode2, FolderOpen, Info, Loader2, Pause, Play, Square, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { clearStopFailure, sendCommand, stopJob } from '@/lib/cnc/client';
import { jobStatus, jobView, levelingDrift, runErrors, type JobStatus } from '@/lib/cnc/derive';
import { getState, subscribe, useMachine } from '@/lib/cnc/store';
import {
  formatBytes,
  loadJob,
  middleTruncate,
  recordRun,
  refreshJobs,
  useJobLibrary,
  type JobRecord,
  type JobRunStatus,
} from '@/lib/jobs/library';
import { Button } from '@/components/ui/Button';
import { ConfirmDialog } from '@/components/ui/ConfirmDialog';
import { Meter } from '@/components/ui/Meter';
import { FloatingWidget } from '@/components/ui/FloatingWidget';
import { StatusBadge, type BadgeIcon } from '@/components/ui/StatusBadge';
import { Overrides } from './Overrides';
import { RecentJobs } from './RecentJobs';
import { UploadDialog } from './UploadDialog';

const BADGE_ICON: Record<JobStatus, BadgeIcon> = {
  idle: 'idle',
  running: 'play',
  paused: 'pause',
  error: 'warning',
  completed: 'check',
  cancelled: 'stop',
};

const pad = (n: number) => String(n).padStart(2, '0');

function clock(ts: number | null): string {
  if (!ts) return '—';
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function duration(ms: number | null): string {
  if (ms === null) return '—';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  return `${h}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

function estimate(ms: number | null, paused: boolean): string {
  if (ms === null) return '—';
  const s = Math.round(ms / 1000);
  const text = s < 60 ? `${s} s` : s < 3600 ? `${Math.round(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min`;
  return `≈ ${text}${paused ? ' (paused)' : ''}`;
}

/** Re-renders every second while a job clock is running. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [active]);
  return active ? now : Date.now();
}

/**
 * Records the outcome of each run in the job library: when the workflow returns to idle, the run
 * ended Completed (finishTime set, no errors), Error (a controller error or Error state was seen)
 * or Cancelled. Watches the store imperatively; duplicates are keyed by job id + start time.
 */
function useRunRecorder(): void {
  useEffect(() => {
    let prevWorkflow = getState().workflow;
    let sawError = false;
    const recorded = new Set<string>();
    return subscribe(() => {
      const s = getState();
      if (s.workflow !== 'idle' && jobStatus(s) === 'error') sawError = true;
      if (s.workflow === prevWorkflow) return;
      const ended = prevWorkflow !== 'idle' && s.workflow === 'idle';
      if (prevWorkflow === 'idle') sawError = false; // a new run started
      prevWorkflow = s.workflow;
      if (!ended) return;
      const jobId = s.program?.jobId;
      const startedAt = s.sender?.startTime;
      if (!jobId || !startedAt) return;
      const key = `${jobId}:${startedAt}`;
      if (recorded.has(key)) return;
      recorded.add(key);
      const finishTime = s.sender?.finishTime ?? 0;
      const errored = sawError || runErrors(s).length > 0;
      const outcome: JobRunStatus = errored ? 'error' : finishTime > 0 ? 'completed' : 'cancelled';
      void recordRun(jobId, { status: outcome, startedAt, endedAt: finishTime || Date.now() });
    });
  }, []);
}

function Stat({ label, value, hint }: { label: string; value: string; hint: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <div className="panel-label text-[10px]">{label}</div>
      <div className="mt-0.5 font-mono text-[13px] text-ink tabular-nums">{value}</div>
    </div>
  );
}

const QUICK_RECENT = 3;

export function JobPanel() {
  const machine = useMachine((s) => s);
  const library = useJobLibrary();
  const clockRunning = machine.workflow !== 'idle';
  const now = useNow(clockRunning);
  const view = jobView(machine, now);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadErrorTimer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useRunRecorder();

  useEffect(() => {
    void refreshJobs();
  }, []);

  // Close the stop confirmation if the job ends on its own while it is open.
  useEffect(() => {
    if (machine.workflow === 'idle') setConfirmStop(false);
  }, [machine.workflow]);

  const showLoadError = (message: string) => {
    setLoadError(message);
    clearTimeout(loadErrorTimer.current);
    loadErrorTimer.current = setTimeout(() => setLoadError(null), 6000);
  };

  const quickLoad = async (job: JobRecord) => {
    setBusyId(job.id);
    try {
      await loadJob(job);
    } catch (err) {
      showLoadError(err instanceof Error ? err.message : 'Could not load the job');
    } finally {
      setBusyId(null);
    }
  };

  // Cancelled runs are rewound by the backend; keep the progress last seen during this run (session only).
  const lastProgress = useRef<{ startTime: number; received: number } | null>(null);
  if (view.startTime && view.progress && (view.status === 'running' || view.status === 'paused' || view.status === 'error')) {
    lastProgress.current = { startTime: view.startTime, received: view.progress.received };
  }
  if (view.status === 'cancelled' && view.progress && lastProgress.current?.startTime === view.startTime) {
    const received = lastProgress.current.received;
    view.progress = { ...view.progress, received, percent: (received / view.progress.total) * 100 };
  }

  const record = view.program?.jobId ? library.jobs.find((j) => j.id === view.program?.jobId) : undefined;
  const leveled = machine.program?.leveling ?? null;
  const leveledDrift = leveled ? levelingDrift(machine, leveled) : null;
  const meterTone =
    view.status === 'completed' ? 'ok' : view.status === 'error' ? 'crit' : view.status === 'paused' ? 'warn' : view.status === 'cancelled' ? 'neutral' : 'accent';
  const paused = view.status === 'paused';

  return (
    <FloatingWidget
      id="job"
      index={1}
      title="Job"
      summary={
        view.program ? (
          <>
            {view.progress && (view.status === 'running' || view.status === 'paused' || view.status === 'error') ? (
              <span className="shrink-0 font-mono text-ink tabular-nums">{Math.floor(view.progress.percent)}%</span>
            ) : null}
            <span className="truncate" title={view.program.name}>
              {view.program.name}
            </span>
          </>
        ) : (
          <span className="text-ink-3">No program</span>
        )
      }
      actions={
        <StatusBadge
          tone={view.tone}
          icon={view.stopping ? 'busy' : BADGE_ICON[view.status]}
          label={view.stopping ? 'Stopping…' : view.label}
        />
      }
    >
      {view.program ? (
        <div className="flex flex-col gap-3">
          {/* Program */}
          <div className="flex items-center gap-3">
            <FileCode2 size={18} aria-hidden className="shrink-0 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[14px] font-medium text-ink" title={view.program.name}>
                {middleTruncate(view.program.name, 56)}
              </div>
              <div className="text-[11px] text-ink-3 tabular-nums">
                {view.program.lines.toLocaleString()} lines
                {record ? ` · ${formatBytes(record.size)}` : ''}
                {leveled ? (
                  <span className={leveledDrift ? 'text-warn' : 'text-accent'} title={leveledDrift ?? `Height-map leveled from ${leveled.sourceName}`}>
                    {' · '}
                    {leveledDrift ? 'Leveled — map no longer lines up' : 'Leveled'}
                  </span>
                ) : null}
              </div>
            </div>
            <Button
              variant="ghost"
              className="h-7 px-2 text-[12px]"
              onClick={() => setUploadOpen(true)}
              disabled={!view.canLoad.enabled}
              disabledReason={view.canLoad.reason}
            >
              <FolderOpen size={14} aria-hidden />
              Open…
            </Button>
            <button
              type="button"
              onClick={() => sendCommand('gcode:unload')}
              disabled={!view.canUnload.enabled}
              aria-label="Unload program"
              title={view.canUnload.enabled ? 'Unload program' : view.canUnload.reason}
              className="pressable rounded p-1.5 text-ink-3 hover-fine:bg-surface-2 hover-fine:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            >
              <X size={14} aria-hidden />
            </button>
          </div>

          {view.reason ? (
            <p
              role={view.status === 'error' ? 'alert' : 'status'}
              className="flex items-start gap-2 rounded-md border border-line bg-surface-2 px-3 py-2 text-[12px] text-ink"
            >
              {view.status === 'error' ? (
                <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-crit" />
              ) : (
                <Pause size={13} aria-hidden className="mt-0.5 shrink-0 text-warn" />
              )}
              <span className="min-w-0 break-words">
                {view.reason}
                {view.status === 'error' && machine.workflow === 'paused' && machine.controller.state?.status.activeState !== 'Alarm'
                  ? ' — Resume continues after this line; Stop cancels the job.'
                  : null}
              </span>
            </p>
          ) : null}

          {/* Progress */}
          <div className="flex items-end gap-4">
            <div className="flex-1 pb-1.5">
              <Meter value={view.progress?.percent ?? 0} tone={meterTone} label="Job progress" />
            </div>
            <div className="w-[120px] text-right">
              <div className="text-[28px] leading-none font-semibold text-ink">
                {Math.floor(view.progress?.percent ?? 0)}
                <span className="text-[16px] font-medium text-ink-3">%</span>
              </div>
              <div
                className="mt-1 font-mono text-[11px] text-ink-3 tabular-nums"
                title={`Acknowledged / total lines (incl. the final planner-drain line). Sent: ${view.progress?.sent ?? 0}`}
              >
                {(view.progress?.received ?? 0).toLocaleString()} / {(view.progress?.total ?? 0).toLocaleString()}
              </div>
            </div>
          </div>

          {/* Times */}
          <div className="grid grid-cols-4 gap-4 border-t border-line pt-3">
            <Stat label="Started" value={clock(view.startTime)} hint="Server clock when the first line was sent." />
            <Stat
              label="Elapsed"
              value={duration(view.elapsedMs)}
              hint="Wall-clock time since start, including pauses."
            />
            <Stat
              label="Remaining"
              value={estimate(view.remainingMs, paused)}
              hint="Estimate: assumes every line takes the same time. Appears after the first second."
            />
            <Stat
              label="Finished"
              value={clock(view.finishTime)}
              hint="Exact time the planner drained. Shown only when the job completes."
            />
          </div>

          <Overrides />

          {/* Controls */}
          <div className="flex items-center gap-2 border-t border-line pt-3">
            <div className="min-w-0 flex-1 text-[12px] text-ink-3">
              {view.stopFailure ? (
                <span role="alert" className="flex items-center gap-1.5 text-ink">
                  <AlertTriangle size={13} aria-hidden className="shrink-0 text-crit" />
                  <span className="truncate" title={view.stopFailure}>
                    {view.stopFailure}
                  </span>
                  <button type="button" onClick={clearStopFailure} className="text-ink-3 underline hover-fine:text-ink">
                    Dismiss
                  </button>
                </span>
              ) : view.stopping ? (
                <span className="flex items-center gap-1.5">
                  <Loader2 size={13} aria-hidden className="animate-spin motion-reduce:animate-none" />
                  Holding, then cancelling the program…
                </span>
              ) : !view.start.enabled && machine.workflow === 'idle' ? (
                <span className="flex items-center gap-1.5">
                  <Info size={13} aria-hidden className="shrink-0" />
                  <span className="truncate">{view.start.reason}</span>
                </span>
              ) : null}
            </div>
            <Button
              variant="primary"
              className="min-w-[92px]"
              onClick={() => sendCommand('gcode:start')}
              disabled={!view.start.enabled}
              disabledReason={view.start.reason}
            >
              <Play size={14} aria-hidden />
              {view.startTime && machine.workflow === 'idle' ? 'Run again' : 'Start'}
            </Button>
            {view.pauseMode === 'pause' ? (
              <Button
                variant="warn"
                className="min-w-[92px]"
                onClick={() => sendCommand('gcode:pause')}
                disabled={!view.pause.enabled}
                disabledReason={view.pause.reason}
              >
                <Pause size={14} aria-hidden />
                Pause
              </Button>
            ) : (
              <Button
                variant="primary"
                className="min-w-[92px]"
                onClick={() => sendCommand('gcode:resume')}
                disabled={!view.pause.enabled}
                disabledReason={view.pause.reason}
              >
                <Play size={14} aria-hidden />
                Resume
              </Button>
            )}
            <Button
              variant="danger"
              className="min-w-[92px]"
              onClick={() => setConfirmStop(true)}
              disabled={!view.stop.enabled}
              disabledReason={view.stop.reason}
            >
              <Square size={13} aria-hidden />
              Stop
            </Button>
          </div>
        </div>
      ) : (
        /* Empty state: upload + quick access to recent jobs */
        <div className="flex flex-col gap-3">
          <div className="flex items-center gap-3 rounded-md border border-dashed border-line px-4 py-3">
            <FileCode2 size={18} aria-hidden className="shrink-0 text-ink-3" />
            <div className="min-w-0 flex-1">
              <div className="text-[13px] text-ink">No program loaded</div>
              <div className="text-[11px] text-ink-3">
                {view.canLoad.enabled ? 'Upload a G-code file or load a recent job.' : `${view.canLoad.reason}.`}
              </div>
            </div>
            <Button variant="primary" onClick={() => setUploadOpen(true)}>
              <FolderOpen size={14} aria-hidden />
              Upload…
            </Button>
          </div>

          {library.jobs.length > 0 ? (
            <div>
              <div className="flex h-7 items-center justify-between">
                <h3 className="panel-label">Recent jobs</h3>
                {library.jobs.length > QUICK_RECENT ? (
                  <button
                    type="button"
                    onClick={() => setUploadOpen(true)}
                    className="text-[12px] text-ink-3 hover-fine:text-ink"
                  >
                    View all ({library.jobs.length})
                  </button>
                ) : null}
              </div>
              <RecentJobs
                jobs={library.jobs.slice(0, QUICK_RECENT)}
                loadedJobId={null}
                busyId={busyId}
                canLoad={view.canLoad.enabled}
                loadReason={view.canLoad.reason}
                onLoad={(job) => void quickLoad(job)}
              />
            </div>
          ) : null}
          {loadError ? (
            <p role="alert" className="flex items-center gap-2 text-[12px] text-ink">
              <AlertTriangle size={13} aria-hidden className="text-crit" />
              {loadError}
            </p>
          ) : null}
        </div>
      )}

      <UploadDialog
        open={uploadOpen}
        onOpenChange={setUploadOpen}
        canLoad={view.canLoad}
        loadedJobId={view.program?.jobId ?? null}
      />
      <ConfirmDialog
        open={confirmStop}
        onOpenChange={setConfirmStop}
        title="Stop this job?"
        description={
          <>
            The machine holds first, then the program is cancelled and rewound. Machine position is kept.
            <span className="mt-2 block text-ink-3">
              The spindle and coolant follow your controller’s reset behaviour. Hold and Reset are not an emergency
              stop.
            </span>
          </>
        }
        confirmLabel="Stop job"
        onConfirm={stopJob}
      />
    </FloatingWidget>
  );
}
