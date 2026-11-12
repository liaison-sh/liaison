// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The nominal proforma: per-item lines (so the draft resolved from it has the SAME parcels and
// customs articles as the sale invoice would), the 1 EUR split, the correlation reference, and
// the three envelope outcomes.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync } from "node:fs"
import { join, resolve } from "node:path"
import { HOUSE_PACKAGING_POLICY } from "./__fixtures__/packaging-policy"
import type { BoxtalToolCtx, CrossAppEnvelope } from "./ctx"
import {
  buildNominalLines,
  ensureNominalProforma,
  isProformaApprovalExpired,
  type ProformaItem,
  prepProformaShipmentRef,
  prepProformaToken,
  resolvePendingProformas,
  splitNominal,
} from "./proforma"
import { createMockDb } from "./test-db"

const NOMINAL_TOTAL_MINOR = HOUSE_PACKAGING_POLICY.nominal_proforma_value_minor!

const ITEMS: ProformaItem[] = [
  {
    name: "Tessera 2",
    quantity: 1,
    external_id: "TESSERA2",
    product_source: "shopify",
    hs_code: "9207.90",
  },
  { name: "Power supply", quantity: 1, external_id: "PSU", product_source: "shopify" },
  { name: "USB cable", quantity: 1, external_id: "CBL", product_source: "shopify" },
]

interface StubOpts {
  /** The org's stored packaging policy; defaults to the house policy (nominal value set). */
  policy?: unknown
  issuers?: unknown
  proforma?: CrossAppEnvelope
  documents?: unknown
}

function makeCtx(opts: StubOpts = {}): {
  ctx: BoxtalToolCtx
  calls: Array<{ target: string; args: unknown }>
} {
  const calls: Array<{ target: string; args: unknown }> = []
  const executeTool = async (target: string, args: unknown): Promise<CrossAppEnvelope> => {
    calls.push({ target, args })
    if (target === "invoicing:settings_issuer_profile_list") {
      return { status: "completed", result: opts.issuers ?? [{ id: "issuer-1", active: true }] }
    }
    if (target === "invoicing:proforma_create_and_issue") {
      return (
        opts.proforma ?? {
          status: "completed",
          result: { status: "completed", document_id: "prof-1", number: "PF-2026-001" },
        }
      )
    }
    if (target === "invoicing:documents_search") {
      return { status: "completed", result: opts.documents ?? [] }
    }
    return { status: "error", error: { code: "unmocked", message: target } }
  }
  return {
    ctx: {
      orgId: "org-1",
      executeTool,
      db: createMockDb({
        seed: {
          app_config:
            opts.policy === null
              ? []
              : [
                  {
                    id: "cfg-packaging",
                    key: "packaging_policy",
                    value: opts.policy ?? HOUSE_PACKAGING_POLICY,
                  },
                ],
        },
      }),
    } as unknown as BoxtalToolCtx,
    calls,
  }
}

function issuedParams(calls: Array<{ target: string; args: unknown }>): Record<string, unknown> {
  const call = calls.find((c) => c.target === "invoicing:proforma_create_and_issue")
  return (call?.args ?? {}) as Record<string, unknown>
}

describe("splitNominal", () => {
  it("splits 1 EUR across three single-unit lines with no handling remainder", () => {
    const { unitPrices, handlingMinor } = splitNominal([1, 1, 1], NOMINAL_TOTAL_MINOR)
    expect(unitPrices).toEqual([98, 1, 1])
    expect(handlingMinor).toBe(0)
    expect(unitPrices[0]! * 1 + unitPrices[1]! + unitPrices[2]!).toBe(NOMINAL_TOTAL_MINOR)
  })

  it("keeps the document at 1 EUR when the first line has a quantity", () => {
    const { unitPrices, handlingMinor } = splitNominal([2, 1, 1], NOMINAL_TOTAL_MINOR)
    const total = unitPrices[0]! * 2 + unitPrices[1]! * 1 + unitPrices[2]! * 1 + handlingMinor
    expect(total).toBe(NOMINAL_TOTAL_MINOR)
  })

  it("puts an indivisible remainder on a handling line rather than distorting a unit value", () => {
    const { unitPrices, handlingMinor } = splitNominal([7, 1], NOMINAL_TOTAL_MINOR)
    expect(handlingMinor).toBeGreaterThan(0)
    expect(unitPrices[0]! * 7 + unitPrices[1]! * 1 + handlingMinor).toBe(NOMINAL_TOTAL_MINOR)
  })

  it("never declares a zero unit value when more units ship than there are minor units", () => {
    const { unitPrices, handlingMinor } = splitNominal(new Array(150).fill(1), NOMINAL_TOTAL_MINOR)
    expect(unitPrices.every((p) => p >= 1)).toBe(true)
    expect(handlingMinor).toBe(0)
  })
})

