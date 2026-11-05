// SPDX-License-Identifier: FSL-1.1-ALv2
// A project's look: the icons and colours a person picks from when creating
// or editing a project, and the glyph a stored icon name resolves to.
import {
  Archive,
  BellOff,
  CalendarDays,
  Check,
  ChevronDown,
  Flag,
  FolderKanban,
  Globe,
  Hourglass,
  Inbox,
  ListChecks,
  Mail,
  MessageSquare,
  Pencil,
  Plus,
  Search,
  Send,
  ShieldCheck,
  Star,
  Ticket,
  Trash2,
  User,
  X,
} from "lucide-solid"
import type { Component } from "solid-js"

export const ICON_OPTIONS: Array<{
  name: string
  icon: Component<{ size?: number; class?: string }>
}> = [
  { name: "FolderKanban", icon: FolderKanban },
  { name: "ListChecks", icon: ListChecks },
  { name: "MessageSquare", icon: MessageSquare },
  { name: "Ticket", icon: Ticket },
  { name: "Mail", icon: Mail },
  { name: "ShieldCheck", icon: ShieldCheck },
  { name: "CalendarDays", icon: CalendarDays },
  { name: "Flag", icon: Flag },
  { name: "Star", icon: Star },
  { name: "Globe", icon: Globe },
  { name: "Inbox", icon: Inbox },
  { name: "Archive", icon: Archive },
  { name: "Search", icon: Search },
  { name: "Hourglass", icon: Hourglass },
  { name: "BellOff", icon: BellOff },
  { name: "Send", icon: Send },
  { name: "Pencil", icon: Pencil },
  { name: "Trash2", icon: Trash2 },
  { name: "Check", icon: Check },
  { name: "X", icon: X },
  { name: "User", icon: User },
  { name: "Plus", icon: Plus },
  { name: "ChevronDown", icon: ChevronDown },
]

// A project with no icon (the API and the agent tools create them without
// one), or with a name this picker no longer offers, shows the default
// project glyph. It used to fall back to lucide's Square: an empty box at the
// head of each row that read as a checkbox and did nothing when clicked. A
// stored "Square" (once offered in the picker) resolves here too.
export function projectIcon(
  name: string | null | undefined,
): Component<{ size?: number; class?: string }> {
  return ICON_OPTIONS.find((option) => option.name === name)?.icon ?? FolderKanban
}

export const COLOR_OPTIONS = Array.from({ length: 8 }, (_, i) => `var(--avatar-${i}-bg)`)
