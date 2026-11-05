// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * `shopify.app.toml` for a self-hosted Liaison, generated from the Shopify app's
 * own manifest so the app a person creates with the Shopify CLI asks for exactly
 * the scopes Liaison requests and returns to Liaison's connection callback.
 *
 * - `client_id`: empty until the CLI creates the app (`shopify app config link`);
 *   the agent then hands the file again with the id filled in.
 * - `[access_scopes] use_legacy_install_flow = false`: Shopify-managed
 *   installation. Liaison still runs the authorization code grant itself
 *   (`/admin/oauth/authorize`, then the code exchange), but Shopify grants the
 *   scopes of the app's released configuration, whatever the URL asks for. A scope
 *   reaches a store only once it is in this file and `shopify app deploy` released
 *   it; a Reconnect then grants it. The legacy flow is not used: Shopify refused its
 *   authorization redirects ("redirect_uri is not whitelisted") for a Dev Dashboard
 *   app, and it can leave installations with different scopes.
 * - No `optional_scopes`: managed installation refuses `read_users` there, and
 *   Liaison never asks for a scope later, so the manifest's `optionalScopes` stay out.
 * - Protected scopes (`protectedScopes`, e.g. `read_all_orders`) appear only when
 *   the org opted in to them (`protectedScopes` option, from
 *   connections/protected-scopes.ts `loadOptedInScopes`): Shopify refuses a release
 *   that names a scope the app is not approved for, and grants a protected scope
 *   only when the released configuration lists it.
 * - `[webhooks]` carries the API version only: the subscriptions are created per
 *   workspace through the Admin API when a store connects, to
 *   `/webhooks/<org>/shopify/<topic>`, so they never live in this file.
 */
import { CONNECTIONS_CALLBACK_PATH } from "~/modules/connection-guides/paths"

/** The parts of the manifest's `shop` connection the file is built from. */
export interface ShopifyConnectionManifest {
  scopes?: string[]
  protectedScopes?: Array<{ scope: string }>
  apiVersion?: string
}

export interface ShopifyAppTomlOptions {
  /** The app's client id once the CLI created it. */
  clientId?: string
  /** The app's name in Shopify. */
  name?: string
  /** The base of the redirect URL, when not the app URL's (shopifyAppValues). */
  redirectBaseUrl?: string
  /** Protected scopes the org opted in to (connections/protected-scopes.ts
   *  `loadOptedInScopes`): listed with the scopes. Any other protected scope stays out. */
  protectedScopes?: readonly string[]
}

/** The name the file is stored and handed over under. A stored file cannot be named
 *  `shopify.app.toml`: every extension of a name is checked against the executable
 *  denylist (modules/files/attach.ts), and `.app` is on it. The guide's first step has
 *  the person save it as `shopify.app.toml`. */
export const SHOPIFY_APP_TOML_HANDED_FILENAME = "shopify-app.toml"
const DEFAULT_APP_NAME = "Liaison"

/** A TOML basic string. */
function tomlString(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
}

function tomlArray(values: readonly string[]): string {
  return `[ ${values.map(tomlString).join(", ")} ]`
}

/** The app's settings, the same in the Dev Dashboard guide and in the file. */
export interface ShopifyAppValues {
  appUrl: string
  redirectUrls: string[]
  scopes: string[]
  apiVersion: string
}

/** The Shopify app's settings for this server, from the manifest's `shop`
 *  connection: what the file holds and the Dev Dashboard guide shows. The app
 *  URL is on `baseUrl`; the redirect URL on `redirectBaseUrl`, the base the
 *  OAuth flow sends as its redirect_uri. `optedInProtected`: the protected scopes
 *  the org opted in to, added after the base scopes (a scope the connection does
 *  not declare protected is ignored). */
export function shopifyAppValues(
  baseUrl: string,
  connection: ShopifyConnectionManifest,
  redirectBaseUrl: string = baseUrl,
  optedInProtected: readonly string[] = [],
): ShopifyAppValues {
  const base = baseUrl.replace(/\/+$/, "")
  const redirectBase = redirectBaseUrl.replace(/\/+$/, "")
  const isProtected = new Set((connection.protectedScopes ?? []).map((p) => p.scope))
  const baseScopes = (connection.scopes ?? []).filter((s) => !isProtected.has(s))
  if (baseScopes.length === 0) throw new Error("The Shopify connection declares no scopes")
  if (!connection.apiVersion) throw new Error("The Shopify connection declares no apiVersion")
  return {
    appUrl: base,
    redirectUrls: [`${redirectBase}${CONNECTIONS_CALLBACK_PATH}`],
    scopes: [
      ...baseScopes,
      ...[...isProtected].filter((s) => optedInProtected.includes(s) && !baseScopes.includes(s)),
    ],
    apiVersion: connection.apiVersion,
  }
}

export function shopifyAppToml(
  baseUrl: string,
  connection: ShopifyConnectionManifest,
  options: ShopifyAppTomlOptions = {},
): string {
  const v = shopifyAppValues(baseUrl, connection, options.redirectBaseUrl, options.protectedScopes)
  const lines = [
    `# Shopify app configuration for Liaison at ${v.appUrl}.`,
    "# Generated from the Shopify app's manifest: keep the scopes and URLs as they are.",
    "# To add a scope later, download this file again from Liaison (or add it to",
    "# [access_scopes] scopes), run `shopify app deploy`, then Reconnect in Liaison.",
    "# Docs: https://shopify.dev/docs/apps/build/cli-for-apps/app-configuration",
    "",
    `client_id = ${tomlString(options.clientId ?? "")}`,
    `name = ${tomlString(options.name ?? DEFAULT_APP_NAME)}`,
    `application_url = ${tomlString(v.appUrl)}`,
    "embedded = false",
    "",
    "[access_scopes]",
    "# Shopify grants a store exactly these scopes when it connects (managed installation).",
    `scopes = ${tomlString(v.scopes.join(","))}`,
    "use_legacy_install_flow = false",
    "",
    "[auth]",
    `redirect_urls = ${tomlArray(v.redirectUrls)}`,
    "",
    "[webhooks]",
    "# Liaison subscribes to the store's webhooks through the Admin API when the store connects.",
    `api_version = ${tomlString(v.apiVersion)}`,
    "",
  ]
  return lines.join("\n")
}