describe("buildNominalLines", () => {
  it("(2a) makes one line per physical item with the house suffix, the real quantity and the catalog ref", () => {
    const lines = buildNominalLines(ITEMS, "repair", NOMINAL_TOTAL_MINOR)
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.description)).toEqual([
      "1x Tessera 2: RETURN AFTER REPAIR - NO COMMERCIAL VALUE",
      "1x Power supply: RETURN AFTER REPAIR - NO COMMERCIAL VALUE",
      "1x USB cable: RETURN AFTER REPAIR - NO COMMERCIAL VALUE",
    ])
    expect(lines.map((l) => l.external_id)).toEqual(["TESSERA2", "PSU", "CBL"])
    expect(lines.every((l) => l.product_source === "shopify")).toBe(true)
    expect(lines[0]!.hs_code).toBe("9207.90")
    const total = lines.reduce((s, l) => s + l.quantity * l.unit_price_minor, 0)
    expect(total).toBe(NOMINAL_TOTAL_MINOR)
  })

  it("(2b) uses the sample wording for the gift category", () => {
    const lines = buildNominalLines(
      [{ name: "Tessera 2", quantity: 1 }],
      "gift",
      NOMINAL_TOTAL_MINOR,
    )
    expect(lines[0]!.description).toBe("1x Tessera 2: SAMPLE - NO COMMERCIAL VALUE")
  })

  it("carries a real quantity through onto the line", () => {
    const lines = buildNominalLines(
      [{ name: "Pads", quantity: 4, external_id: "PAD" }],
      "repair",
      NOMINAL_TOTAL_MINOR,
    )
    expect(lines[0]!.quantity).toBe(4)
    expect(lines[0]!.description.startsWith("4x Pads")).toBe(true)
  })
})

