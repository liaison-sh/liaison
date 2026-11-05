// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Quiet hours need the person's clock (notification etiquette rule 8). Once
// per session the client (the web app, and the desktop and phone shells that
// run it) reports the zone its browser runs in. The server saves it only while
// the person has no known zone, never over one they chose, so this is safe to
// send on every start.

interface PatchClient {
  patch: (path: string, body?: unknown) => Promise<unknown>
}

/** The browser's IANA zone, or null when it reports none. */
export function browserTimezone(): string | null {
  try {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    return typeof tz === "string" && tz.length > 0 ? tz : null
  } catch {
    return null
  }
}

let reported = false

/** Report the browser's zone once per session; failures are ignored (the next session retries). */
export async function reportBrowserTimezone(api: PatchClient): Promise<void> {
  if (reported) return
  const tz = browserTimezone()
  if (!tz) return
  reported = true
  try {
    await api.patch("/notifications/settings", { detectedTimezone: tz })
  } catch {
    reported = false
  }
}

/** Forget the report (a new session reports again). */
export function resetBrowserTimezoneReport(): void {
  reported = false
}
