// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * How a connection is set up, computed once for every surface that guides a
 * person through it: the agent's tools (`kernel__google_setup`,
 * `kernel__shopify_setup`), the `liaison guide` and `liaison connect` commands.
 * Each takes the same values and the same shared step builders
 * (`@liaison/shared` setup-guides.ts), so the steps cannot differ between them.
 */
import {
  type GoogleConnectPath,
  type GoogleDriveMode,
  type GoogleSetupValues,
  googleClientInternalTo,
  googleConnectPath,
  googleConsumerStatement,
  googleDriveMode,
  googleInternalTrustStep,
  googleSetupGuide,
  googleTrustedClients,
  googleTrustedGuide,
  IMAP_PROVIDERS,
  type ImapProvider,
  imapPasswordGuide,
  type MailAccountType,
  type SetupGuide,
  type SetupGuideId,
  type SetupGuideTranslate,
  type SetupSurface,
  type ShippedLocale,
  type ShopifyDashboardValues,
  shopifyDashboardGuide,
  shopifySetupGuide,
} from "@liaison/shared"
import { withPrivilegedDb } from "~/db/privileged"
import { env } from "~/lib/env"
import { connectionConfigRegistry, webhookHandlers } from "~/modules/apps/app-registries"
import { resolveOAuthClient } from "~/modules/apps/connections/oauth-client"
import { loadOptedInScopes, protectedScopesOf } from "~/modules/apps/connections/protected-scopes"
import { detectMailAccountType, type MxResolver } from "~/modules/connection-guides/account-type"
import { type ConnectionSetup, connectionSetup } from "~/modules/connection-guides/connection-setup"
import {
  computeGoogleSetupValues,
  resolveGoogleClientProven,
  resolveGoogleClientSources,
  resolveGoogleClients,
} from "~/modules/connection-guides/google"
import { CONNECTIONS_CALLBACK_PATH } from "~/modules/connection-guides/paths"
import { guideEstimate } from "~/modules/connection-guides/setup-timings"
import {
  SHOPIFY_APP_TOML_HANDED_FILENAME,
  shopifyAppToml,
  shopifyAppValues,
} from "~/modules/connection-guides/shopify-app-toml"
import { serverT } from "~/modules/i18n/server-i18n"

export function translator(locale: ShippedLocale): SetupGuideTranslate {
  return (key, params) => serverT(locale, key, params)
}

/** The workspace's Google setup values, with where every client comes from. */
export async function resolveGoogleSetupValues(
  orgId: string,
  focus: { projectId?: string; feature?: string; supportEmail?: string } = {},
): Promise<GoogleSetupValues> {
  return computeGoogleSetupValues(
    orgId,
    await resolveGoogleClientSources(orgId),
    await resolveGoogleClientProven(orgId),
    await resolveGoogleClients(orgId),
    focus,
  )
}

/** How an address connects, computed the same way for the agent, `liaison guide`
 *  and `liaison connect`: its account type, the Gmail client, and the guide of
 *  its path. */
export interface GoogleConnectPlan {
  email?: string
  /** Null: no address was given. */
  accountType: MailAccountType | null
  path: GoogleConnectPath
  /** How Google Drive connects for this address (null: no account type known). */
  driveMode: GoogleDriveMode | null
  /** What a personal Gmail account gets, said BEFORE any setup (path consumer_imap). */
  statement?: string
  /** The guide of the path: Trusted, create-your-own-client, or IMAP. */
  guide: SetupGuide | null
  /** Minutes of the person's own time the guide takes, low and high (setup-timings.ts):
   *  said before its first step. */
  minutes?: [number, number]
  imap?: {
    provider: ImapProvider
    settings: (typeof IMAP_PROVIDERS)[ImapProvider]
    guide: SetupGuide
  }
}

