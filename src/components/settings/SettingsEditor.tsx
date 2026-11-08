'use client';

/**
 * Machine settings editor — docs/SETTINGS_EDITOR.md §4.
 *
 * The YAML text is the single source of truth (configText.ts): the form edits one line at a time,
 * the YAML view edits the text directly, and Review shows exactly which lines change before
 * anything is written. Saving backs up, uploads, verifies and swaps the file on the controller;
 * FluidNC only uses the new file after an explicit restart.
 */
import * as Dialog from '@radix-ui/react-dialog';
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  FileText,
  History,
  Info,
  Loader2,
  Plus,
  Power,
  RefreshCw,
  RotateCcw,
  Save,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { settingsView } from '@/lib/cnc/derive';
import { useMachine } from '@/lib/cnc/store';
import {
  addValue,
  changeCount,
  checkValue,
  diffLines,
  fieldSpec,
  findNode,
  labelFor,
  parseConfig,
  parseSize,
  plainValue,
  schemaSource,
  sectionFields,
  sectionText,
  setValue,
  unitFor,
  validateConfig,
  type ConfigNode,
  type FieldSpec,
  type Issue,
} from '@/lib/fluidnc/configText';
import {
  clearOperationError,
  fetchBackup,
  listBackups,
  readMachineConfig,
  restartController,
  saveMachineConfig,
  useMachineConfig,
  type BackupInfo,
  type MachineConfigSnapshot,
} from '@/lib/fluidnc/machineConfig';
import { Button } from '@/components/ui/Button';
import { SegmentedControl } from '@/components/ui/SegmentedControl';

type View = 'form' | 'yaml' | 'running' | 'review';

/** Unsaved edits survive closing and reopening the panel (same page session, same base file). */
let persistedDraft: { baseSha256: string; text: string } | null = null;

const isPinKey = (key: string, spec: FieldSpec | null) => spec?.type === 'pin' || /(^|_)pin$/.test(key);
const isConcreteDefault = (spec: FieldSpec) =>
  spec.default !== undefined && spec.default !== '' && !/^\(.*\)$/.test(spec.default) && !spec.type.includes('::');

/* ------------------------------------------------------------------------------------------------
 * Small pieces
 * ---------------------------------------------------------------------------------------------- */

function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const paragraphs = text.split(/\n\s*\n/);
  const first = paragraphs[0];
  const long = text.length > 180 || paragraphs.length > 1;
  return (
    <div className="mt-1 text-[12px] leading-[17px] text-ink-2">
      <p className={open ? undefined : 'line-clamp-2'}>{open ? paragraphs.map((p, i) => <span key={i} className="mb-1 block">{p}</span>) : first}</p>
      {long ? (
        <button type="button" onClick={() => setOpen((v) => !v)} className="pressable mt-0.5 text-[11px] text-accent hover-fine:underline">
          {open ? 'Less' : 'More'}
        </button>
      ) : null}
    </div>
  );
}

function FieldInput({
  spec,
  value,
  onChange,
  disabled,
  invalid,
  id,
}: {
  spec: FieldSpec | null;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
  invalid: boolean;
  id: string;
}) {
  const base = `h-8 rounded-md border bg-bg px-2 text-[13px] text-ink outline-none focus-visible:border-accent disabled:text-ink-3 ${
    invalid ? 'border-crit' : 'border-line'
  }`;
  if (spec?.type === 'boolean' && /^(true|false)$/i.test(value)) {
    return (
      <SegmentedControl
        ariaLabel="Value"
        segments={[
          { value: 'true', label: 'On' },
          { value: 'false', label: 'Off' },
        ]}
        value={value.toLowerCase() as 'true' | 'false'}
        onChange={onChange}
        disabled={disabled}
      />
    );
  }
  if (spec?.type === 'enum' && spec.values && spec.values.some((v) => v.toLowerCase() === value.toLowerCase())) {
    return (
      <select id={id} className={`${base} w-56`} value={spec.values.find((v) => v.toLowerCase() === value.toLowerCase())} onChange={(e) => onChange(e.target.value)} disabled={disabled}>
        {spec.values.map((v) => (
          <option key={v} value={v}>
            {v}
          </option>
        ))}
      </select>
    );
  }
  const numeric = spec?.type === 'integer' || spec?.type === 'float';
  return (
    <input
      id={id}
      className={`${base} ${numeric ? 'w-32 text-right font-mono tabular-nums' : 'w-64 font-mono'}`}
      value={value}
      spellCheck={false}
      inputMode={numeric ? 'decimal' : undefined}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      aria-invalid={invalid || undefined}
    />
  );
}

