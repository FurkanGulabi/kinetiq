'use client';

/**
 * Add / edit one macro: a name and its G-code, checked with the same rules the server applies
 * (lib/macros/macro.ts) before anything is sent. Radix Dialog, so keyboard jog leaves every key
 * alone while it is open (lib/ui/keyboardJog.ts).
 */
import * as Dialog from '@radix-ui/react-dialog';
import { AlertTriangle, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { createMacro, updateMacro, type Macro } from '@/lib/macros/library';
import { MACRO_CONTENT_MAX, MACRO_NAME_MAX, macroLines, validateMacroInput } from '@/lib/macros/macro';

export function MacroDialog({
  open,
  onOpenChange,
  macro,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The macro to edit; null to add a new one. */
  macro: Macro | null;
}) {
  const [name, setName] = useState('');
  const [content, setContent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(macro?.name ?? '');
    setContent(macro?.content ?? '');
    setError(null);
    setSaving(false);
    setTouched(false);
  }, [open, macro]);

  const check = validateMacroInput(name, content);
  const problem = check.ok ? null : check.error;
  const lineCount = macroLines(content).length;

  const save = async () => {
    setTouched(true);
    if (!check.ok || saving) return;
    setSaving(true);
    setError(null);
    try {
      if (macro) await updateMacro(macro.id, name, content);
      else await createMacro(name, content);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not save the macro');
    } finally {
      setSaving(false);
    }
  };

  const shown = error ?? (touched || (name !== '' && content !== '') ? problem : null);

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="kq-overlay fixed inset-0 z-40 bg-black/50" />
        <Dialog.Content
          className="kq-dialog fixed top-1/2 left-1/2 z-50 flex w-[560px] max-w-[calc(100vw-32px)] -translate-x-1/2 -translate-y-1/2 flex-col glass-sheet"
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            (document.getElementById('kq-macro-name') as HTMLInputElement | null)?.focus();
          }}
        >
          <header className="flex items-start justify-between px-5 pt-5">
            <div>
              <Dialog.Title className="text-[15px] font-semibold text-ink">{macro ? 'Edit macro' : 'Add macro'}</Dialog.Title>
              <Dialog.Description className="mt-1 text-[13px] text-ink-2">
                G-code lines sent one at a time, in order, when you press Run.
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

          <form
            className="flex flex-col gap-3 px-5 pt-4 pb-5"
            onSubmit={(e) => {
              e.preventDefault();
              void save();
            }}
          >
            <label className="block">
              <span className="text-[12px] text-ink-2">Name</span>
              <input
                id="kq-macro-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={MACRO_NAME_MAX + 20}
                placeholder="e.g. Park at back left"
                autoComplete="off"
                spellCheck={false}
                className="mt-0.5 h-8 w-full rounded-md border border-line bg-surface-2 px-2.5 text-[13px] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="flex items-baseline justify-between text-[12px] text-ink-2">
                <span>G-code</span>
                <span className="text-[11px] text-ink-3 tabular-nums">
                  {lineCount} line{lineCount === 1 ? '' : 's'} · {content.length.toLocaleString('en-US')} / {MACRO_CONTENT_MAX.toLocaleString('en-US')}
                </span>
              </span>
              <textarea
                value={content}
                onChange={(e) => setContent(e.target.value)}
                rows={12}
                placeholder={'G21 G90\n$J=G53 X-10 Y190 F3000'}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                wrap="off"
                className="mt-0.5 block w-full resize-y rounded-md border border-line bg-black/25 px-2.5 py-2 font-mono text-[12.5px] leading-[1.5] text-ink placeholder:text-ink-3 focus:border-accent focus:outline-none"
              />
            </label>
            <p className="text-[11px] leading-[16px] text-ink-3">
              One command per line. Jogs (<span className="font-mono">$J=</span>) are kept inside the travel limits like any other jog.{' '}
              <span className="font-mono">[expressions]</span> and <span className="font-mono">%name=value</span> work as in CNCjs.
              Not allowed: <span className="font-mono">%wait</span> (use <span className="font-mono">G4 P…</span>), M0, M1 and M6.
            </p>

            {shown ? (
              <p role="alert" className="flex items-start gap-2 text-[12px] text-ink-2">
                <AlertTriangle size={13} aria-hidden className="mt-0.5 shrink-0 text-crit" />
                <span>{shown}</span>
              </p>
            ) : null}

            <div className="mt-1 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button variant="secondary">Cancel</Button>
              </Dialog.Close>
              <Button type="submit" variant="primary" disabled={saving || (touched && !check.ok)} disabledReason={saving ? 'Saving…' : problem ?? undefined}>
                {saving ? 'Saving…' : 'Save'}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
