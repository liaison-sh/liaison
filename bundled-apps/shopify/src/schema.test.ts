// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const MANIFEST_PATH = join(import.meta.dir, "..", "app.manifest.json")

interface SchemaTable {
  fields: Record<string, unknown>
  constraints?: { unique?: string[][] }
  indexes?: string[][]
}

function loadSchema(): Record<string, SchemaTable> {
  const m = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    schema?: Record<string, SchemaTable>
  }
  if (!m.schema) throw new Error("manifest has no `schema` block")
  return m.schema
}

describe("Shopify app schema (manifest.schema block)", () => {
  it("declares the 5 Phase-16 tables", () => {
    const s = loadSchema()
    for (const t of [
      "webhook_deliveries",
      "staff_mirror",
      "staff_overrides",
      "backfill_progress",
      "install_metadata",
    ]) {
      expect(s[t]).toBeDefined()
    }
  })

  it("webhook_deliveries: dedupe by webhookId, indexed by (topic, receivedAt)", () => {
    const t = loadSchema().webhook_deliveries
    expect(t).toBeDefined()
    expect(t?.fields.webhookId).toBe("string")
    expect(t?.fields.topic).toBe("string")
    expect(t?.fields.shopDomain).toBe("string")
    expect(t?.constraints?.unique).toContainEqual(["webhookId"])
    expect(t?.indexes).toContainEqual(["topic", "receivedAt"])
    expect(t?.indexes).toContainEqual(["receivedAt"])
  })

  it("webhook_deliveries.status is an enum (processing | processed | failed)", () => {
    const t = loadSchema().webhook_deliveries
    const s = t?.fields.status as { enum?: string[] }
    expect(s?.enum).toEqual(["processing", "processed", "failed"])
  })

  it("staff_mirror: unique on shopifyStaffId, permissions stored as json", () => {
    const t = loadSchema().staff_mirror
    expect(t?.constraints?.unique).toContainEqual(["shopifyStaffId"])
    expect(t?.fields.permissionsJson).toBe("json")
    expect(t?.fields.isShopOwner).toBe("boolean")
  })

  it("staff_overrides: liaisonUserId + createdBy are userRef with onErase rules", () => {
    const t = loadSchema().staff_overrides
    const lid = t?.fields.liaisonUserId as { userRef?: boolean; onErase?: string }
    expect(lid?.userRef).toBe(true)
    expect(lid?.onErase).toBe("delete")
    const cb = t?.fields.createdBy as { userRef?: boolean; onErase?: string }
    expect(cb?.userRef).toBe(true)
    expect(cb?.onErase).toBe("anonymize")
    // I10 — only liaisonUserId is unique; shopifyStaffId conflicts are
    // surfaced as typed errors by `staff_overrides_upsert` rather than a
    // raw constraint violation. This keeps admin overrides resolvable.
    expect(t?.constraints?.unique).toContainEqual(["liaisonUserId"])
    expect(t?.constraints?.unique).not.toContainEqual(["shopifyStaffId"])
  })

  it("backfill_progress: keyed by entityType, status enum", () => {
    const t = loadSchema().backfill_progress
    expect(t?.constraints?.unique).toContainEqual(["entityType"])
    const status = t?.fields.status as { enum?: string[] }
    expect(status?.enum).toEqual(["idle", "running", "failed", "completed"])
  })

  it("install_metadata: connection lifecycle fields with defaults", () => {
    const t = loadSchema().install_metadata
    expect(t?.fields.shopDomain).toBe("string")
    expect(t?.fields.connectionId).toBe("uuid")
    const cs = t?.fields.connectionStatus as { enum?: string[]; default?: string }
    // `needs_reconnect` is the tri-state surfaced by the Settings UI (settings_load)
    // when scope-mirror/token health degrades — see ui/settings.tsx.
    expect(cs?.enum).toEqual(["connected", "disconnected", "needs_reconnect"])
    expect(cs?.default).toBe("connected")
    const ut = t?.fields.unfulfilledThresholdHours as { default?: number; type?: string }
    expect(ut?.default).toBe(24)
    expect(ut?.type).toBe("integer")
    const consec = t?.fields.consecutiveScopeMirrorFailures as { default?: number }
    expect(consec?.default).toBe(0)
    // Plan §B3: allowlist of inventory locations the connection writes to (null = all)
    expect(t?.fields.inventoryLocationAllowlist).toBeDefined()
  })

  it("install_metadata: optional apiBaseUrl override (P2a — E2E harness uses this)", () => {
    const t = loadSchema().install_metadata
    // String, optional — the test harness writes the mock-shopify URL here so
    // the read-side `getShopifyClient` builds a ShopifyClient bound to the mock.
    // In production this stays null and the canonical `https://<shop>.myshopify.com`
    // host is used.
    expect(t?.fields.apiBaseUrl).toBe("string?")
  })
})