function FieldRow({
  node,
  running,
  issues,
  onChange,
  disabled,
}: {
  node: ConfigNode;
  running: string | undefined;
  issues: Issue[];
  onChange: (path: string[], value: string) => void;
  disabled: boolean;
}) {
  const spec = fieldSpec(node.path);
  const value = plainValue(node.value);
  const error = checkValue(spec, node.value);
  const unit = unitFor(node.key);
  const id = `field-${node.path.join('-')}`;
  const warnings = issues.filter((i) => i.level === 'warning' && i.line === node.line);
  return (
    <div className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 border-b border-line/60 py-3 last:border-b-0">
      <div className="min-w-0">
        <label htmlFor={id} className="flex items-baseline gap-2">
          <span className="text-[13px] font-medium text-ink">{labelFor(node.key)}</span>
          <span className="truncate font-mono text-[11px] text-ink-3">{node.key}</span>
        </label>
        {spec ? (
          <Description text={spec.description} />
        ) : (
          <p className="mt-1 text-[12px] text-ink-3">No description in FluidNC’s reference for this setting.</p>
        )}
        <div className="mt-1 flex flex-wrap gap-x-3 text-[11px] text-ink-3">
          {spec?.default !== undefined && isConcreteDefault(spec) ? <span>Default {spec.default}</span> : null}
          {spec?.min !== undefined || spec?.max !== undefined ? (
            <span>
              Range {spec?.min ?? '…'} – {spec?.max ?? '…'}
            </span>
          ) : null}
        </div>
        {error ? <p className="mt-1 text-[12px] text-crit">{error}</p> : null}
        {warnings.map((w, i) => (
          <p key={i} className="mt-1 flex items-start gap-1 text-[12px] text-warn">
            <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
            {w.message}
          </p>
        ))}
        {running !== undefined ? (
          <p className="mt-1 text-[12px] text-warn" title="FluidNC is running a different value than the file says">
            Running now: <span className="font-mono">{running || '(empty)'}</span>
          </p>
        ) : null}
      </div>
      <div className="flex items-start gap-2 pt-0.5">
        <FieldInput spec={spec} value={value} onChange={(v) => onChange(node.path, v)} disabled={disabled} invalid={!!error} id={id} />
        {unit ? <span className="w-14 pt-1.5 text-[12px] text-ink-3">{unit}</span> : <span className="w-14" />}
      </div>
    </div>
  );
}