/** The plan of one address (or of none) from computed values. Pure but for the MX lookup. */
export async function googleConnectPlan(
  values: GoogleSetupValues,
  t: SetupGuideTranslate,
  params: { email?: string; imapProvider?: ImapProvider; accountType?: MailAccountType },
  options: { resolver?: MxResolver } = {},
): Promise<GoogleConnectPlan> {
  // The person's own word (e.g. a Workspace domain whose mail goes through a
  // filtering gateway, which MX records cannot show) wins over detection.
  const detected = params.accountType
    ? {
        accountType: params.accountType,
        imapProvider:
          params.accountType === "google_workspace" || params.accountType === "google_consumer"
            ? ("gmail" as const)
            : params.accountType === "microsoft"
              ? ("outlook" as const)
              : undefined,
      }
    : params.email
      ? await detectMailAccountType(params.email, { resolver: options.resolver })
      : null
  const accountType = detected?.accountType ?? null
  const path = googleConnectPath(accountType, values.clients.workspace, params.email)
  // The server's client is Internal to this address's Workspace: nobody marks it
  // Trusted; the guide names the one admin check for a Workspace that restricts
  // Gmail or Drive access ("Trust internal, domain-owned apps").
  const internal =
    path === "consent" &&
    values.clients.workspace.source === "instance" &&
    googleClientInternalTo(values.clients.workspace, params.email)
  const imapProvider =
    params.imapProvider ??
    (path === "imap" || path === "consumer_imap" ? detected?.imapProvider : undefined)
  const imap = imapProvider
    ? {
        provider: imapProvider,
        settings: IMAP_PROVIDERS[imapProvider],
        guide: imapPasswordGuide(imapProvider, t),
      }
    : undefined
  let guide: SetupGuide | null = null
  let guideId: SetupGuideId | null = null
  if (path === "trusted") {
    guideId = "googleTrusted"
    guide = googleTrustedGuide(
      { baseUrl: values.baseUrl, clients: googleTrustedClients(values.clients) },
      t,
    )
  } else if (path === "own_client" || path === "consent" || (path === "ask" && !params.email)) {
    // The same guide the agent's remainingInGoogleCloud is read from.
    guide = googleSetupGuide(values, t)
    guideId = "google"
    if (internal) guide = { ...guide, steps: [...guide.steps, googleInternalTrustStep(t)] }
  } else if (path === "consumer_imap" || path === "imap") {
    guide = imap?.guide ?? null
    if (guide) guideId = "imap"
  }
  const minutes = guideId ? guideEstimate(guideId)?.minutes : undefined
  return {
    ...(params.email ? { email: params.email } : {}),
    accountType,
    path,
    driveMode: accountType ? googleDriveMode(accountType, values.clients.drive) : null,
    ...(path === "consumer_imap" ? { statement: googleConsumerStatement(t) } : {}),
    guide,
    ...(minutes ? { minutes } : {}),
    ...(imap ? { imap } : {}),
  }
}

/**
 * The protected scopes of the Shopify connection the org opted in to (the app's
 * `fullOrderHistory` toggle for `read_all_orders`). Under Shopify-managed
 * installation a store gets only the scopes of the app's released configuration,
 * so the generated shopify.app.toml lists these too: turning the toggle on, then
 * regenerating and deploying the file, is what lets a Reconnect grant them.
 */
export async function shopifyOptedInProtectedScopes(
  orgId: string,
  connection: { protectedScopes?: Array<{ scope: string; setting: string }> },
): Promise<string[]> {
  const declared = protectedScopesOf(connection)
  if (declared.length === 0) return []
  return await withPrivilegedDb(orgId, "shopify-app-toml-scopes", (tx) =>
    loadOptedInScopes(tx, orgId, "shopify", declared),
  )
}

/** The Shopify Dev Dashboard values and guide for this server, or why there is none. */
export async function shopifyDashboardPlan(
  orgId: string,
  t: SetupGuideTranslate,
  surface: SetupSurface = "app",
): Promise<
  | { values: ShopifyDashboardValues; guide: SetupGuide; minutes?: [number, number] }
  | { error: { code: string; message: string; status: 400; retryable: true } }
