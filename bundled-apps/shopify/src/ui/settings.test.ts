// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Shopify Settings tests — bundled-app `bun:test`. The runner transpiles JSX to
// the React runtime, so it cannot import the `./settings` `.tsx` component
// module at runtime; we therefore pin the component's load-bearing contract via
// source invariants (readFileSync) plus type-level assertions (erased at
// transpile). Full click-flow rendering lives in apps/web's Vitest/Playwright
// layer. This covers the deep review's cluster C2 settings findings:
//
//   1. A real staff-id input (not a hardcoded empty-string submit) drives the
//      identity-mapping override, with an empty-id guard before the upsert.
//   2. Disconnect lives in the settings page's connections block (the kernel
//      removes the connection and the app's disconnect handler runs), not here.
//   3. A needs_reconnect connection state (hint + reconnect affordance).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import type { ConnectionSnapshot, SettingsBundle } from "./settings"

const source = readFileSync(join(import.meta.dir, "settings.tsx"), "utf-8")

describe("ShopifyDiagnostics — identity-mapping staff id input (C2)", () => {
  it("does NOT submit a hardcoded empty staff id from the Map button", () => {
    // The regression: `onClick={() => onMap(row.liaisonUserId, "")}` always
    // sent an empty id, which the handler rejects with INVALID_ARG. The button
    // must instead open an inline editor.
    expect(source).not.toMatch(/onMap\(row\.liaisonUserId,\s*""\s*\)/)
  })

  it("renders a real text input that feeds the typed staff id into onMap", () => {
    expect(source).toMatch(/data-testid=\{`map-input-\$\{row\.liaisonUserId\}`\}/)
    expect(source).toMatch(/onInput=\{\(e\)\s*=>\s*setStaffIdDraft\(e\.currentTarget\.value\)\}/)
    // The save path submits the typed draft, not a literal empty string.
    expect(source).toMatch(/onMap\(row\.liaisonUserId,\s*staffIdDraft\(\)\)/)
  })

  it("guards an empty/blank staff id in onMap before invoking the upsert tool", () => {
    expect(source).toMatch(/const trimmed = shopifyStaffId\.trim\(\)/)
    expect(source).toMatch(/if \(!trimmed\)/)
    // The upsert is only called with the trimmed (non-empty) id.
    expect(source).toMatch(/shopifyStaffId:\s*trimmed/)
  })
})

describe("ShopifyDiagnostics — the store connection is the page's connections block", () => {
  it("offers no Connect / Disconnect of its own", () => {
    expect(source).not.toContain('data-testid="shopify-disconnect-button"')
    expect(source).not.toMatch(/app\.invokeTool\("connection_disconnect"/)
  })

  it("reconnects the SAME store, org-owned, from its health banners", () => {
    expect(source).toMatch(/connectionName: "shop"/)
    expect(source).toMatch(/mode: "org"/)
    expect(source).toMatch(/shop: shopDomain/)
    expect(source).toContain('testid="shopify-reconnect-button"')
  })
})

describe("ShopifyDiagnostics — the permissions banner under Shopify-managed installation", () => {
  it("says the scopes go into the app's configuration and a deploy before Reconnect", () => {
    // Shopify grants the released configuration's scopes: Reconnect alone adds none.
    const banner = source.slice(source.indexOf('data-testid="shopify-scope-drift-banner"'))
    const text = banner.slice(0, banner.indexOf("</Show>")).replace(/\s+/g, " ")
    expect(text).toContain("Reconnect alone cannot add them")
    expect(text).toContain("shopify app deploy")
    expect(text).toContain("[access_scopes] scopes")
    expect(text).toContain("then click Reconnect and approve")
    expect(text).not.toContain("Until you click Reconnect")
  })
})

describe("ShopifyDiagnostics — needs_reconnect state (C2)", () => {
  it("the ConnectionSnapshot type admits a needs_reconnect status", () => {
    // Type-level assertion: the union must include needs_reconnect. If a future
    // edit drops it, this stops compiling.
    const sample: ConnectionSnapshot = {
      status: "needs_reconnect",
      shopDomain: "acme.myshopify.com",
      connectedAt: null,
      scopesKnown: true,
      missingScopes: [],
    }
    expect(sample.status).toBe("needs_reconnect")
  })

  it("renders a distinct badge + reconnect affordance for needs_reconnect", () => {
    expect(source).toMatch(/b\(\)\.connection\.status === "needs_reconnect"/)
    expect(source).toContain("Re-authorisation required")
    expect(source).toContain("Reconnect Shopify")
    expect(source).toContain('data-testid="shopify-connection-reconnect-hint"')
  })
})

describe("SettingsBundle fixture covers the needs_reconnect path", () => {
  it("constructs a needs_reconnect bundle without type errors", () => {
    const bundle: SettingsBundle = {
      connection: {
        status: "needs_reconnect",
        shopDomain: "acme.myshopify.com",
        connectedAt: "2026-05-01T00:00:00Z",
        scopesKnown: true,
        missingScopes: [],
      },
      mappings: [
        {
          liaisonUserId: "u1",
          liaisonEmail: "ops@acme.test",
          shopifyStaffId: null,
          source: "unmapped",
        },
      ],
      diagnostics: {
        staffMirrorLastSyncedAt: null,
        backfillStatus: "failed",
        backfillCursor: null,
        webhookDeliveriesProcessed24h: 0,
        webhookDeliveriesFailed24h: 2,
      },
      inventoryAllowlist: [],
      seedAvailable: false,
      seedSuggestions: [],
    }
    expect(bundle.connection.status).toBe("needs_reconnect")
    expect(bundle.mappings[0]?.source).toBe("unmapped")
  })
})

describe("ShopifyDiagnostics module shape (smoke, no JSX import)", () => {
  it("the source declares a no-prop ShopifyDiagnostics Component", () => {
    expect(source).toMatch(/export const ShopifyDiagnostics:\s*Component\s*=\s*\(\)\s*=>/)
  })
})
