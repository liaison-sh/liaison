// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shopify.app.toml a person deploys with the Shopify CLI is generated from
// the Shopify app's manifest: its scopes are the manifest's, its redirect is the
// connections callback, its webhook API version is the one the app pins. The
// example file shipped with the app is that same output, byte for byte.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { CONNECTIONS_CALLBACK_PATH } from "./paths"
import {
  type ShopifyConnectionManifest,
  shopifyAppToml,
  shopifyAppValues,
} from "./shopify-app-toml"

const REPO = path.resolve(import.meta.dir, "../../../../..")
const SHOPIFY = path.join(REPO, "bundled-apps/shopify")

const manifest = JSON.parse(readFileSync(path.join(SHOPIFY, "app.manifest.json"), "utf8")) as {
  connections: { shop: ShopifyConnectionManifest }
}
const shop = manifest.connections.shop

/** The example's base URL: a placeholder domain. */
const EXAMPLE_BASE = "https://liaison.example.com"

interface ParsedToml {
  client_id: string
  name: string
  application_url: string
  embedded: boolean
  access_scopes: {
    scopes: string
    optional_scopes?: string[]
    use_legacy_install_flow: boolean
  }
  auth: { redirect_urls: string[] }
  webhooks: { api_version: string; subscriptions?: unknown }
}

function parse(toml: string): ParsedToml {
  return Bun.TOML.parse(toml) as unknown as ParsedToml
}

describe("shopifyAppToml", () => {
  test("scopes equal the manifest's, under Shopify-managed installation", () => {
    const t = parse(shopifyAppToml("https://l.example", shop))
    expect(t.access_scopes.scopes.split(",")).toEqual(shop.scopes ?? [])
    expect(t.access_scopes.use_legacy_install_flow).toBe(false)
  })

  test("no optional scopes: managed installation refuses read_users there", () => {
    const toml = shopifyAppToml("https://l.example", {
      ...shop,
      optionalScopes: ["read_users"],
    } as ShopifyConnectionManifest)
    expect(parse(toml).access_scopes.optional_scopes).toBeUndefined()
    expect(toml).not.toContain("optional_scopes")
    expect(toml).not.toContain("read_users")
  })

  test("the only redirect is the connections callback under BASE_URL", () => {
    const t = parse(shopifyAppToml("https://l.example/", shop))
    expect(t.auth.redirect_urls).toEqual([`https://l.example${CONNECTIONS_CALLBACK_PATH}`])
    expect(t.application_url).toBe("https://l.example")
    expect(t.embedded).toBe(false)
  })

  test("webhooks carry the app's API version and no subscription", () => {
    const t = parse(shopifyAppToml("https://l.example", shop))
    expect(t.webhooks.api_version).toBe(shop.apiVersion as string)
    expect(t.webhooks.subscriptions).toBeUndefined()
    const constants = readFileSync(path.join(SHOPIFY, "src/lib/constants.ts"), "utf8")
    // The app's API_VERSION is read from the same manifest field.
    expect(constants).toContain("connections?.shop")
    expect(constants).toContain("apiVersion")
  })

  test("client_id is empty until the CLI created the app, then filled in", () => {
    expect(parse(shopifyAppToml("https://l.example", shop)).client_id).toBe("")
    const filled = parse(shopifyAppToml("https://l.example", shop, { clientId: "abc123" }))
    expect(filled.client_id).toBe("abc123")
    expect(filled.name).toBe("Liaison")
  })

  test("quotes and backslashes in a value stay one string", () => {
    const t = parse(shopifyAppToml("https://l.example", shop, { name: 'A "B" \\ C' }))
    expect(t.name).toBe('A "B" \\ C')
  })

  test("a connection without scopes or API version is refused", () => {
    expect(() => shopifyAppToml("https://l.example", { ...shop, scopes: [] })).toThrow(/scopes/)
    expect(() => shopifyAppToml("https://l.example", { ...shop, apiVersion: undefined })).toThrow(
      /apiVersion/,
    )
  })

  test("a protected scope (read_all_orders) stays out until the org opted in", () => {
    // Shopify refuses a release naming a scope the app is not approved for.
    expect(shop.protectedScopes?.map((p) => p.scope)).toContain("read_all_orders")
    const fromManifest = shopifyAppToml("https://l.example", shop)
    expect(fromManifest).not.toContain("read_all_orders")
    // Even a connection that also lists it among its scopes.
    const listed = parse(
      shopifyAppToml("https://l.example", {
        ...shop,
        scopes: [...(shop.scopes ?? []), "read_all_orders"],
      }),
    )
    expect(listed.access_scopes.scopes.split(",")).not.toContain("read_all_orders")
  })

  test("an opted-in protected scope is listed once, after the base scopes", () => {
    // Managed installation grants only what the released configuration names, so
    // full order history needs read_all_orders in the file.
    const t = parse(
      shopifyAppToml("https://l.example", shop, { protectedScopes: ["read_all_orders"] }),
    )
    const scopes = t.access_scopes.scopes.split(",")
    expect(scopes).toEqual([...(shop.scopes ?? []), "read_all_orders"])
    // A scope the connection does not declare protected is never added this way.
    const other = parse(shopifyAppToml("https://l.example", shop, { protectedScopes: ["write_x"] }))
    expect(other.access_scopes.scopes.split(",")).toEqual(shop.scopes ?? [])
  })

  test("the shipped example is the generator's output for a placeholder URL", () => {
    const example = readFileSync(path.join(SHOPIFY, "shopify.app.toml.example"), "utf8")
    expect(example).toBe(shopifyAppToml(EXAMPLE_BASE, shop))
    expect(example).not.toContain("read_all_orders")
  })
})

describe("shopifyAppValues (the Dev Dashboard guide's values)", () => {
  test("equal what the file holds, so the two paths cannot drift", () => {
    const v = shopifyAppValues("https://l.example/", shop)
    const t = parse(shopifyAppToml("https://l.example/", shop))
    expect(v.appUrl).toBe(t.application_url)
    expect(v.redirectUrls).toEqual(t.auth.redirect_urls)
    expect(v.scopes.join(",")).toBe(t.access_scopes.scopes)
    expect(v.apiVersion).toBe(t.webhooks.api_version)
  })
})
