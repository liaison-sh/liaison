// SPDX-License-Identifier: FSL-1.1-ALv2
// Calendar keyboard shortcuts (Google Calendar's letters): t today, j / k next / previous,
// d / w / m day / week / month, c new event, ? the list of shortcuts. Never while typing in a
// field, never with Ctrl, Cmd or Alt held.

export type ShortcutAction =
  | "today"
  | "next"
  | "previous"
  | "day"
  | "week"
  | "month"
  | "create"
  | "help"

const KEYS: Record<string, ShortcutAction> = {
  t: "today",
  j: "next",
  n: "next",
  k: "previous",
  p: "previous",
  d: "day",
  w: "week",
  m: "month",
  c: "create",
  "?": "help",
}

/** The shortcuts the help sheet lists, in order (one key each). */
export const SHORTCUT_LIST: Array<{ keys: string; action: ShortcutAction }> = [
  { keys: "t", action: "today" },
  { keys: "j", action: "next" },
  { keys: "k", action: "previous" },
  { keys: "d", action: "day" },
  { keys: "w", action: "week" },
  { keys: "m", action: "month" },
  { keys: "c", action: "create" },
  { keys: "?", action: "help" },
]

function isTyping(target: EventTarget | null): boolean {
  if (!target || typeof (target as HTMLElement).closest !== "function") return false
  const el = target as HTMLElement
  if (el.isContentEditable) return true
  return el.closest("input, textarea, select, [contenteditable='true'], [role='dialog']") !== null
}

/** The action a key press asks for, or null (typing, a modifier held, an unmapped key). */
export function shortcutFor(
  e: Pick<KeyboardEvent, "key" | "ctrlKey" | "metaKey" | "altKey" | "target">,
): ShortcutAction | null {
  if (e.ctrlKey || e.metaKey || e.altKey) return null
  if (isTyping(e.target)) return null
  return KEYS[e.key] ?? KEYS[e.key.toLowerCase()] ?? null
}
