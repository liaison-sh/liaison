// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Cron preview, computed client-side via `cron-parser` v5, which is browser
 * safe (ESM, only depends on `Intl` and `Date`). Its own module so the parser
 * (and its `luxon` dependency) stays in the lazy routine views' chunks instead
 * of the eager routines store.
 */

import { CronExpressionParser } from "cron-parser"

/** Returns the next `count` fire times for the given cron+timezone, or [] on invalid input. */
export function cronPreview(cron: string, timezone: string, count = 3): Date[] {
  try {
    const it = CronExpressionParser.parse(cron, { tz: timezone })
    const out: Date[] = []
    for (let i = 0; i < count; i++) {
      out.push(it.next().toDate())
    }
    return out
  } catch {
    return []
  }
}
