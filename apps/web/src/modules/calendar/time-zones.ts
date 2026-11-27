// SPDX-License-Identifier: FSL-1.1-ALv2
// Time zones in the calendar: the zone the grid is drawn in (the browser's), an optional second
// zone shown as an extra hour rail (kept per browser, like the view), and an event's own zone
// when it differs.

import { createSignal } from "solid-js"

const SECONDARY_ZONE_KEY = "liaison.calendar.secondaryTimeZone"

/** Whether Intl knows this IANA zone name. */
export function isKnownZone(zone: unknown): zone is string {
  if (typeof zone !== "string" || !zone) return false
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone })
    return true
  } catch {
    return false
  }
}

export function browserTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone
}

/** A zone's short name at an instant in a locale ("CET", "GMT+1", "UTC−5"). */
export function zoneShortName(zone: string, locale: string, at = new Date()): string {
  try {
    const part = new Intl.DateTimeFormat(locale, { timeZone: zone, timeZoneName: "short" })
      .formatToParts(at)
      .find((p) => p.type === "timeZoneName")
    return part?.value ?? zone
  } catch {
    return zone
  }
}

/** The label of the grid's hour `hour` (local, on `day`) as the clock reads in `zone`. */
export function hourLabelIn(day: Date, hour: number, zone: string, locale: string): string {
  const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour)
  try {
    const minute = new Intl.DateTimeFormat("en", { timeZone: zone, minute: "numeric" }).format(at)
    return at.toLocaleTimeString(locale, {
      timeZone: zone,
      hour: "numeric",
      ...(Number(minute) !== 0 ? { minute: "2-digit" } : {}),
    })
  } catch {
    return ""
  }
}

/** Every zone this browser knows, for the picker (a short fallback list without Intl support). */
export function knownZones(): string[] {
  const intl = Intl as unknown as { supportedValuesOf?: (key: string) => string[] }
  const list = intl.supportedValuesOf?.("timeZone")
  return list && list.length > 0
    ? list
    : [
        "UTC",
        "Europe/London",
        "Europe/Paris",
        "America/New_York",
        "America/Los_Angeles",
        "Asia/Tokyo",
      ]
}

export function loadSecondaryTimeZone(): string | null {
  try {
    const raw = localStorage.getItem(SECONDARY_ZONE_KEY)
    return isKnownZone(raw) ? raw : null
  } catch {
    return null
  }
}

export function persistSecondaryTimeZone(zone: string | null): void {
  try {
    if (zone) localStorage.setItem(SECONDARY_ZONE_KEY, zone)
    else localStorage.removeItem(SECONDARY_ZONE_KEY)
  } catch {
    // a private window without storage: the choice lasts until reload
  }
}

const [secondaryZone, setSecondaryZoneSignal] = createSignal<string | null>(loadSecondaryTimeZone())

/** The second zone the week and day grids show beside the browser's, or null. */
export const secondaryTimeZone = secondaryZone

export function setSecondaryTimeZone(zone: string | null): void {
  const value = isKnownZone(zone) && zone !== browserTimeZone() ? zone : null
  setSecondaryZoneSignal(value)
  persistSecondaryTimeZone(value)
}
