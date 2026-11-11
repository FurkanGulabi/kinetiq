/**
 * Keyboard jog (Position widget, opt-in): the key map and the checks that keep keys away from
 * typing and dialogs. Pure DOM/key logic, no machine policy — the machine gates are in
 * lib/cnc/derive.ts (jogButtonView, keyboardJogView). docs/ARCHITECTURE.md §10.4.
 *
 * One press = one step: auto-repeat is ignored and there is no hold-to-jog, on purpose
 * (a lost keyup would leave the machine moving).
 */
import type { JogAxis } from '@/lib/cnc/commands';

export const KEYBOARD_JOG_KEY = 'kinetiq.keyboardJog';

export type KeyboardJogAction =
  | { type: 'jog'; axis: JogAxis; direction: 1 | -1 }
  | { type: 'cancel' }
  | { type: 'step'; delta: 1 | -1 };

/** `KeyboardEvent.key` → action. Anything else is left alone. */
const KEY_MAP: Record<string, KeyboardJogAction> = {
  ArrowLeft: { type: 'jog', axis: 'X', direction: -1 },
  ArrowRight: { type: 'jog', axis: 'X', direction: 1 },
  ArrowDown: { type: 'jog', axis: 'Y', direction: -1 },
  ArrowUp: { type: 'jog', axis: 'Y', direction: 1 },
  PageDown: { type: 'jog', axis: 'Z', direction: -1 },
  PageUp: { type: 'jog', axis: 'Z', direction: 1 },
  Escape: { type: 'cancel' },
  '[': { type: 'step', delta: -1 },
  ']': { type: 'step', delta: 1 },
};

/** Shown in the Position widget while keyboard jog is on. */
export const KEYBOARD_JOG_LEGEND: { keys: string[]; label: string }[] = [
  { keys: ['←', '→'], label: 'X' },
  { keys: ['↓', '↑'], label: 'Y' },
  { keys: ['PgDn', 'PgUp'], label: 'Z' },
  { keys: ['Esc'], label: 'Stop jog' },
  { keys: ['[', ']'], label: 'Step' },
];

export function loadKeyboardJog(): boolean {
  try {
    return localStorage.getItem(KEYBOARD_JOG_KEY) === '1';
  } catch {
    return false;
  }
}

export function saveKeyboardJog(on: boolean): void {
  try {
    localStorage.setItem(KEYBOARD_JOG_KEY, on ? '1' : '0');
  } catch {
    // optional
  }
}

/** Elements that use arrow / Page / Escape keys themselves: text entry, native selects, radio groups, lists, the console log. */
const OWNS_KEYS = [
  'input',
  'textarea',
  'select',
  '[contenteditable]:not([contenteditable="false"])',
  '[role="textbox"]',
  '[role="combobox"]',
  '[role="listbox"]',
  '[role="option"]',
  '[role="radiogroup"]',
  '[role="radio"]',
  '[role="tablist"]',
  '[role="slider"]',
  '[role="spinbutton"]',
  '[role="menu"]',
  '[role="menuitem"]',
  '[role="grid"]',
  '[role="tree"]',
  '[role="log"]',
].join(',');

/** Any open overlay: Radix Dialog / AlertDialog content, Radix Select menu, or another modal. */
const OVERLAY = '[role="dialog"],[role="alertdialog"],[role="listbox"],[role="menu"],[aria-modal="true"],[data-radix-popper-content-wrapper]';

function ownsKeys(node: EventTarget | Element | null): boolean {
  return node instanceof Element && node.closest(OWNS_KEYS) !== null;
}

/**
 * The action for this keydown, or null when the event must be left alone: auto-repeat, a modifier
 * held, already handled, IME composition, page hidden, focus in something that types or uses the
 * keys itself, or a dialog / select menu open.
 */
export function keyboardJogAction(event: KeyboardEvent): KeyboardJogAction | null {
  const action = KEY_MAP[event.key];
  if (!action) return null;
  if (event.repeat || event.defaultPrevented || event.isComposing) return null;
  if (event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return null;
  if (typeof document === 'undefined' || document.visibilityState !== 'visible') return null;
  if (ownsKeys(event.target) || ownsKeys(document.activeElement)) return null;
  if (document.querySelector(OVERLAY)) return null;
  return action;
}