> {
  const connection = connectionConfigRegistry.get([orgId, "shopify", "shop"])
  if (!connection) {
    return {
      error: {
        code: "shopify_not_installed",
        message:
          "The Shopify app is not on in this workspace. Turn it on first (kernel__config_apps), then call this again.",
        status: 400,
        retryable: true,
      },
    }
  }
  const client = await resolveOAuthClient(orgId, "shopify:shop")
  const values: ShopifyDashboardValues = {
    clientSource: client.source,
    ...shopifyAppValues(env.BASE_URL, connection),
    protectedScopes: (connection.protectedScopes ?? []).map((p) => p.scope),
    surface,
  }
  const minutes = guideEstimate("shopifyDashboard")?.minutes
  return { values, guide: shopifyDashboardGuide(values, t), ...(minutes ? { minutes } : {}) }
}

/**
 * The Shopify CLI path for a coding agent (`liaison guide shopify --cli`): the
 * steps on the `agent` surface (the agent writes the file, deploys and reads the
 * client back; the person runs only the interactive login and link) and the
 * shopify.app.toml generated for this server, the same file the in-product agent
 * hands over.
 */
export async function shopifyCliPlan(
  orgId: string,
  t: SetupGuideTranslate,
): Promise<
  | { guide: SetupGuide; toml: string }
  | { error: { code: string; message: string; status: 400; retryable: true } }
> {
  const connection = connectionConfigRegistry.get([orgId, "shopify", "shop"])
  if (!connection) {
    return {
      error: {
        code: "shopify_not_installed",
        message:
          "The Shopify app is not on in this workspace. Turn it on first, then call this again.",
        status: 400,
        retryable: true,
      },
    }
  }
  const client = await resolveOAuthClient(orgId, "shopify:shop")
  const callbackUrl = `${env.BASE_URL.replace(/\/+$/, "")}${CONNECTIONS_CALLBACK_PATH}`
  const guide = shopifySetupGuide(
    {
      clientSource: client.source,
      callbackUrl,
      hasClientId: false,
      handedFilename: SHOPIFY_APP_TOML_HANDED_FILENAME,
      surface: "agent",
    },
    t,
  )
  const protectedScopes = await shopifyOptedInProtectedScopes(orgId, connection)
  return { guide, toml: shopifyAppToml(env.BASE_URL, connection, { protectedScopes }) }
}

/** The webhook endpoint names an app registered for this org. */
export function appWebhookEndpoints(orgId: string, app: string): string[] {
  return [...webhookHandlers.snapshotUnder([orgId, app]).keys()]
    .map((raw) => raw.split("\0").at(-1) ?? "")
    .filter((name) => name !== "" && name !== app)
    .sort()
}

/**
 * The setup of any connection of an app that is registered for the org: what
 * the client card, `liaison guide <app>/<connection>` and `liaison connect`
 * show (connection-setup.ts). Null when the app has no such connection.
 */
export function appConnectionSetup(
  orgId: string,
  app: string,
  connection: string,
): ConnectionSetup | null {
  const decl = connectionConfigRegistry.get([orgId, app, connection])
  if (!decl) return null
  return connectionSetup({
    baseUrl: env.BASE_URL,
    orgId,
    app,
    connection,
    decl,
    webhookEndpoints: appWebhookEndpoints(orgId, app),
  })
}

/** Every connection of the apps registered for the org, as `[app, connection]`. */
export function orgConnections(orgId: string): Array<[app: string, connection: string]> {
  return [...connectionConfigRegistry.snapshotUnder([orgId]).keys()]
    .map((raw) => raw.split("\0"))
    .filter((parts) => parts.length === 3)
    .map((parts) => [parts[1] as string, parts[2] as string] as [string, string])
    .sort((a, b) => `${a[0]}/${a[1]}`.localeCompare(`${b[0]}/${b[1]}`))
}
