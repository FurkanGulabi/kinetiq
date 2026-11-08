'use client';

import { AlertTriangle, CheckCircle2, FileCode2, Square, Trash2 } from 'lucide-react';
import { formatBytes, formatRelative, middleTruncate, type JobRecord, type JobRunStatus } from '@/lib/jobs/library';
import { Button } from '@/components/ui/Button';

const RUN: Record<JobRunStatus, { label: string; icon: typeof CheckCircle2; className: string }> = {
  completed: { label: 'Completed', icon: CheckCircle2, className: 'text-ok' },
  cancelled: { label: 'Cancelled', icon: Square, className: 'text-ink-2' },
  error: { label: 'Error', icon: AlertTriangle, className: 'text-crit' },
};

function LastRun({ job, now }: { job: JobRecord; now: number }) {
  if (!job.lastRun) {
    return <span className="text-ink-3">Never run</span>;
  }
  const run = RUN[job.lastRun.status];
  const Icon = run.icon;
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap">
      <Icon size={11} strokeWidth={2.5} aria-hidden className={run.className} />
      <span className="text-ink-2">{run.label}</span>
      <span className="text-ink-3">· {formatRelative(job.lastRun.endedAt, now)}</span>
    </span>
  );
}

/** Recent jobs, most recently used first. Used in the Job panel (compact) and the upload dialog (full). */
export function RecentJobs({
  jobs,
  loadedJobId,
  busyId,
  canLoad,
  loadReason,
  onLoad,
  onRemove,
  now = Date.now(),
}: {
  jobs: JobRecord[];
  loadedJobId: string | null;
  busyId: string | null;
  canLoad: boolean;
  loadReason?: string;
  onLoad: (job: JobRecord) => void;
  onRemove?: (job: JobRecord) => void;
  now?: number;
}) {
  return (
    <ul className="flex flex-col">
      {jobs.map((job) => {
        const loaded = job.id === loadedJobId;
        return (
          <li
            key={job.id}
            className="group flex items-center gap-3 border-t border-line py-2 first:border-t-0"
          >
            <FileCode2 size={16} aria-hidden className={loaded ? 'shrink-0 text-accent' : 'shrink-0 text-ink-3'} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] text-ink" title={job.name}>
                {middleTruncate(job.name, 48)}
              </div>
              <div className="flex flex-wrap items-center gap-x-2 text-[11px] text-ink-3">
                <span className="whitespace-nowrap tabular-nums">
                  {job.lines.toLocaleString()} lines · {formatBytes(job.size)}
                </span>
                <LastRun job={job} now={now} />
              </div>
            </div>
            {onRemove ? (
              <button
                type="button"
                onClick={() => onRemove(job)}
                aria-label={`Remove ${job.name} from recent jobs`}
                title="Remove from recent jobs"
                className="pressable rounded p-1.5 text-ink-3 hover-fine:bg-surface-2 hover-fine:text-crit"
              >
                <Trash2 size={14} aria-hidden />
              </button>
            ) : null}
            {loaded ? (
              <span className="w-[64px] text-center text-[12px] font-medium text-accent">Loaded</span>
            ) : (
              <Button
                variant="secondary"
                className="h-7 w-[64px] px-2 text-[12px]"
                onClick={() => onLoad(job)}
                disabled={!canLoad || busyId !== null}
                disabledReason={busyId ? 'Loading…' : loadReason}
              >
                {busyId === job.id ? 'Loading…' : 'Load'}
              </Button>
            )}
          </li>
        );
      })}
    </ul>
  );
}