describe("ensureNominalProforma", () => {
  const base = {
    order_key: "so:5123",
    category: "repair" as const,
    counterparty: {
      legal_name: "Quinn Dupont",
      country: "FR",
      contact_id: "contact-1",
      address: "12 rue des Lilas, 75011 Paris",
      email: "quinn.dupont@example.test",
    },
    items: ITEMS,
    shopify_order_id: "5123",
    shopify_order_number: "#3400",
  }

  it("(2c) carries the correlation token in reason and the correlation ref in shipment_ref", async () => {
    const { ctx, calls } = makeCtx()
    const res = await ensureNominalProforma(ctx, base)
    expect(res).toEqual({ status: "completed", document_id: "prof-1", number: "PF-2026-001" })
    const params = issuedParams(calls)
    expect(String(params.reason)).toContain(prepProformaToken("so:5123"))
    expect(String(params.reason).startsWith("RETURN AFTER REPAIR")).toBe(true)
    expect(params.shipment_ref).toBe(prepProformaShipmentRef("so:5123"))
    expect(params.currency).toBe("EUR")
    expect(params.incoterm).toBe("DAP")
    expect(params.declared_value_minor).toBe(NOMINAL_TOTAL_MINOR)
    expect(params.issuer_profile_id).toBe("issuer-1")
    expect(params.shopify_order_id).toBe("5123")
    expect((params.items as unknown[]).length).toBe(3)
  })

  it("declares the org's own nominal value, split across the lines", async () => {
    const { ctx, calls } = makeCtx({
      policy: { ...HOUSE_PACKAGING_POLICY, nominal_proforma_value_minor: 500 },
    })
    const res = await ensureNominalProforma(ctx, base)
    expect(res.status).toBe("completed")
    const params = issuedParams(calls)
    expect(params.declared_value_minor).toBe(500)
    const lines = params.items as Array<{ quantity: number; unit_price_minor: number }>
    expect(lines.reduce((s, l) => s + l.quantity * l.unit_price_minor, 0)).toBe(500)
  })

  it("refuses, naming the setting, when the org has no packaging policy, and never calls invoicing", async () => {
    const { ctx, calls } = makeCtx({ policy: null })
    const res = await ensureNominalProforma(ctx, base)
    expect(res).toMatchObject({ status: "error", code: "nominal_value_unset" })
    expect((res as { message: string }).message).toContain("settings_packaging_policy_set")
    expect(calls.some((c) => c.target === "invoicing:proforma_create_and_issue")).toBe(false)
  })

  // Invoicing REFUSES to issue a document whose recipient is incomplete
  // (REQUIRED_COUNTERPARTY_FIELDS = legal_name + country + address + email, enforced before any
  // gating or numbering). The proforma call used to send neither address nor email reliably, so
  // every Return-after-repair / Sample / Add-shipment row failed with invoicing's own
  // `counterparty_incomplete`, which named fields the operator could not map back to the row.
  it("sends all four recipient fields invoicing requires", async () => {
    const { ctx, calls } = makeCtx()
    const res = await ensureNominalProforma(ctx, base)
    expect(res.status).toBe("completed")
    const cp = issuedParams(calls).counterparty as Record<string, unknown>
    for (const field of ["legal_name", "country", "address", "email"]) {
      expect(typeof cp[field]).toBe("string")
      expect(String(cp[field]).trim().length).toBeGreaterThan(0)
    }
    expect(cp.email).toBe("quinn.dupont@example.test")
    expect(cp.address).toBe("12 rue des Lilas, 75011 Paris")
  })

  it("refuses an incomplete recipient by NAME, without calling invoicing", async () => {
    for (const missing of ["legal_name", "country", "address", "email"] as const) {
      const { ctx, calls } = makeCtx()
      const res = await ensureNominalProforma(ctx, {
        ...base,
        counterparty: { ...base.counterparty, [missing]: null },
      })
      expect(res.status).toBe("error")
      expect(res).toMatchObject({ code: "recipient_incomplete" })
      expect((res as { message: string }).message).toContain(missing)
      // The refusal happens locally: no cross-app issuance is attempted.
      expect(calls.some((c) => c.target === "invoicing:proforma_create_and_issue")).toBe(false)
    }
  })

  it("treats a whitespace-only recipient field as missing", async () => {
    const { ctx } = makeCtx()
    const res = await ensureNominalProforma(ctx, {
      ...base,
      counterparty: { ...base.counterparty, email: "   " },
    })
    expect(res).toMatchObject({ status: "error", code: "recipient_incomplete" })
  })

  it("(2d) surfaces a pending approval id instead of a document", async () => {
    const { ctx } = makeCtx({ proforma: { status: "pending_approval", approval_id: "appr-9" } })
    expect(await ensureNominalProforma(ctx, base)).toEqual({
      status: "pending_approval",
      approval_id: "appr-9",
    })
  })

  it("(2d) also unwraps a pending approval returned INSIDE the invoicing result", async () => {
    const { ctx } = makeCtx({
      proforma: {
        status: "completed",
        result: { status: "pending_approval", approval_id: "appr-inner" },
      },
    })
    expect(await ensureNominalProforma(ctx, base)).toEqual({
      status: "pending_approval",
      approval_id: "appr-inner",
    })
  })

  it("(2e) surfaces a forbidden refusal as a typed error", async () => {
    const { ctx } = makeCtx({
      proforma: {
        status: "error",
        error: { code: "forbidden", message: "missing invoicing:documents:write" },
      },
    })
    const res = await ensureNominalProforma(ctx, base)
    expect(res.status).toBe("error")
    expect((res as { code: string }).code).toBe("forbidden")
  })

  it("reads the issuer list in the shape invoicing ACTUALLY serves: { items: [...] }", async () => {
    // Caught by the local Playwright pass, 2026-09-04: the module read `profiles`/`results` only,
    // so against a fully configured org every proforma issue died with "no issuer profile is
    // configured". invoicing's settings_issuer_profile_list returns `{ items }` (reads.ts).
    const { ctx, calls } = makeCtx({ issuers: { items: [{ id: "issuer-real", active: true }] } })
    const res = await ensureNominalProforma(ctx, base)
    expect(res.status).toBe("completed")
    const issued = calls.find((c) => c.target === "invoicing:proforma_create_and_issue")!
    expect((issued.args as { issuer_profile_id: string }).issuer_profile_id).toBe("issuer-real")
  })

  it("(2f) surfaces a missing issuer profile as issuer_not_found, without calling invoicing", async () => {
    const { ctx, calls } = makeCtx({ issuers: [] })
    const res = await ensureNominalProforma(ctx, base)
    expect(res.status).toBe("error")
    expect((res as { code: string }).code).toBe("issuer_not_found")
    expect((res as { message: string }).message).toContain("issuer profile")
    expect(calls.some((c) => c.target === "invoicing:proforma_create_and_issue")).toBe(false)
  })

  it("refuses an empty item list rather than issuing a document that describes nothing", async () => {
    const { ctx } = makeCtx()
    const res = await ensureNominalProforma(ctx, { ...base, items: [] })
    expect((res as { code: string }).code).toBe("no_items")
  })
})

