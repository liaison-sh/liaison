// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type { UserContext } from "~/db/rls"
import { withAppDimensionAliases } from "~/modules/apps/runtime-helpers"

function user(scopes: string[], dimensionGrants: Record<string, string[]> = {}): UserContext {
  return { actorType: "user", userId: "u1", orgId: "o1", scopes, dimensionGrants }
}

describe("withAppDimensionAliases — per-app scope aliases", () => {
  it("shopify: a granular shopify-scoped actor gains shopify:internal:read (install_metadata readable)", () => {
    // Every shopify tool calls getShopifyClient → reads the app-internal install_metadata row
    // (rlsScope:"internal"). A user holding only granular shopify scopes could not read it, so every
    // tool failed closed with "install_metadata row not found". The alias grants the read-only
    // internal scope its RLS policy accepts. (Was masked because the admin's `*` satisfies it.)
    const aliased = withAppDimensionAliases(user(["shopify:orders:read"]), "shopify")
    expect(aliased.scopes).toContain("shopify:orders:read") // original retained
    expect(aliased.scopes).toContain("shopify:internal:read") // infra read aliased in
    expect(aliased.scopes).not.toContain("shopify:internal:write") // writes stay gated
  })

  it("boxtal: a granular boxtal-scoped actor gains boxtal:internal:read (install_metadata readable)", () => {
    // Same family as shopify: every boxtal tool resolves the connection via the internal infra rows
    // (rlsScope:"internal"). Without the alias a fulfillment user holding only granular boxtal scopes
    // failed closed; aliasing the READ-only internal scope fixes the whole boxtal/shipping class.
    const aliased = withAppDimensionAliases(user(["boxtal:quotes:read"]), "boxtal")
    expect(aliased.scopes).toContain("boxtal:quotes:read") // original retained
    expect(aliased.scopes).toContain("boxtal:internal:read") // infra read aliased in
    expect(aliased.scopes).not.toContain("boxtal:internal:write") // a pure READ actor never gains write
  })

  it("boxtal: a shipments-only actor gains boxtal:catalog:read (shipping_profile/pack templates readable)", () => {
    // The shipping CATALOG (`shipping_profile` / `pack` / `pack_component`, rlsScope:"catalog") is shipping
    // INFRA the resolver `findMany`s on EVERY draft/quote/to_prepare/create_shipment to pack each line into a
    // parcel. An actor holding only `boxtal:shipments:read`/`:write` (e.g. ops_lead Nadia, who AUTHORS+OWNS
    // the fulfillment-prep routines that RUN AS HER) could NOT read those rows, so the resolver saw ZERO
    // profiles and reported every shippable line `no_profile` ("Unresolved pack") — a degenerate prepare
    // queue (the end-of-day-handoff runtime gate's intermittent FAIL). Aliasing the READ-only catalog scope
    // (reference data, like internal infra) fixes the whole prepare-queue/draft-resolution class; catalog
    // WRITE stays gated. WITHOUT the alias this assertion fails (shipments:read alone never resolves a profile).
    const ro = withAppDimensionAliases(user(["boxtal:shipments:read"]), "boxtal")
    expect(ro.scopes).toContain("boxtal:shipments:read") // original retained
    expect(ro.scopes).toContain("boxtal:catalog:read") // catalog read aliased in (profiles readable)
    expect(ro.scopes).not.toContain("boxtal:catalog:write") // catalog WRITE stays gated
    // The aliasing applies to ANY boxtal-scoped actor (quotes-only too), not just shipments.
    const q = withAppDimensionAliases(user(["boxtal:quotes:read"]), "boxtal")
    expect(q.scopes).toContain("boxtal:catalog:read")
    expect(q.scopes).not.toContain("boxtal:catalog:write")
  })

  it("boxtal: a shipments:write actor gains boxtal:internal:write (draft_override persist for set_package/set_customs)", () => {
    // The `draft_override:*` rows on app_config (rlsScope:internal) are SHIPMENT-DRAFT state:
    // shipment_draft_set_package (ad-hoc carton/parcel dims) and shipment_draft_set_customs (per-line HS-code
    // edits) persist deltas the GATED create_shipment re-merges. That flow is authorized by shipments:write
    // (the scope gating create_shipment), so a SUPPORT agent staging a warranty RETURN label — holding
    // boxtal:shipments:write but NOT catalog:write (mason-reed-rma-firmware-warranty-flow) — must also get
    // internal:write. Without it set_package 42501'd ("new row violates RLS for app_config") and the draft's
    // missing_weight block could never be lifted, dead-ending the return-label staging.
    const aliased = withAppDimensionAliases(user(["boxtal:shipments:write"]), "boxtal")
    expect(aliased.scopes).toContain("boxtal:shipments:write") // original retained
    expect(aliased.scopes).toContain("boxtal:internal:read") // infra read aliased in
    expect(aliased.scopes).toContain("boxtal:internal:write") // draft-override write authorized
  })

  it("boxtal: a catalog:write actor ALSO gains boxtal:internal:write (settings/sender_address persist) — l378", () => {
    // boxtal's only agent-writable `internal` entity is `app_config`, which stores USER CONFIG (the ship-from
    // `sender_address` set via settings_sender_address_set [scope catalog:write] + `draft_override:*`), NOT
    // connection infra. Without this alias the settings write failed closed ("new row violates RLS for
    // app_config (42501)") and onboarding the ship-from address was impossible. catalog:write → internal:write.
    const aliased = withAppDimensionAliases(user(["boxtal:catalog:write"]), "boxtal")
    expect(aliased.scopes).toContain("boxtal:internal:read")
    expect(aliased.scopes).toContain("boxtal:internal:write")
    // A read-only catalog actor does NOT gain the internal write.
    const ro = withAppDimensionAliases(user(["boxtal:catalog:read"]), "boxtal")
    expect(ro.scopes).not.toContain("boxtal:internal:write")
  })

  it("pennylane: a granular pennylane-scoped actor gains pennylane:internal:read (app_config readable) — BL-189", () => {
    // Same family as shopify/boxtal: the reports/cash read tools consult the internal `app_config`
    // connect-probe verdict via getConfig, but hold only granular pennylane:reports:read / :cash:read,
    // so the internal app_config RLS failed closed. Alias the READ-only internal scope.
    const aliased = withAppDimensionAliases(user(["pennylane:reports:read"]), "pennylane")
    expect(aliased.scopes).toContain("pennylane:reports:read") // original retained
    expect(aliased.scopes).toContain("pennylane:internal:read") // infra read aliased in
    expect(aliased.scopes).not.toContain("pennylane:internal:write") // writes stay gated
  })

  it("invoicing: an invoicing-scoped actor gains invoicing:internal:read (parks readable), never write", () => {
    // The deferred parks (`deferred_events`, rlsScope:"internal") are what the readiness view and
    // deferred_list show an issuer; without the alias an issuer holding only granular invoicing
    // scopes could not read why an order waits. Writes stay with the system actor.
    const aliased = withAppDimensionAliases(
      user(["invoicing:documents:read", "invoicing:contacts:write"]),
      "invoicing",
    )
    expect(aliased.scopes).toContain("invoicing:documents:read")
    expect(aliased.scopes).toContain("invoicing:internal:read")
    expect(aliased.scopes).not.toContain("invoicing:internal:write")
    expect(aliased.scopes).not.toContain("invoicing:internal")
  })

  it("invoicing: an actor with NO invoicing scope is not granted internal read", () => {
    const aliased = withAppDimensionAliases(user(["tickets:tickets:read"]), "invoicing")
    expect(aliased.scopes).not.toContain("invoicing:internal:read")
  })

  it("pennylane: an actor with NO pennylane scope is not granted internal read", () => {
    const aliased = withAppDimensionAliases(user(["tickets:tickets:read"]), "pennylane")
    expect(aliased.scopes).not.toContain("pennylane:internal:read")
  })

  it("shopify: an actor with NO shopify scope is not granted internal read", () => {
    const aliased = withAppDimensionAliases(user(["tickets:tickets:read"]), "shopify")
    expect(aliased.scopes).not.toContain("shopify:internal:read")
  })

  it("shopify: the admin wildcard is left unchanged (already satisfies the internal read)", () => {
    const aliased = withAppDimensionAliases(user(["*"]), "shopify")
    expect(aliased.scopes).toEqual(["*"]) // hasScope('shopify:internal:read', ['*']) is already true
  })

  it("tickets: read/write alias the messages sub-resource (existing behavior, regression-guarded)", () => {
    const r = withAppDimensionAliases(user(["tickets:tickets:read"]), "tickets")
    expect(r.scopes).toContain("tickets:messages:read")
    const w = withAppDimensionAliases(user(["tickets:tickets:write"]), "tickets")
    expect(w.scopes).toContain("tickets:messages:write")
  })

  it("mirrors bare dimension keys under the app namespace for user actors", () => {
    const aliased = withAppDimensionAliases(
      user(["shopify:orders:read"], { team: ["*"] }),
      "shopify",
    )
    if (aliased.actorType !== "user") throw new Error("expected a user actor")
    expect(aliased.dimensionGrants["shopify:team"]).toEqual(["*"]) // bare key mirrored
    expect(aliased.dimensionGrants.team).toEqual(["*"]) // original retained
  })

  it("leaves non-user (system) actors unchanged", () => {
    const sys = { actorType: "system" as const, orgId: "o1", purpose: "webhook" as const }
    expect(withAppDimensionAliases(sys, "shopify")).toBe(sys)
  })
})
