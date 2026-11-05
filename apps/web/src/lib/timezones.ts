// SPDX-License-Identifier: FSL-1.1-ALv2
let _cached: string[] | null = null

export function getTimezones(): string[] {
  if (_cached) return _cached
  let list: string[]
  try {
    list = Intl.supportedValuesOf("timeZone")
  } catch {
    list = [
      "America/New_York",
      "America/Chicago",
      "America/Denver",
      "America/Los_Angeles",
      "Europe/London",
      "Europe/Paris",
      "Europe/Berlin",
      "Asia/Tokyo",
      "Asia/Shanghai",
      "Australia/Sydney",
    ]
  }
  // Some Chromium builds omit the short "UTC" alias from supportedValuesOf("timeZone"),
  // even though the org schema defaults to "UTC". Without this alias, the org
  // settings page flags the stored timezone as invalid on first load.
  if (!list.includes("UTC")) list = ["UTC", ...list]
  _cached = list
  return _cached
}
