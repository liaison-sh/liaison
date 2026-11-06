// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The org cap refusals (modules/org/caps.ts on the server: 409
// SEAT_LIMIT_REACHED, MAILBOX_LIMIT_REACHED, CUSTOM_APP_LIMIT_REACHED and
// AUDIT_DAYS_LIMIT_REACHED, the OAuth callback's `oauth_error` of the same
// codes, and the upload's STORAGE_QUOTA_EXCEEDED) in the reader's language. The
// server's message is English; its code is what the web translates.
//
// In the managed edition the refusal names the plan: its limit and what it is
// meant for (one sentence per plan per cap), then what the next plan gives and
// the way out. Every number comes from the last billing push (`planFacts`).

import type { Translate } from "~/modules/i18n/i18n-context"
import { billingMode, type PlanFacts, planFacts } from "./BillingState"

/** The generic managed sentences, for a workspace whose push carries no plan facts yet. */
const MANAGED_KEY_OF_CODE: Record<string, string> = {
  SEAT_LIMIT_REACHED: "cloud-limits.caps.seatLimitReached",
  STORAGE_QUOTA_EXCEEDED: "cloud-limits.caps.storageLimitReached",
}

const KEY_OF_CODE: Record<string, string> = {
  SEAT_LIMIT_REACHED: "kernel.orgUsage.seatLimitReached",
  MAILBOX_LIMIT_REACHED: "kernel.orgUsage.mailboxLimitReached",
  CUSTOM_APP_LIMIT_REACHED: "cloud-limits.caps.customAppLimitReached",
  AUDIT_DAYS_LIMIT_REACHED: "cloud-limits.caps.auditDaysLimitReached",
}

const PLAN_CAP_OF_CODE: Record<string, "seats" | "storageGb" | "customApps" | "auditDays"> = {
  SEAT_LIMIT_REACHED: "seats",
  STORAGE_QUOTA_EXCEEDED: "storageGb",
  CUSTOM_APP_LIMIT_REACHED: "customApps",
  AUDIT_DAYS_LIMIT_REACHED: "auditDays",
}

function planRefusal(t: Translate, code: string, facts: PlanFacts): string | null {
  const cap = PLAN_CAP_OF_CODE[code]
  const limit = cap ? facts.caps[cap] : undefined
  if (!cap || typeof limit !== "number") return null
  const current = t(`cloud-limits.planCaps.${cap}.${facts.plan}`, { limit })
  const next = facts.nextPlan
  if (!next) return `${current} ${t(`cloud-limits.planCaps.${cap}.largest`)}`
  const plan = t(`cloud-billing.plan.name.${next.id}`)
  const nextLimit = next.caps[cap]
  return `${current} ${
    typeof nextLimit === "number"
      ? t(`cloud-limits.planCaps.${cap}.next`, { plan, limit: nextLimit })
      : t(`cloud-limits.planCaps.${cap}.nextUnlimited`, { plan })
  }`
}

/** The localized refusal for a cap code, or null for any other code. */
export function capLimitMessage(t: Translate, code: unknown): string | null {
  if (typeof code !== "string") return null
  if (billingMode() === "managed") {
    const facts = planFacts()
    const told = facts ? planRefusal(t, code, facts) : null
    if (told) return told
    const key = MANAGED_KEY_OF_CODE[code] ?? KEY_OF_CODE[code]
    return key ? t(key) : null
  }
  const key = KEY_OF_CODE[code]
  return key ? t(key) : null
}
