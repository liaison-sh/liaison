// SPDX-License-Identifier: FSL-1.1-ALv2
// The org cap refusals (SEAT_LIMIT_REACHED, MAILBOX_LIMIT_REACHED) are shown in
// the reader's language, from their code, never the server's English text.

import { afterEach, describe, expect, it } from "vitest"
import type { TranslateParams } from "~/modules/i18n/i18n-context"
import { BillingStateTestAccess, ensureBillingModeLoaded } from "~/modules/settings/BillingState"
import { capLimitMessage } from "~/modules/settings/cap-limit-message"
import { atLimit } from "~/modules/settings/OrgUsageSection"
import enBilling from "../../../../../packages/shared/src/i18n/locales/en/cloud-billing.json"
import enLimits from "../../../../../packages/shared/src/i18n/locales/en/cloud-limits.json"
import frLimits from "../../../../../packages/shared/src/i18n/locales/fr/cloud-limits.json"

const t = (key: string) => `t:${key}`

const managed = (state: Record<string, unknown>) =>
  ensureBillingModeLoaded({
    get: async () => ({
      mode: "managed",
      tier: "starter",
      status: "active",
      periodEnd: "2027-01-01T00:00:00.000Z",
      includedCredits: "3",
      previewEndsAt: null,
      autoTopUp: { enabled: false, thresholdCredits: 0, amountCredits: 10 },
      ...state,
    }),
  } as never)

describe("capLimitMessage", () => {
  afterEach(() => BillingStateTestAccess.reset())

  it("maps the cap codes to their i18n keys, anything else to null", () => {
    expect(capLimitMessage(t, "SEAT_LIMIT_REACHED")).toBe("t:kernel.orgUsage.seatLimitReached")
    expect(capLimitMessage(t, "MAILBOX_LIMIT_REACHED")).toBe(
      "t:kernel.orgUsage.mailboxLimitReached",
    )
    expect(capLimitMessage(t, "PERSONAL_MAILBOX_LIMIT_REACHED")).toBeNull()
    expect(capLimitMessage(t, "STORAGE_QUOTA_EXCEEDED")).toBeNull()
    expect(capLimitMessage(t, "INVITE_PENDING")).toBeNull()
    expect(capLimitMessage(t, undefined)).toBeNull()
  })

  it("self-hosted keeps pointing at whoever runs the server", async () => {
    await ensureBillingModeLoaded({ get: async () => ({ mode: "self_hosted" }) } as never)
    expect(capLimitMessage(t, "SEAT_LIMIT_REACHED")).toBe("t:kernel.orgUsage.seatLimitReached")
  })

  it("managed without plan facts: the generic sentence pointing at a larger plan", async () => {
    await ensureBillingModeLoaded({ get: async () => ({ mode: "managed" }) } as never)
    expect(capLimitMessage(t, "SEAT_LIMIT_REACHED")).toBe("t:cloud-limits.caps.seatLimitReached")
    expect(capLimitMessage(t, "STORAGE_QUOTA_EXCEEDED")).toBe(
      "t:cloud-limits.caps.storageLimitReached",
    )
  })

  const en =
    (ns: Record<string, unknown>) =>
    (key: string, p: TranslateParams = {}) => {
      const path = key.replace(/^cloud-(limits|billing)\./, "").split(".")
      const value = path.reduce((o: unknown, k) => (o as Record<string, unknown>)?.[k], ns)
      return String(value ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(p[k]))
    }

  it("on Preview: its limit, what it is meant for, what Base gives", async () => {
    await managed({
      plan: "preview",
      caps: { seats: 3, storageGb: 5, customApps: 1, auditDays: 30 },
      nextPlan: { id: "base", caps: { seats: null, storageGb: 50, customApps: 5, auditDays: 90 } },
    })
    const tr = en({ ...enLimits, ...enBilling })
    expect(capLimitMessage(tr, "SEAT_LIMIT_REACHED")).toBe(
      "Preview is limited to 3 people: it is only meant for a quick look at Liaison. Base has no limit on people. Move to it in Billing, or an admin can deactivate someone first.",
    )
    expect(capLimitMessage(tr, "STORAGE_QUOTA_EXCEEDED")).toContain("5 GB")
    expect(capLimitMessage(tr, "STORAGE_QUOTA_EXCEEDED")).toContain("Base gives 50 GB")
    expect(capLimitMessage(tr, "CUSTOM_APP_LIMIT_REACHED")).toContain("Base allows 5")
    expect(capLimitMessage(tr, "AUDIT_DAYS_LIMIT_REACHED")).toContain("Base keeps it for 90 days")
  })

  it("on Pro: says it is the largest plan and offers no next one", async () => {
    await managed({
      plan: "pro",
      caps: { seats: 17, storageGb: 500, customApps: 50, auditDays: 365 },
      nextPlan: null,
    })
    const out = capLimitMessage(en({ ...enLimits, ...enBilling }), "STORAGE_QUOTA_EXCEEDED")
    expect(out).toContain("Pro is limited to 500 GB")
    expect(out).toContain("largest plan")
  })

  it("a cap the plan leaves unlimited falls back to the generic sentence, and never a raw key", async () => {
    await managed({ plan: "base", caps: { seats: null }, nextPlan: null })
    expect(capLimitMessage(t, "SEAT_LIMIT_REACHED")).toBe("t:cloud-limits.caps.seatLimitReached")
  })

  it("every plan and cap has its sentences, in every language", () => {
    for (const locale of [enLimits, frLimits]) {
      const planCaps = locale.planCaps as Record<string, Record<string, string>>
      expect(Object.keys(planCaps).sort()).toEqual([
        "auditDays",
        "customApps",
        "seats",
        "storageGb",
      ])
      for (const sentences of Object.values(planCaps)) {
        expect(Object.keys(sentences).sort()).toEqual([
          "base",
          "largest",
          "next",
          "nextUnlimited",
          "preview",
          "pro",
        ])
        for (const plan of ["preview", "base", "pro"]) {
          expect(sentences[plan]).toContain("{{limit}}")
        }
      }
    }
  })
})

describe("atLimit", () => {
  it("never says the limit is reached for an unlimited cap, nor for a cap under 1", () => {
    expect(atLimit({ used: 5, limit: null })).toBe(false)
    expect(atLimit({ used: 0, limit: 0 })).toBe(false)
    expect(atLimit({ used: 3, limit: 3 })).toBe(true)
    expect(atLimit({ used: 2, limit: 3 })).toBe(false)
  })
})