describe("resolvePendingProformas", () => {
  it("(2g) matches by the correlation ref and ignores every other proforma", async () => {
    const { ctx } = makeCtx({
      documents: [
        { id: "prof-a", number: "PF-1", shipment_ref: prepProformaShipmentRef("so:5123") },
        { id: "prof-b", number: "PF-2", shipment_ref: "batch-2" },
        { id: "prof-c", number: "PF-3", shipment_ref: null },
        { id: "prof-d", number: "PF-4", shipment_ref: prepProformaShipmentRef("so:9999") },
      ],
    })
    const resolved = await resolvePendingProformas(ctx, [
      { order_key: "so:5123", proforma_pending_approval_id: "appr-1" },
    ])
    expect([...resolved.keys()]).toEqual(["so:5123"])
    expect(resolved.get("so:5123")).toEqual({
      order_key: "so:5123",
      document_id: "prof-a",
      number: "PF-1",
    })
  })

  it("resolves an order-less pending row by its pending token", async () => {
    const { ctx } = makeCtx({
      documents: {
        results: [
          { id: "prof-z", number: "PF-9", shipment_ref: prepProformaShipmentRef("pending:tok1") },
        ],
      },
    })
    const resolved = await resolvePendingProformas(ctx, [{ order_key: "pending:tok1" }])
    expect(resolved.get("pending:tok1")?.document_id).toBe("prof-z")
  })

  it("makes no call at all when nothing is pending", async () => {
    const { ctx, calls } = makeCtx()
    expect((await resolvePendingProformas(ctx, [])).size).toBe(0)
    expect(calls).toHaveLength(0)
  })
})

