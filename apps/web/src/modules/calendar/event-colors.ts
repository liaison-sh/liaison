// SPDX-License-Identifier: FSL-1.1-ALv2
// Google Calendar's per-event colours (`colorId` "1".."11"), as Google's colors.get lists them
// for events. An event without its own colour takes its calendar's.

const GOOGLE_EVENT_COLORS: Record<string, string> = {
  "1": "#7986cb",
  "2": "#33b679",
  "3": "#8e24aa",
  "4": "#e67c73",
  "5": "#f6bf26",
  "6": "#f4511e",
  "7": "#039be5",
  "8": "#616161",
  "9": "#3f51b5",
  "10": "#0b8043",
  "11": "#d50000",
}

const FALLBACK = "#2563eb"

/** The colour an occurrence is drawn in: its own Google colour, else its calendar's. */
export function occurrenceColor(
  occ: { calendarId: string; colorId?: string | null },
  calendarColors: Record<string, string>,
): string {
  return (
    (occ.colorId ? GOOGLE_EVENT_COLORS[occ.colorId] : undefined) ??
    calendarColors[occ.calendarId] ??
    FALLBACK
  )
}
