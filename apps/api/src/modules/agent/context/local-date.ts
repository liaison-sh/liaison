// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * " There it is Wednesday, 28 October 2026.": the person's own date with its
 * weekday, so the agent never works a weekday or "next week" out of a UTC
 * timestamp. Empty for a timezone the runtime cannot read.
 */
export function localDateSentence(now: Date, timeZone: string): string {
  try {
    const day = new Intl.DateTimeFormat("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone,
    }).format(now)
    return ` There it is ${day}.`
  } catch {
    return ""
  }
}