describe("isProformaApprovalExpired", () => {
  it("flags an approval left pending past the two week mark", () => {
    const now = Date.parse("2026-09-04T00:00:00.000Z")
    expect(isProformaApprovalExpired("2026-09-01T00:00:00.000Z", now)).toBe(false)
    expect(isProformaApprovalExpired("2026-08-01T00:00:00.000Z", now)).toBe(true)
    expect(isProformaApprovalExpired(null, now)).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The rot guard. The case above pins `now` explicitly and is immune. A FIXTURE
// is not: a seeded `proforma_requested_at` is read back through the production
// call site (orders.ts -> isProformaApprovalExpired with the default wall
// clock), so an absolute literal is a timer. One such fixture in prep.test.ts,
// written as 2026-09-01, went red of its own accord fourteen days later and
// read as a regression in the code around it.
// ─────────────────────────────────────────────────────────────────────────────
/** `bundled-apps/`, so the walk reaches every app and not just this one. */
const BUNDLED_ROOT = resolve(import.meta.dir, "..", "..")

describe("no pending-proforma fixture pins an absolute date", () => {
  const KEY = "proforma_requested_at"

  /**
   * The seeded key and whatever is written after it.
   *
   * The key may be bare (`proforma_requested_at:`), quoted (`"...":`, a JSON
   * fixture or an object written with quoted keys) or backticked. A pattern
   * that only accepted the bare spelling read a quoted one as absent, and a
   * `.json` fixture beside the code was never opened at all.
   */
  const KEY_ASSIGNMENT = new RegExp(`["'\`]?${KEY}["'\`]?\\s*:\\s*([^,\\n}]+)`, "g")

  /** A calendar date written out: the thing that goes off on its own. */
  const ABSOLUTE_DATE = /\d{4}-\d{2}-\d{2}/

  /** A bare identifier, the shape a seed hidden behind a const takes. */
  const IDENTIFIER = /^([A-Za-z_$][\w$]*)$/

  /**
   * Whether what was seeded is an absolute instant.
   *
   * A literal answers for itself. An identifier does not: `proforma_requested_at:
   * PINNED` is the same timer with a name in front of it, so a simple identifier
   * is resolved against its declaration IN THE SAME FILE and the answer is read
   * off whatever that declaration holds. Nothing else is chased: a value built
   * from `Date.now()` or `new Date(...)` moves with the clock and is exactly
   * what this guard asks for.
   */
  function valueIsPinned(source: string, raw: string, depth = 0): boolean {
    const value = raw.trim()
    if (/^["'`]/.test(value)) return ABSOLUTE_DATE.test(value)
    const named = IDENTIFIER.exec(value)
    if (named && depth < 3) {
      const declaration = new RegExp(`\\b(?:const|let|var)\\s+${named[1]}\\s*=\\s*([^\\n]+)`).exec(
        source,
      )
      if (!declaration) return false
      return valueIsPinned(source, declaration[1] as string, depth + 1)
    }
    return false
  }

  /** Every offending seed in one file, as `path:value`. */
  function offendersIn(file: string): string[] {
    const source = readFileSync(file, "utf8")
    const out: string[] = []
    for (const match of source.matchAll(KEY_ASSIGNMENT)) {
      if (valueIsPinned(source, match[1] as string)) {
        out.push(`${file.replace(`${BUNDLED_ROOT}/`, "")}: ${(match[1] as string).trim()}`)
      }
    }
    return out
  }

  function walk(dir: string, keep: (name: string) => boolean): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === "dist") continue
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        out.push(...walk(full, keep))
        continue
      }
      if (keep(entry.name)) out.push(full)
    }
    return out
  }

  const isTestSource = (name: string): boolean =>
    name.includes(".test.") && (name.endsWith(".ts") || name.endsWith(".tsx"))
  const isSeedFile = (name: string): boolean => isTestSource(name) || name.endsWith(".json")
  const isAppSource = (name: string): boolean => name.endsWith(".ts") && !name.includes(".test.")

  /** Every bundled app whose own code reads the pending-proforma horizon. */
  function appsWithHorizon(): string[] {
    return readdirSync(BUNDLED_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .filter((app) =>
        walk(join(BUNDLED_ROOT, app), isAppSource).some((file) =>
          readFileSync(file, "utf8").includes(KEY),
        ),
      )
      .sort()
  }

  it("names every bundled app the horizon reaches, so the walk below covers them", () => {
    // The guard used to walk one app's own directory and say nothing about the
    // rest. If a second app ever reads this horizon, its fixtures are timers
    // too and this case is what says so.
    expect(appsWithHorizon()).toEqual(["boxtal"])
  })

  it("scans real files (sanity: the scan is not empty)", () => {
    const files = appsWithHorizon().flatMap((app) => walk(join(BUNDLED_ROOT, app), isSeedFile))
    expect(files.length).toBeGreaterThan(20)
    expect(files.some((f) => f.endsWith(".json"))).toBe(true)
  })

  it("seeds the pending timestamp relative to now, in every app that has a horizon", () => {
    const offenders = appsWithHorizon()
      .flatMap((app) => walk(join(BUNDLED_ROOT, app), isSeedFile))
      .flatMap(offendersIn)
    expect(offenders).toEqual([])
  })

  it("is falsifiable: it catches every shape of a pinned seed and spares a relative one", () => {
    // The quotes are assembled rather than written, so these probes are not
    // themselves offenders when the scan above reads this very file.
    const q = String.fromCharCode(34)
    const tick = String.fromCharCode(39)
    const pinned = [
      // The bare key, the shape the first pattern caught.
      `${KEY}: ${q}2026-09-01T00:00:00Z${q},`,
      // A quoted key: an object written JSON-style, and a .json fixture.
      `${q}${KEY}${q}: ${q}2026-09-01T00:00:00Z${q},`,
      `${tick}${KEY}${tick}: ${tick}2026-09-01T00:00:00Z${tick},`,
      // The same timer with a name in front of it.
      `const PINNED = ${q}2026-09-01T00:00:00Z${q}\n${KEY}: PINNED,`,
    ]
    for (const probe of pinned) {
      const found = [...probe.matchAll(KEY_ASSIGNMENT)].some((m) =>
        valueIsPinned(probe, m[1] as string),
      )
      expect(found, probe).toBe(true)
    }
    const relative = [
      `${KEY}: new Date(Date.now() - 3600000).toISOString(),`,
      `${q}${KEY}${q}: null,`,
      `const RECENT = new Date(Date.now() - 3600000).toISOString()\n${KEY}: RECENT,`,
    ]
    for (const probe of relative) {
      const found = [...probe.matchAll(KEY_ASSIGNMENT)].some((m) =>
        valueIsPinned(probe, m[1] as string),
      )
      expect(found, probe).toBe(false)
    }
  })
})