function MissingFields({
  section,
  onAdd,
  disabled,
}: {
  section: ConfigNode;
  onAdd: (sectionPath: string[], name: string, value: string) => void;
  disabled: boolean;
}) {
  const [open, setOpen] = useState(false);
  const missing = sectionFields(section.path).filter(
    (f) => !section.children.some((c) => c.key.toLowerCase() === f.name.toLowerCase()) && isConcreteDefault(f.spec),
  );
  if (missing.length === 0) return null;
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="pressable flex items-center gap-1 text-[12px] text-ink-3 hover-fine:text-ink"
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        {missing.length} more {missing.length === 1 ? 'setting uses its default' : 'settings use their defaults'} (not in the file)
      </button>
      {open ? (
        <ul className="mt-2 space-y-2">
          {missing.map((f) => (
            <li key={f.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-6 rounded-md border border-line/60 px-3 py-2">
              <div className="min-w-0">
                <div className="flex items-baseline gap-2">
                  <span className="text-[13px] text-ink-2">{labelFor(f.name)}</span>
                  <span className="font-mono text-[11px] text-ink-3">{f.name}</span>
                  <span className="text-[11px] text-ink-3">default {f.spec.default}</span>
                </div>
                <Description text={f.spec.description} />
              </div>
              <div>
                <Button variant="ghost" onClick={() => onAdd(section.path, f.name, f.spec.default!)} disabled={disabled} title="Add this setting to the file with its default value">
                  <Plus size={14} aria-hidden />
                  Add
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function SectionBlock({
  node,
  depth,
  running,
  issues,
  onChange,
  onAdd,
  disabled,
}: {
  node: ConfigNode;
  depth: number;
  running: Map<string, string>;
  issues: Issue[];
  onChange: (path: string[], value: string) => void;
  onAdd: (sectionPath: string[], name: string, value: string) => void;
  disabled: boolean;
}) {
  const [showPins, setShowPins] = useState(false);
  const leaves = node.children.filter((c) => !c.isSection);
  const sections = node.children.filter((c) => c.isSection);
  const regular = leaves.filter((c) => !isPinKey(c.key, fieldSpec(c.path)));
  const pins = leaves.filter((c) => isPinKey(c.key, fieldSpec(c.path)));
  const text = sectionText(node.path);
  const row = (c: ConfigNode) => (
    <FieldRow key={c.path.join('/')} node={c} running={running.get(c.path.join('/').toLowerCase())} issues={issues} onChange={onChange} disabled={disabled} />
  );
  return (
    <section className={depth > 0 ? 'mt-5 rounded-md border border-line px-4 pt-3 pb-2' : undefined}>
      {depth > 0 ? (
        <header className="mb-1">
          <h4 className="text-[13px] font-semibold text-ink">
            {labelFor(node.key)} <span className="ml-1 font-mono text-[11px] font-normal text-ink-3">{node.path.join('/')}</span>
          </h4>
          {text ? <p className="mt-0.5 text-[12px] text-ink-2">{text}</p> : null}
        </header>
      ) : null}
      {regular.map(row)}
      {pins.length > 0 ? (
        <div className="mt-2">
          <button
            type="button"
            onClick={() => setShowPins((v) => !v)}
            aria-expanded={showPins}
            className="pressable flex items-center gap-1 text-[12px] text-ink-3 hover-fine:text-ink"
          >
            {showPins ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
            Pins ({pins.length}) — advanced
          </button>
          {showPins ? (
            <div className="mt-1">
              <p className="flex items-start gap-1 rounded-md border border-warn/40 bg-warn/5 px-3 py-2 text-[12px] text-ink-2">
                <AlertTriangle size={12} className="mt-0.5 shrink-0 text-warn" aria-hidden />
                Pins must match how the board is wired. A wrong pin can drive an output or a motor unexpectedly after the restart.
              </p>
              {pins.map(row)}
            </div>
          ) : null}
        </div>
      ) : null}
      {node.value !== '{}' ? <MissingFields section={node} onAdd={onAdd} disabled={disabled} /> : null}
      {sections.map((s) => (
        <SectionBlock key={s.path.join('/')} node={s} depth={depth + 1} running={running} issues={issues} onChange={onChange} onAdd={onAdd} disabled={disabled} />
      ))}
    </section>
  );
}

function CodeView({ text }: { text: string }) {
  const lines = text.replace(/\n$/, '').split('\n');
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-bg font-mono text-[12px] leading-[20px]">
      <table className="w-full border-collapse">
        <tbody>
          {lines.map((line, i) => (
            <tr key={i}>
              <td className="w-12 pr-3 text-right align-top text-ink-3 select-none">{i + 1}</td>
              <td className="pr-4 whitespace-pre text-ink">{line || ' '}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function YamlEditor({ text, onChange, disabled, issues }: { text: string; onChange: (t: string) => void; disabled: boolean; issues: Issue[] }) {
  const gutter = useRef<HTMLDivElement>(null);
  const lines = text.split('\n').length;
  const badLines = new Set(issues.filter((i) => i.level === 'error' && i.line !== undefined).map((i) => i.line!));
  return (
    <div className="flex min-h-0 flex-1 overflow-hidden rounded-md border border-line bg-bg font-mono text-[12px] leading-[20px]">
      <div ref={gutter} className="w-12 shrink-0 overflow-hidden py-2 pr-3 text-right text-ink-3 select-none" aria-hidden>
        {Array.from({ length: lines }, (_, i) => (
          <div key={i} className={badLines.has(i) ? 'text-crit' : undefined}>
            {i + 1}
          </div>
        ))}
      </div>
      <textarea
        className="min-h-0 flex-1 resize-none bg-transparent py-2 pr-4 text-ink outline-none disabled:text-ink-2"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        onScroll={(e) => {
          if (gutter.current) gutter.current.scrollTop = e.currentTarget.scrollTop;
        }}
        onKeyDown={(e) => {
          // FluidNC needs spaces: Tab inserts two.
          if (e.key === 'Tab' && !e.shiftKey) {
            e.preventDefault();
            const el = e.currentTarget;
            const { selectionStart, selectionEnd } = el;
            const next = `${text.slice(0, selectionStart)}  ${text.slice(selectionEnd)}`;
            onChange(next);
            requestAnimationFrame(() => el.setSelectionRange(selectionStart + 2, selectionStart + 2));
          }
        }}
        spellCheck={false}
        wrap="off"
        disabled={disabled}
        aria-label="Config file YAML"
      />
    </div>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
  const diff = useMemo(() => diffLines(before, after), [before, after]);
  // Show changes with two lines of context.
  const keep = new Set<number>();
  diff.forEach((d, i) => {
    if (d.kind !== 'same') for (let k = i - 2; k <= i + 2; k++) keep.add(k);
  });
  const rows: (typeof diff[number] | null)[] = [];
  diff.forEach((d, i) => {
    if (keep.has(i)) rows.push(d);
    else if (rows[rows.length - 1] !== null) rows.push(null);
  });
  return (
    <div className="min-h-0 flex-1 overflow-auto rounded-md border border-line bg-bg font-mono text-[12px] leading-[20px]">
      <table className="w-full border-collapse">
        <tbody>
          {rows.map((d, i) =>
            d === null ? (
              <tr key={i}>
                <td colSpan={3} className="px-3 text-ink-3 select-none">
                  ⋯
                </td>
              </tr>
            ) : (
              <tr key={i} className={d.kind === 'added' ? 'bg-ok/10' : d.kind === 'removed' ? 'bg-crit/10' : undefined}>
                <td className="w-10 pr-2 text-right text-ink-3 select-none">{d.oldLine ?? ''}</td>
                <td className="w-10 pr-2 text-right text-ink-3 select-none">{d.newLine ?? ''}</td>
                <td className={`pr-4 whitespace-pre ${d.kind === 'added' ? 'text-ok' : d.kind === 'removed' ? 'text-crit' : 'text-ink-2'}`}>
                  {d.kind === 'added' ? '+ ' : d.kind === 'removed' ? '− ' : '  '}
                  {d.text}
                </td>
              </tr>
            ),
          )}
        </tbody>
      </table>
    </div>
  );
}

function IssueList({ issues }: { issues: Issue[] }) {
  if (issues.length === 0) return <p className="text-[13px] text-ink-2">No problems found.</p>;
  return (
    <ul className="space-y-1.5">
      {issues.map((issue, i) => (
        <li key={i} className={`flex items-start gap-1.5 text-[12px] ${issue.level === 'error' ? 'text-crit' : 'text-warn'}`}>
          <AlertTriangle size={12} className="mt-0.5 shrink-0" aria-hidden />
          <span>
            {issue.line !== undefined ? <span className="font-mono text-ink-3">L{issue.line + 1} </span> : null}
            {issue.message}
          </span>
        </li>
      ))}
    </ul>
  );
}

function BootProblems({ log, title }: { log: MachineConfigSnapshot['bootLog']; title: string }) {
  const [open, setOpen] = useState(false);
  const problems = log.filter((l) => l.level === 'warn' || l.level === 'error');
  return (
    <div className="rounded-md border border-line">
      {problems.length > 0 ? (
        <ul className="divide-y divide-line">
          {problems.map((p, i) => (
            <li key={i} className="flex items-start gap-2 px-3 py-2 text-[13px] text-ink">
              <AlertTriangle size={14} className={`mt-0.5 shrink-0 ${p.level === 'error' ? 'text-crit' : 'text-warn'}`} aria-hidden />
              <span>
                <span className={p.level === 'error' ? 'text-crit' : 'text-warn'}>{p.level === 'error' ? `${title} error` : `${title} warning`}:</span> {p.text.trim()}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <p className="flex items-center gap-2 px-3 py-2 text-[13px] text-ink-2">
          <CheckCircle2 size={14} className="text-ok" aria-hidden />
          No warnings or errors in the {title.toLowerCase()} log.
        </p>
      )}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="pressable flex w-full items-center gap-1 border-t border-line px-3 py-1.5 text-[12px] text-ink-3 hover-fine:text-ink"
      >
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        {title} log ({log.length} lines)
      </button>
      {open ? (
        <pre className="max-h-56 overflow-auto border-t border-line bg-bg px-3 py-2 font-mono text-[12px] leading-[18px] text-ink-2">
          {log.map((l) => `${l.level === 'other' ? '' : `[${l.level.toUpperCase()}] `}${l.text}`).join('\n')}
        </pre>
      ) : null}
    </div>
  );
}

function Backups({ onLoad, disabled }: { onLoad: (backup: BackupInfo) => void; disabled: boolean }) {
  const [open, setOpen] = useState(false);
  const [backups, setBackups] = useState<BackupInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    listBackups()
      .then(setBackups)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : 'Could not list backups'));
  }, [open]);
  return (
    <section>
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="pressable panel-label flex items-center gap-1 hover-fine:text-ink">
        {open ? <ChevronDown size={12} aria-hidden /> : <ChevronRight size={12} aria-hidden />}
        Backups
      </button>
      {open ? (
        <div className="mt-2">
          <p className="text-[12px] text-ink-3">A copy of the file is kept on this computer before every save. Loading one puts it in the editor; review and save it like any change.</p>
          {error ? <p className="mt-2 text-[12px] text-crit">{error}</p> : null}
          {backups && backups.length === 0 ? <p className="mt-2 text-[12px] text-ink-2">No backups yet.</p> : null}
          <ul className="mt-2 space-y-1">
            {(backups ?? []).slice(0, 10).map((b) => (
              <li key={b.id} className="flex items-center gap-2 text-[12px] text-ink-2">
                <History size={12} className="shrink-0 text-ink-3" aria-hidden />
                <span className="flex-1 truncate">{new Date(b.savedAt).toLocaleString()}</span>
                <button type="button" className="pressable text-accent hover-fine:underline disabled:text-ink-3" onClick={() => onLoad(b)} disabled={disabled}>
                  Load
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

/* ------------------------------------------------------------------------------------------------
 * Editor
 * ---------------------------------------------------------------------------------------------- */

export default function SettingsEditor() {
  const machine = useMachine((s) => s);
  const availability = settingsView(machine);
  const { status, snapshot, error, operation, lastSave, lastRestart, operationError } = useMachineConfig();
  const busy = operation !== null;

  const [view, setView] = useState<View>('form');
  const [draft, setDraft] = useState<string | null>(null);
  const [section, setSection] = useState<string[]>(['axes', 'x']);
  const [lastBackupId, setLastBackupId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // First open with a usable controller: read once. Later opens keep the last snapshot.
  useEffect(() => {
    if (availability.enabled && status === 'idle') void readMachineConfig();
  }, [availability.enabled, status]);

  // A new snapshot (read, save, restart) resets the draft, unless unsaved edits on the same base exist.
  useEffect(() => {
    if (!snapshot) return;
    if (persistedDraft && persistedDraft.baseSha256 === snapshot.savedSha256) setDraft(persistedDraft.text);
    else {
      persistedDraft = null;
      setDraft(snapshot.saved);
    }
  }, [snapshot]);

  const text = draft ?? snapshot?.saved ?? '';
  const updateDraft = (next: string) => {
    setDraft(next);
    if (snapshot) persistedDraft = next === snapshot.saved ? null : { baseSha256: snapshot.savedSha256, text: next };
  };

  const roots = useMemo(() => parseConfig(text), [text]);
  const freeBytes = useMemo(() => {
    if (!snapshot) return null;
    const free = parseSize(snapshot.fs.free);
    const current = snapshot.fs.files.find((f) => f.name === snapshot.filename)?.size ?? 0;
    return free === null ? null : free + current;
  }, [snapshot]);
  const issues = useMemo(() => (snapshot ? validateConfig(text, freeBytes) : []), [text, snapshot, freeBytes]);
  const errors = issues.filter((i) => i.level === 'error');
  const changes = snapshot ? changeCount(snapshot.saved, text) : 0;
  const dirty = !!snapshot && text !== snapshot.saved;
  const running = useMemo(() => new Map((snapshot?.differences ?? []).map((d) => [d.path.toLowerCase(), d.running])), [snapshot]);

  // Sections for the left navigation: top-level keys, with each axis listed under Axes.
  const nav = useMemo(() => {
    const items: { path: string[]; label: string; depth: number }[] = [];
    const top = roots.filter((r) => r.isSection);
    const general = roots.some((r) => !r.isSection);
    if (general) items.push({ path: [], label: 'General', depth: 0 });
    for (const r of top) {
      if (r.key.toLowerCase() === 'axes') {
        items.push({ path: [r.key], label: 'Axes (shared)', depth: 0 });
        for (const a of r.children.filter((c) => c.isSection)) items.push({ path: [r.key, a.key], label: `Axis ${a.key.toUpperCase()}`, depth: 1 });
      } else {
        items.push({ path: [r.key], label: labelFor(r.key), depth: 0 });
      }
    }
    return items;
  }, [roots]);

  const selected = section.length === 0 ? null : findNode(roots, section);
  const validSelection = section.length === 0 || !!selected;
  useEffect(() => {
    if (!validSelection && nav.length > 0) setSection(nav[0].path);
  }, [validSelection, nav]);

  const issueSections = useMemo(() => {
    const keys = new Set<string>();
    for (const i of issues) if (i.path) keys.add(i.path.slice(0, i.path[0]?.toLowerCase() === 'axes' && i.path.length > 2 ? 2 : 1).join('/').toLowerCase());
    return keys;
  }, [issues]);

  const onChange = (path: string[], value: string) => updateDraft(setValue(text, path, value));
  const onAdd = (sectionPath: string[], name: string, value: string) => updateDraft(addValue(text, sectionPath, name, value));

  const onSave = async () => {
    if (!snapshot) return;
    const result = await saveMachineConfig(text, snapshot.savedSha256);
    if (result) {
      persistedDraft = null;
      setLastBackupId(result.backup.id);
      setView('form');
    }
  };

  const onLoadBackup = async (backup: BackupInfo) => {
    try {
      updateDraft(await fetchBackup(backup.id));
      setNotice(`Loaded the backup from ${new Date(backup.savedAt).toLocaleString()} into the editor. Review the changes, then save to restore it.`);
      setView('review');
    } catch (e) {
      setNotice(e instanceof Error ? e.message : 'Could not load the backup');
    }
  };

  const restartBlocked = !availability.enabled ? availability.reason : busy ? 'Another settings operation is in progress' : undefined;
  const firmware = machine.controller.firmware;
  const readAt = snapshot ? new Date(snapshot.readAt).toLocaleTimeString() : null;
  const editingDisabled = busy;

  /* ---------------------------------- header ---------------------------------- */
  const header = (
    <header className="flex items-center gap-3 border-b border-line px-4 py-3">
      <div className="min-w-0 flex-1">
        <Dialog.Title className="text-[15px] font-semibold text-ink">Machine settings</Dialog.Title>
        <p className="truncate text-[12px] text-ink-3">
          {[snapshot?.filename ?? 'FluidNC config', firmware, readAt ? `read ${readAt}` : null].filter(Boolean).join(' · ')}
        </p>
      </div>
      {view === 'review' ? (
        <Button variant="ghost" onClick={() => setView('form')} disabled={busy}>
          <ArrowLeft size={14} aria-hidden />
          Back to editing
        </Button>
      ) : (
        <SegmentedControl
          ariaLabel="Settings view"
          segments={[
            { value: 'form', label: 'Form' },
            { value: 'yaml', label: 'YAML' },
            { value: 'running', label: 'Running' },
          ]}
          value={view}
          onChange={setView}
          disabled={!snapshot}
        />
      )}
      <Button
        variant="secondary"
        onClick={() => void readMachineConfig()}
        disabled={!availability.enabled || busy || dirty}
        disabledReason={dirty ? 'Save or discard your changes first' : busy ? 'Another settings operation is in progress' : availability.reason}
        title="Read the config from the controller again"
      >
        {operation === 'reading' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <RefreshCw size={14} aria-hidden />}
        Reload
      </Button>
      <Dialog.Close asChild>
        <button type="button" className="pressable rounded p-1.5 text-ink-3 hover-fine:text-ink" aria-label="Close settings">
          <X size={16} aria-hidden />
        </button>
      </Dialog.Close>
    </header>
  );

  /* ---------------------------------- banners ---------------------------------- */
  const banners = (
    <>
      {error ? (
        <div role="alert" className="flex items-center gap-2 border-b border-crit/40 bg-crit/10 px-4 py-2 text-[13px] text-ink">
          <AlertTriangle size={14} className="text-crit" aria-hidden />
          <span>Could not read the config: {error}</span>
        </div>
      ) : null}
      {operationError ? (
        <div role="alert" className="flex items-center gap-2 border-b border-crit/40 bg-crit/10 px-4 py-2 text-[13px] text-ink">
          <AlertTriangle size={14} className="text-crit" aria-hidden />
          <span className="flex-1">{operationError}</span>
          <button type="button" onClick={clearOperationError} className="pressable rounded p-1 text-ink-3 hover-fine:text-ink" aria-label="Dismiss">
            <X size={14} aria-hidden />
          </button>
        </div>
      ) : null}
      {notice ? (
        <div role="status" className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[13px] text-ink">
          <Info size={14} className="text-accent" aria-hidden />
          <span className="flex-1">{notice}</span>
          <button type="button" onClick={() => setNotice(null)} className="pressable rounded p-1 text-ink-3 hover-fine:text-ink" aria-label="Dismiss">
            <X size={14} aria-hidden />
          </button>
        </div>
      ) : null}
      {lastSave ? (
        <div role="status" className="flex items-center gap-3 border-b border-ok/40 bg-ok/10 px-4 py-2 text-[13px] text-ink">
          <CheckCircle2 size={14} className="shrink-0 text-ok" aria-hidden />
          <span className="flex-1">
            Saved and verified {lastSave.filename} ({lastSave.bytes.toLocaleString()} bytes). FluidNC keeps running the old settings until it restarts.
            Restarting puts the machine in <span className="text-ink">Alarm</span>: you will need to Home or Unlock, and the position must be homed again.
          </span>
          <Button variant="primary" onClick={() => void restartController()} disabled={!!restartBlocked} disabledReason={restartBlocked}>
            {operation === 'restarting' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Power size={14} aria-hidden />}
            Restart FluidNC
          </Button>
        </div>
      ) : null}
      {operation === 'restarting' ? (
        <div role="status" className="flex items-center gap-2 border-b border-line bg-surface-2 px-4 py-2 text-[13px] text-ink">
          <Loader2 size={14} className="animate-spin text-ink-3" aria-hidden />
          Restarting FluidNC and collecting its boot messages…
        </div>
      ) : null}
    </>
  );

  /* ---------------------------------- body ---------------------------------- */
  let body: React.ReactNode;
  if (!snapshot) {
    body = (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center text-[13px] text-ink-2">
        {operation === 'reading' ? (
          <>
            <Loader2 size={18} className="animate-spin text-ink-3" aria-hidden />
            Reading the config from the controller…
          </>
        ) : !availability.enabled ? (
          <>
            <Info size={18} className="text-ink-3" aria-hidden />
            {availability.reason}
          </>
        ) : (
          <Button variant="primary" onClick={() => void readMachineConfig()}>
            Read config
          </Button>
        )}
      </div>
    );
  } else if (view === 'review') {
    const warnings = issues.filter((i) => i.level === 'warning');
    body = (
      <div className="grid h-full min-h-0 grid-cols-[1fr_320px] gap-4 p-4">
        <div className="flex min-h-0 flex-col gap-2">
          <h3 className="panel-label">Changes to {snapshot.filename}</h3>
          {dirty ? <DiffView before={snapshot.saved} after={text} /> : <p className="text-[13px] text-ink-2">No changes.</p>}
        </div>
        <aside className="flex min-h-0 flex-col gap-4 overflow-auto">
          <section>
            <h3 className="panel-label mb-2">Checks</h3>
            {errors.length > 0 ? <IssueList issues={errors} /> : <p className="flex items-center gap-1.5 text-[13px] text-ink-2"><CheckCircle2 size={14} className="text-ok" aria-hidden />No errors.</p>}
            {warnings.length > 0 ? (
              <div className="mt-2">
                <IssueList issues={warnings} />
                <p className="mt-1 text-[12px] text-ink-3">Warnings do not block saving.</p>
              </div>
            ) : null}
          </section>
          <section className="text-[12px] text-ink-2">
            <h3 className="panel-label mb-2">What happens</h3>
            <ol className="list-decimal space-y-1 pl-4">
              <li>The current {snapshot.filename} is copied to ~/.kinetiq/config-backups on this computer.</li>
              <li>The new file is uploaded as a temporary file and read back to check it arrived intact.</li>
              <li>It then replaces {snapshot.filename}. If anything fails, the old file stays in place.</li>
              <li>FluidNC uses it after you restart it. Restarting puts the machine in Alarm.</li>
            </ol>
          </section>
          <Button
            variant="primary"
            onClick={() => void onSave()}
            disabled={!dirty || errors.length > 0 || !availability.enabled || busy}
            disabledReason={
              !dirty ? 'No changes to save' : errors.length > 0 ? 'Fix the errors first' : busy ? 'Another settings operation is in progress' : availability.reason
            }
          >
            {operation === 'saving' ? <Loader2 size={14} className="animate-spin" aria-hidden /> : <Save size={14} aria-hidden />}
            {operation === 'saving' ? 'Saving…' : `Save ${changes} ${changes === 1 ? 'change' : 'changes'} to the controller`}
          </Button>
        </aside>
      </div>
    );
  } else {
    const main =
      view === 'running' ? (
        <div className="flex min-h-0 flex-col gap-2">
          <p className="text-[12px] text-ink-3">What FluidNC is using right now ($CD), including {snapshot.defaultsCount} defaults that are not in the file. Read-only.</p>
          <CodeView text={snapshot.running} />
        </div>
      ) : view === 'yaml' ? (
        <div className="flex min-h-0 flex-col gap-2">
          <p className="text-[12px] text-ink-3">The whole file. Use spaces for indentation (Tab inserts two). The form and this view edit the same text.</p>
          <YamlEditor text={text} onChange={updateDraft} disabled={editingDisabled} issues={issues} />
        </div>
      ) : (
        <div className="grid min-h-0 grid-cols-[180px_1fr] gap-4">
          <nav aria-label="Config sections" className="min-h-0 overflow-auto">
            <ul className="space-y-0.5">
              {nav.map((item) => {
                const active = item.path.join('/').toLowerCase() === section.join('/').toLowerCase();
                const flagged = issueSections.has(item.path.join('/').toLowerCase());
                return (
                  <li key={item.path.join('/') || '_general'}>
                    <button
                      type="button"
                      onClick={() => setSection(item.path)}
                      aria-current={active ? 'true' : undefined}
                      className={`pressable flex w-full items-center gap-2 rounded-md py-1.5 pr-2 text-left text-[13px] ${item.depth ? 'pl-6' : 'pl-2'} ${
                        active ? 'bg-surface-2 text-ink' : 'text-ink-2 hover-fine:text-ink'
                      }`}
                    >
                      <span className="flex-1 truncate">{item.label}</span>
                      {flagged ? <AlertTriangle size={12} className="shrink-0 text-warn" aria-label="Has warnings" /> : null}
                    </button>
                  </li>
                );
              })}
            </ul>
          </nav>
          <div className="min-h-0 overflow-auto pr-2">
            {section.length === 0 ? (
              <>
                <h3 className="text-[15px] font-semibold text-ink">General</h3>
                <p className="mt-0.5 text-[12px] text-ink-2">Machine-wide settings at the top of the file.</p>
                <div className="mt-2">
                  {roots.filter((r) => !r.isSection).map((n) => (
                    <FieldRow key={n.key} node={n} running={running.get(n.key.toLowerCase())} issues={issues} onChange={onChange} disabled={editingDisabled} />
                  ))}
                </div>
                <MissingFields section={{ key: '', path: [], line: -1, indent: -2, value: '', endLine: -1, children: roots, isSection: true }} onAdd={onAdd} disabled={editingDisabled} />
              </>
            ) : selected ? (
              <>
                <h3 className="text-[15px] font-semibold text-ink">{nav.find((n) => n.path.join('/') === section.join('/'))?.label ?? labelFor(selected.key)}</h3>
                {sectionText(selected.path) ? <p className="mt-0.5 text-[12px] text-ink-2">{sectionText(selected.path)}</p> : null}
                <div className="mt-2">
                  <SectionBlock
                    node={
                      selected.key.toLowerCase() === 'axes' && section.length === 1
                        ? { ...selected, children: selected.children.filter((c) => !/^[xyzabcuvw]$/i.test(c.key)) }
                        : selected
                    }
                    depth={0}
                    running={running}
                    issues={issues}
                    onChange={onChange}
                    onAdd={onAdd}
                    disabled={editingDisabled}
                  />
                </div>
              </>
            ) : null}
          </div>
        </div>
      );

    body = (
      <div className="grid h-full min-h-0 grid-cols-[1fr_300px] gap-4 p-4">
        {main}
        <aside className="flex min-h-0 flex-col gap-4 overflow-auto">
          <BootProblems log={lastRestart ? lastRestart.bootLog : snapshot.bootLog} title={lastRestart ? 'Restart' : 'Boot'} />
          {lastRestart && lastRestart.bootLog.some((l) => l.level === 'error') && lastBackupId ? (
            <Button variant="warn" onClick={() => void onLoadBackup({ id: lastBackupId, filename: snapshot.filename, size: 0, savedAt: Date.now() })} disabled={busy}>
              <RotateCcw size={14} aria-hidden />
              Load the previous config to restore it
            </Button>
          ) : null}
          <section>
            <h3 className="panel-label mb-2">Problems in the file</h3>
            <IssueList issues={issues} />
          </section>
          <section>
            <h3 className="panel-label mb-2">Saved vs running</h3>
            {snapshot.differences.length === 0 ? (
              <p className="text-[12px] text-ink-2">Every value in {snapshot.filename} matches what FluidNC is running.</p>
            ) : (
              <ul className="space-y-1.5">
                {snapshot.differences.map((d) => (
                  <li key={d.path} className="text-[12px] text-ink-2">
                    <span className="font-mono text-ink">{d.path}</span>: file {d.saved || '(empty)'}, running <span className="text-warn">{d.running || '(empty)'}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="panel-label mb-2">Controller storage</h3>
            <p className="text-[12px] text-ink-2">
              {snapshot.fs.free ?? '?'} free of {snapshot.fs.total ?? '?'}
            </p>
            <ul className="mt-1.5 space-y-1">
              {snapshot.fs.files.map((f) => (
                <li key={f.name} className="flex items-center gap-2 text-[12px] text-ink-2">
                  <FileText size={12} className="shrink-0 text-ink-3" aria-hidden />
                  <span className={`flex-1 truncate font-mono ${f.name === snapshot.filename ? 'text-ink' : ''}`}>{f.name}</span>
                  <span className="tabular-nums text-ink-3">{f.size.toLocaleString()} B</span>
                </li>
              ))}
            </ul>
          </section>
          <Backups onLoad={(b) => void onLoadBackup(b)} disabled={busy} />
          <p className="text-[11px] text-ink-3">
            Descriptions come from FluidNC’s field reference ({schemaSource.repo} @ {schemaSource.commit}), which is newer than v4.0.1. A few settings may not exist on
            this firmware.
          </p>
        </aside>
      </div>
    );
  }

  /* ---------------------------------- footer ---------------------------------- */
  const footer =
    snapshot && view !== 'review' ? (
      <footer className="flex items-center gap-3 border-t border-line px-4 py-2.5">
        <span className="flex-1 text-[12px] text-ink-3">
          {dirty ? (
            <>
              <span className="text-ink">
                {changes} unsaved {changes === 1 ? 'change' : 'changes'}
              </span>
              {errors.length > 0 ? <span className="text-crit"> · {errors.length} {errors.length === 1 ? 'error' : 'errors'} to fix</span> : null}
              {' · '}FluidNC uses changes only after saving and restarting.
            </>
          ) : (
            'No unsaved changes. Edit in the form or the YAML view, then review and save.'
          )}
        </span>
        <Button variant="ghost" onClick={() => updateDraft(snapshot.saved)} disabled={!dirty || busy}>
          Discard
        </Button>
        <Button
          variant="primary"
          onClick={() => setView('review')}
          disabled={!dirty || errors.length > 0}
          disabledReason={!dirty ? 'No changes yet' : 'Fix the errors first'}
        >
          Review &amp; save…
        </Button>
      </footer>
    ) : null;

  return (
    <>
      {header}
      {banners}
      <div className="min-h-0 flex-1">{body}</div>
      {footer}
    </>
  );
}
