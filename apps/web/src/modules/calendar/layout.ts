// SPDX-License-Identifier: FSL-1.1-ALv2
// Pure layout math for the calendar views — no Solid, fully unit-testable.
//
// Two problems solved here:
//  1. MONTH LANES — multi-day / all-day events render as continuous horizontal bands across
//     the days they span (Google Calendar style). Per week row, each spanning event becomes a
//     segment (startCol..endCol + continues markers) and segments are packed into lanes.
//  2. DAY COLUMNS — overlapping timed events in a day column split the column width. Classic
//     interval-partitioning: events sharing an overlap cluster get side-by-side columns.
import type { ExpandedOccurrence } from "./rrule-expand"

export function occStartDate(occ: ExpandedOccurrence): Date | null {
  if (occ.start?.dateTime) return new Date(occ.start.dateTime)
  if (occ.start?.date) return new Date(`${occ.start.date}T00:00:00`)
  return null
}

/** Exclusive end for all-day (Google all-day `end.date` is exclusive); inclusive instant for timed. */
export function occEndDate(occ: ExpandedOccurrence): Date | null {
  if (occ.end?.dateTime) return new Date(occ.end.dateTime)
  if (occ.end?.date) return new Date(`${occ.end.date}T00:00:00`)
  return occStartDate(occ)
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate())
}

function dayDiff(a: Date, b: Date): number {
  return Math.round((startOfDay(b).getTime() - startOfDay(a).getTime()) / 86_400_000)
}

/** Days an occurrence covers, as [firstDay, lastDay] inclusive, in local time.
 * All-day events: end.date is EXCLUSIVE. Timed events ending exactly at midnight do not
 * bleed into the next day. */
export function occurrenceDaySpan(occ: ExpandedOccurrence): { first: Date; last: Date } | null {
  const start = occStartDate(occ)
  const end = occEndDate(occ)
  if (!start || !end) return null
  const first = startOfDay(start)
  let last: Date
  if (occ.allDay || occ.end?.date) {
    last = new Date(startOfDay(end).getTime() - 86_400_000)
  } else if (end.getTime() > start.getTime() && end.getHours() === 0 && end.getMinutes() === 0) {
    last = new Date(startOfDay(end).getTime() - 86_400_000)
  } else {
    last = startOfDay(end)
  }
  if (last.getTime() < first.getTime()) last = first
  return { first, last }
}

export function isSpanning(occ: ExpandedOccurrence): boolean {
  const span = occurrenceDaySpan(occ)
  if (!span) return false
  return occ.allDay || dayDiff(span.first, span.last) > 0
}

export interface WeekSegment {
  occ: ExpandedOccurrence
  /** 0-6 inclusive columns within the week row */
  startCol: number
  endCol: number
  /** Event continues beyond this week row (render squared-off edge) */
  continuesLeft: boolean
  continuesRight: boolean
  lane: number
}

/** Pack the spanning occurrences of one week row (weekDays = 7 consecutive local days)
 * into lanes. Deterministic: longer spans first, then earlier start, then title. */
export function layoutWeekSegments(
  weekDays: Date[],
  occurrences: ExpandedOccurrence[],
): WeekSegment[] {
  const weekFirst = startOfDay(weekDays[0]!)
  const weekLast = startOfDay(weekDays[6]!)
  const segments: Omit<WeekSegment, "lane">[] = []
  for (const occ of occurrences) {
    const span = occurrenceDaySpan(occ)
    if (!span) continue
    if (span.last.getTime() < weekFirst.getTime() || span.first.getTime() > weekLast.getTime()) {
      continue
    }
    const startCol = Math.max(0, dayDiff(weekFirst, span.first))
    const endCol = Math.min(6, dayDiff(weekFirst, span.last))
    segments.push({
      occ,
      startCol,
      endCol,
      continuesLeft: span.first.getTime() < weekFirst.getTime(),
      continuesRight: span.last.getTime() > weekLast.getTime(),
    })
  }
  segments.sort((a, b) => {
    const spanA = a.endCol - a.startCol
    const spanB = b.endCol - b.startCol
    if (spanA !== spanB) return spanB - spanA
    if (a.startCol !== b.startCol) return a.startCol - b.startCol
    return (a.occ.title ?? "").localeCompare(b.occ.title ?? "")
  })
  // Greedy lane assignment: first lane with no column overlap.
  const lanes: Array<Array<[number, number]>> = []
  const out: WeekSegment[] = []
  for (const seg of segments) {
    let lane = 0
    for (; lane < lanes.length; lane++) {
      const taken = lanes[lane]!
      if (taken.every(([s, e]) => seg.endCol < s || seg.startCol > e)) break
    }
    if (lane === lanes.length) lanes.push([])
    lanes[lane]!.push([seg.startCol, seg.endCol])
    out.push({ ...seg, lane })
  }
  return out
}

export interface PositionedBlock {
  occ: ExpandedOccurrence
  /** minutes from midnight, clamped to [0, 1440] */
  startMin: number
  endMin: number
  /** column index / total columns within the overlap cluster */
  col: number
  cols: number
}

/** Position the timed occurrences of ONE local day: overlap clusters split into columns. */
export function layoutDayColumns(day: Date, occurrences: ExpandedOccurrence[]): PositionedBlock[] {
  const dayStart = startOfDay(day).getTime()
  const dayEnd = dayStart + 86_400_000
  const blocks: Omit<PositionedBlock, "col" | "cols">[] = []
  for (const occ of occurrences) {
    if (occ.allDay || isSpanning(occ)) continue
    const start = occStartDate(occ)
    const end = occEndDate(occ)
    if (!start || !end) continue
    if (end.getTime() <= dayStart || start.getTime() >= dayEnd) continue
    const startMin = Math.max(0, (start.getTime() - dayStart) / 60_000)
    const endMin = Math.min(1440, Math.max(startMin + 20, (end.getTime() - dayStart) / 60_000))
    blocks.push({ occ, startMin, endMin })
  }
  blocks.sort((a, b) => a.startMin - b.startMin || b.endMin - a.endMin)

  // Interval partitioning into columns, cluster by cluster.
  const out: PositionedBlock[] = []
  let cluster: Array<Omit<PositionedBlock, "col" | "cols"> & { col: number }> = []
  let clusterEnd = -1
  const flush = () => {
    if (cluster.length === 0) return
    const cols = Math.max(...cluster.map((b) => b.col)) + 1
    for (const b of cluster)
      out.push({ occ: b.occ, startMin: b.startMin, endMin: b.endMin, col: b.col, cols })
    cluster = []
  }
  const colEnds: number[] = []
  for (const b of blocks) {
    if (b.startMin >= clusterEnd) {
      flush()
      colEnds.length = 0
      clusterEnd = -1
    }
    let col = colEnds.findIndex((end) => end <= b.startMin)
    if (col === -1) {
      col = colEnds.length
      colEnds.push(b.endMin)
    } else {
      colEnds[col] = b.endMin
    }
    cluster.push({ ...b, col })
    clusterEnd = Math.max(clusterEnd, b.endMin)
  }
  flush()
  return out
}
