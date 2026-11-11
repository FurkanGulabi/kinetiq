'use client';

import * as Dialog from '@radix-ui/react-dialog';
import { Button } from './Button';

/** Confirmation for irreversible actions only (ARCHITECTURE §9.6: Stop job, Delete macro). */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Keep running',
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: React.ReactNode;
  confirmLabel: string;
  /** The safe choice, focused when the dialog opens. */
  cancelLabel?: string;
  onConfirm: () => void;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="kq-overlay fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content className="kq-dialog fixed top-1/2 left-1/2 z-50 w-[400px] -translate-x-1/2 -translate-y-1/2 glass-sheet p-5">
          <Dialog.Title className="text-[15px] font-semibold text-ink">{title}</Dialog.Title>
          <Dialog.Description asChild>
            <div className="mt-2 text-[13px] text-ink-2">{description}</div>
          </Dialog.Description>
          <div className="mt-5 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button variant="secondary" autoFocus>
                {cancelLabel}
              </Button>
            </Dialog.Close>
            <Button
              variant="danger"
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
