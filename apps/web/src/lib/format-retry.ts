// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Translate, tNow } from "~/modules/i18n/i18n-context"

/**
 * Human copy for a rate-limit lockout message from a Retry-After value in
 * seconds. Grammatical (no "1 seconds"), rounds up so the promise is never
 * shorter than the real wait, and switches units so no absurd magnitude ever
 * reaches the user (gestalt duration-humanizer obligation). Unknown/invalid
 * input degrades to a unit-free message rather than a fabricated number.
 */
export function formatRetryDelay(
  retryAfterSeconds: number | undefined,
  t: Translate = tNow,
): string {
  const s = retryAfterSeconds
  if (typeof s !== "number" || !Number.isFinite(s) || s <= 0) return t("kernel.retryDelay.moment")
  if (s < 90) {
    const n = Math.ceil(s)
    return n === 1 ? t("kernel.retryDelay.oneSecond") : t("kernel.retryDelay.seconds", { n })
  }
  const minutes = Math.ceil(s / 60)
  if (minutes < 90) {
    return minutes === 1
      ? t("kernel.retryDelay.oneMinute")
      : t("kernel.retryDelay.minutes", { n: minutes })
  }
  const hours = Math.ceil(s / 3600)
  return hours === 1 ? t("kernel.retryDelay.oneHour") : t("kernel.retryDelay.hours", { n: hours })
}
