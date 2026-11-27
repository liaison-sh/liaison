// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The Stripe app's `dispute:response_state` translations, as the manifest
// declares them, through the real translator: an open chargeback becomes one
// Home line for the people who hold `stripe:refunds:write`, with its amount,
// customer and due date; an overdue one sorts higher but is never urgent
// (calm UI); an answered or closed one clears the line.
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import type { AppEvent } from "~/infra/events/event-bus"
import {
  type AttentionTranslation,
  manifestAttentionRegistry,
  resetAppRegistries,
} from "~/modules/apps/app-registries"
import type { UserPrefsSnapshot } from "./translator"

const ORG = "00000000-0000-0000-0000-000000000111"
const BILLER = "00000000-0000-0000-0000-000000000bbb"
const MANIFEST = join(import.meta.dir, "../../../../../bundled-apps/stripe/app.manifest.json")

type Mod = typeof import("./translator")
let mod: Mod

beforeEach(async () => {
  mod = await import("./translator")
  DurableConsumersTestAccess.reset()
  mod.AttentionTranslatorTestAccess.resetRegistration()
  resetAppRegistries()
  const manifest = JSON.parse(readFileSync(MANIFEST, "utf8")) as {
    attention: { translations: AttentionTranslation[] }
  }
  manifestAttentionRegistry.set([ORG, "stripe"], manifest.attention.translations)
})

afterEach(() => {
  DurableConsumersTestAccess.reset()
  resetAppRegistries()
})

const prefs = (): UserPrefsSnapshot => ({
  digestCadence: "daily",
  workHoursStart: "00:00",
  workHoursEnd: "00:00",
  workDays: [1, 2, 3, 4, 5, 6, 7],
  timezone: "UTC",
})

function disputeEvent(data: Record<string, unknown>): AppEvent {
  return {
    app: "stripe",
    entity: "dispute",
    action: "response_state",
    orgId: ORG,
    actorId: null as unknown as string,
    actorType: "system",
    entityId: "dp_1",
    timestamp: "2026-11-05T08:00:00.000Z",
    data: {
      stripe_id: "dp_1",
      payment_id: "ch_1",
      status: "needs_response",
      needs_response: true,
      overdue: false,
      amount: "588.00 EUR",
      customer: "Example Hotel",
      due: "2026-11-12",
      reason: "subscription_canceled",
      ...data,
    },
  }
}

async function run(event: AppEvent) {
  const inserted: Array<Record<string, unknown>> = []
  const resolved: Array<{ entityId: string; kind: string; entity: string }> = []
  const scopes: string[] = []
  await mod.processTranslationEvent(event, {
    loadPreferences: async () => prefs(),
    insertAttentionRow: async (row: unknown) => {
      inserted.push(row as Record<string, unknown>)
    },
    recipientContext: {
      loadScopeHolders: async (_orgId: string, scope: string) => {
        scopes.push(scope)
        return [BILLER]
      },
    },
    buildSubscriptionFilter: async () => async () => true,
    dispatchLive: async () => {},
    resolveAttentionRows: async (e: AppEvent, kind: string) => {
      resolved.push({ entityId: e.entityId ?? "", kind, entity: e.entity })
    },
  } as never)
  return { inserted, resolved, scopes }
}

describe("stripe dispute attention", () => {
  it("an open dispute reaches the billing people with amount, customer and due date", async () => {
    const { inserted, resolved, scopes } = await run(disputeEvent({}))
    expect(resolved).toEqual([])
    expect(new Set(scopes)).toEqual(new Set(["stripe:refunds:write"]))
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      userId: BILLER,
      app: "stripe",
      entityType: "dispute",
      entityId: "dp_1",
      kind: "stripe:dispute.needs_response",
      urgency: 60,
      isUrgent: false,
    })
    const summary = String(inserted[0]?.summary)
    expect(summary).toContain("588.00 EUR")
    expect(summary).toContain("Example Hotel")
    expect(summary).toContain("2026-11-12")
  })

  it("an overdue dispute sorts higher and is still not urgent", async () => {
    const { inserted } = await run(disputeEvent({ overdue: true }))
    expect(inserted).toHaveLength(1)
    expect(inserted[0]).toMatchObject({
      kind: "stripe:dispute.needs_response",
      urgency: 80,
      isUrgent: false,
    })
    expect(String(inserted[0]?.summary)).toContain("was due 2026-11-12")
  })

  it("an answered or closed dispute clears its line and raises none", async () => {
    for (const status of ["under_review", "won", "lost", "warning_closed"]) {
      const { inserted, resolved } = await run(
        disputeEvent({ status, needs_response: false, overdue: false }),
      )
      expect(inserted).toEqual([])
      expect(resolved).toEqual([
        { entityId: "dp_1", kind: "stripe:dispute.needs_response", entity: "dispute" },
      ])
    }
  })
})
