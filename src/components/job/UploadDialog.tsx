'use client';

/**
 * Upload menu: drop or browse a G-code file (stored in the job library, then loaded onto the
 * controller when possible) and the full Recent jobs list.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, Loader2, UploadCloud, X } from 'lucide-react';
import { useRef, useState } from 'react';
import {
  ACCEPTED_EXTENSIONS,
  MAX_JOB_BYTES,
  loadJob,
  removeJob,
  uploadJob,
  useJobLibrary,
  type JobRecord,
} from '@/lib/jobs/library';
import { Button } from '@/components/ui/Button';
import type { ControlState } from '@/lib/cnc/derive';
import { RecentJobs } from './RecentJobs';

const lowerFirst = (text: string) => text.charAt(0).toLowerCase() + text.slice(1);

type Notice = { tone: 'info' | 'error'; text: string } | null;

export function UploadDialog({
  open,
  onOpenChange,
  canLoad,
  loadedJobId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  canLoad: ControlState;
  loadedJobId: string | null;
}) {
  const library = useJobLibrary();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [uploading, setUploading] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  const reset = () => {
    setNotice(null);
    setDragging(false);
  };

  const handleFile = async (file: File | undefined) => {
    if (!file || uploading) return;
    setNotice(null);
    setUploading(file.name);
    try {
      const { record, gcode } = await uploadJob(file);
      if (canLoad.enabled) {
        await loadJob(record, gcode);
        onOpenChange(false);
      } else {
        setNotice({ tone: 'info', text: `Saved “${record.name}” to recent jobs. Not loaded: ${lowerFirst(canLoad.reason ?? 'the controller is not ready')}.` });
      }
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Upload failed' });
    } finally {
      setUploading(null);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const handleLoad = async (job: JobRecord) => {
    setNotice(null);
    setBusyId(job.id);
    try {
      await loadJob(job);
      onOpenChange(false);
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Could not load the job' });
    } finally {
      setBusyId(null);
    }
  };

  const handleRemove = async (job: JobRecord) => {
    try {
      await removeJob(job.id);
    } catch (err) {
      setNotice({ tone: 'error', text: err instanceof Error ? err.message : 'Could not remove the job' });
    }
  };

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) reset();
        onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="kq-overlay fixed inset-0 z-40 bg-black/60" />
        <Dialog.Content className="kq-dialog fixed top-1/2 left-1/2 z-50 flex max-h-[min(720px,90vh)] w-[600px] -translate-x-1/2 -translate-y-1/2 flex-col rounded-lg border border-line bg-surface shadow-2xl">
          <header className="flex items-start justify-between px-5 pt-5">
            <div>
              <Dialog.Title className="text-[15px] font-semibold text-ink">Load program</Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-ink-2">
                Upload a G-code file or pick one of your recent jobs.
              </Dialog.Description>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                aria-label="Close"
                className="pressable -mt-1 -mr-1 rounded p-1.5 text-ink-3 hover-fine:bg-surface-2 hover-fine:text-ink"
              >
                <X size={16} aria-hidden />
              </button>
            </Dialog.Close>
          </header>

          <div className="px-5 pt-4">
            <button
              type="button"
              onClick={() => inputRef.current?.click()}
              onDragEnter={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragOver={(e) => {
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
              }}
              onDragLeave={(e) => {
                if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
              }}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                void handleFile(e.dataTransfer.files[0]);
              }}
              disabled={uploading !== null}
              className={`flex h-[132px] w-full flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed transition-colors duration-150 ${
                dragging
                  ? 'border-accent bg-accent-track text-ink'
                  : 'border-line bg-surface-2/40 text-ink-2 hover-fine:border-ink-3 hover-fine:text-ink'
              }`}
            >
              {uploading ? (
                <>
                  <Loader2 size={22} aria-hidden className="animate-spin text-accent motion-reduce:animate-none" />
                  <span className="text-[13px]">Uploading “{uploading}”…</span>
                </>
              ) : (
                <>
                  <UploadCloud size={22} aria-hidden className={dragging ? 'text-accent' : 'text-ink-3'} />
                  <span className="text-[13px] text-ink">
                    {dragging ? 'Drop to upload' : 'Drop a G-code file here, or click to browse'}
                  </span>
                  <span className="text-[11px] text-ink-3">
                    {ACCEPTED_EXTENSIONS.join(' ')} · up to {MAX_JOB_BYTES / 1024 / 1024} MB
                  </span>
                </>
              )}
            </button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPTED_EXTENSIONS.join(',')}
              className="hidden"
              onChange={(e) => void handleFile(e.target.files?.[0])}
            />

            {notice ? (
              <p
                role={notice.tone === 'error' ? 'alert' : 'status'}
                className="mt-3 flex items-start gap-2 text-[12px] text-ink-2"
              >
                {notice.tone === 'error' ? (
                  <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-crit" />
                ) : null}
                <span>{notice.text}</span>
              </p>
            ) : !canLoad.enabled ? (
              <p className="mt-3 text-[12px] text-ink-3">
                Loading is unavailable: {lowerFirst(canLoad.reason ?? '')}. Uploads are still saved to recent jobs.
              </p>
            ) : null}
          </div>

          <div className="mt-4 flex min-h-0 flex-1 flex-col border-t border-line">
            <div className="flex h-9 shrink-0 items-center justify-between px-5">
              <h3 className="panel-label">Recent jobs</h3>
              {library.jobs.length > 0 ? (
                <span className="text-[11px] text-ink-3 tabular-nums">{library.jobs.length}</span>
              ) : null}
            </div>
            <div className="min-h-[80px] overflow-y-auto px-5 pb-4">
              {library.status === 'loading' ? (
                <p className="py-6 text-center text-[12px] text-ink-3">Loading recent jobs…</p>
              ) : library.status === 'error' ? (
                <p className="py-6 text-center text-[12px] text-ink-3">{library.error}</p>
              ) : library.jobs.length === 0 ? (
                <p className="py-6 text-center text-[12px] text-ink-3">No jobs yet. Uploaded files appear here.</p>
              ) : (
                <RecentJobs
                  jobs={library.jobs}
                  loadedJobId={loadedJobId}
                  busyId={busyId}
                  canLoad={canLoad.enabled}
                  loadReason={canLoad.reason}
                  onLoad={(job) => void handleLoad(job)}
                  onRemove={(job) => void handleRemove(job)}
                />
              )}
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
