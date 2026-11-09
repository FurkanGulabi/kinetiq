'use client';

/**
 * Machine settings (FluidNC config) — docs/SETTINGS_EDITOR.md §4.
 *
 * The top-bar button and the panel frame. The panel opens *below* the top bar (Radix Dialog,
 * non-modal), so Hold and Reset stay reachable. The editor itself (form, YAML, review, save) is
 * loaded only when the panel opens: it carries FluidNC's field reference (~125 KB).
 */
import * as Dialog from '@radix-ui/react-dialog';
import { Loader2, Settings } from 'lucide-react';
import dynamic from 'next/dynamic';
import { useState } from 'react';
import { Button } from '@/components/ui/Button';

const SettingsEditor = dynamic(() => import('./SettingsEditor'), {
  ssr: false,
  loading: () => (
    <div className="flex h-full items-center justify-center gap-2 text-[13px] text-ink-2">
      <Loader2 size={16} className="animate-spin text-ink-3" aria-hidden />
      Loading settings editor…
    </div>
  ),
});

export function SettingsPanel() {
  const [open, setOpen] = useState(false);
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
        <div className="kq-scrim fixed inset-x-0 top-12 bottom-0 z-30 bg-black/45" data-state={open ? 'open' : 'closed'} aria-hidden />
        <Dialog.Content
          className="fixed inset-x-0 top-12 bottom-0 z-30 flex justify-center p-4 outline-none"
          onInteractOutside={(e) => e.preventDefault()}
          aria-describedby={undefined}
        >
          <div className="kq-sheet glass-sheet flex h-full w-full max-w-[1280px] flex-col overflow-hidden" data-state={open ? 'open' : 'closed'}>
            <SettingsEditor />
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
