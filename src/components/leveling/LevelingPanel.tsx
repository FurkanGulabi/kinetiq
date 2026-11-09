'use client';

/**
 * Bed leveling: top-bar button and panel frame. Like Settings, the panel opens below the top bar
 * (non-modal), so Hold and Reset stay reachable during probing. The workspace loads lazily.
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Layers, Loader2 } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { useMachine } from '@/lib/cnc/store';
import { Button } from '@/components/ui/Button';

const LevelingWorkspace = dynamic(() => import('./LevelingWorkspace'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-2">
      <Loader2 size={16} className="animate-spin text-ink-3" aria-hidden />
      Loading bed leveling…
    </div>
  ),
});

export function LevelingPanel() {
  const [open, setOpen] = useState(false);
  const running = useMachine((s) => s.leveling.phase === 'running');
  return (
    <Dialog.Root open={open} onOpenChange={setOpen} modal={false}>
      <Dialog.Trigger asChild>
        <Button variant="ghost" title="Bed leveling: probe a height map and level a job">
          {running ? <Loader2 size={14} className="animate-spin text-accent" aria-hidden /> : <Layers size={14} aria-hidden />}
          Leveling
        </Button>
      </Dialog.Trigger>
      <Dialog.Portal>
        <div className="kq-scrim fixed inset-x-0 top-12 bottom-0 z-30 bg-black/45" data-state={open ? 'open' : 'closed'} aria-hidden />
        <Dialog.Content
          className="fixed inset-x-0 top-12 bottom-0 z-30 flex justify-center p-4 outline-none"
          onInteractOutside={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <div className="kq-sheet glass-sheet flex h-full w-full max-w-[1400px] flex-col overflow-hidden" data-state={open ? 'open' : 'closed'}>
            <LevelingWorkspace />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
