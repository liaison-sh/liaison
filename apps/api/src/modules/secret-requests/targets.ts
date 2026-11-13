// SPDX-License-Identifier: FSL-1.1-ALv2
//
// WHAT A SECRET REQUEST ASKS FOR, AND WHERE THE SECRET GOES.
//
// A secret request names a KIND (which store takes the secret) and a TARGET
// (which entry of that store). Each kind maps to the one existing route that
// stores that secret, so the card posts the secret straight there with the
// person's own session, exactly as the settings page would:
//
//   byok                       POST  /api/settings/ai/keys
//   connection_credentials     POST  /api/connections/:app/:conn/credentials (mode org)
//   oauth_client               PUT   /api/connections/:app/:conn/oauth-client
//   google_integration_client  PATCH /api/settings/integrations/google
//   (legacy) api_connector_credentials: read as connection_credentials of the
//                              org's API connection (connections/api/declarations.ts)
//   api_key                    tickets:apiKeys.create, run by the person
//   oauth_connect              no secret typed: the card starts the provider's
//                              consent (POST /api/secret-requests/:id/authorize)
//                              and the callback stores the account
//
// Nothing here ever carries a secret. A target names a provider, an app and a
// connection, an adapter identifier, or a key's label; the tool's parameters
// are these fields and nothing else.

import { z } from "zod"
import { connectionConfigRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { connectionAdminScope } from "~/modules/apps/connections/admin-scope"
import { apiConnectionsOf, apiConnFor } from "~/modules/apps/connections/api/declarations"
import { MULTI_INSTANCE_IDENTIFIER_RE } from "~/modules/apps/connections/service"
import { hasScope } from "~/modules/permissions/permissions"
import { BYOK_PROVIDER_NAMES, BYOK_PROVIDERS, type ByokProvider } from "~/modules/settings/byok"

export const SECRET_REQUEST_KIND_VALUES = [
  "byok",
  "connection_credentials",
  "oauth_client",
  "google_integration_client",
  "oauth_connect",
  /**
   * Legacy name of `connection_credentials` for an API connection (a request
   * filed before it was generic, or a call that still uses it): parsed into a
   * `connection_credentials` target of the org's API connection, never kept.
   */
  "api_connector_credentials",
  "api_key",
] as const

export type SecretTarget =
  | { kind: "byok"; provider: ByokProvider }
  | {
      kind: "connection_credentials"
      app: string
      connection: string
      identifier?: string
      /** Set only for the person's own account (a personal IMAP mailbox); absent: the organization's. */
      mode?: "personal"
    }
  | { kind: "oauth_client"; app: string; connection: string }
  | { kind: "google_integration_client" }
  | {
      kind: "oauth_connect"
      app: string
      connection: string
      mode: ConnectMode
      /** The address being connected, when known (Google Drive: decides its mode). */
      identifier?: string
    }
  | { kind: "api_key"; label: string; allowedOrigins?: string[] }

export type SecretKind = SecretTarget["kind"]
type RequestKind = (typeof SECRET_REQUEST_KIND_VALUES)[number]

/** Whose account an `oauth_connect` card connects: the person's own, or the organization's. */
export const CONNECT_MODES = ["personal", "org"] as const
export type ConnectMode = (typeof CONNECT_MODES)[number]

/** The tool that mints an API key for the person, from the card (never for the agent). */
export const API_KEY_MINT_TOOL = { app: "tickets", name: "apiKeys.create" } as const
/** The scope the mint tool requires: the card's submitter must hold it. */
export const API_KEY_ADMIN_SCOPE = "tickets:settings:admin"

const name = z
  .string()
  .trim()
  .min(1)
  .max(80)
  .regex(/^[a-z0-9][a-z0-9._-]*$/i, "letters, digits, dot, dash or underscore")

/**
 * The tool's parameters. Flat on purpose: a provider schema of one object, with
 * the per-kind rules checked by `parseSecretTarget` (a root union is refused by
 * some model providers). No field is named like a secret, and none takes one.
 */
/**
 * A browser origin exactly as a browser sends it: `http(s)://host[:port]`, no
 * path, query, fragment or credentials. Anything else (a sentence, a URL with
 * a path) is not an origin and is refused before the card is filed.
 */
export function isWebOrigin(value: string): boolean {
  let url: URL
  try {
    url = new URL(value)
  } catch {
    return false
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return false
  return url.origin === value
}

export const requestSecretParams = z
  .object({
    kind: z
      .enum(SECRET_REQUEST_KIND_VALUES)
      .describe(
        "byok: a model provider key. connection_credentials: an app connection's login (an API connection's too: its app, connection and the adapter's identifier). oauth_client: an app connection's OAuth client. google_integration_client: the Google OAuth client Gmail and Google Calendar connect with. oauth_connect: the person signs in at the provider (Google, Shopify) to connect an OAuth connection. api_connector_credentials: the old name of connection_credentials for an API connection (identifier only). api_key: a new Liaison API key the person creates and copies.",
      ),
    target: z
      .object({
        provider: z.enum(BYOK_PROVIDERS).optional().describe("byok: the model provider."),
        app: name
          .optional()
          .describe("connection_credentials, oauth_client, oauth_connect: the app."),
        connection: name
          .optional()
          .describe(
            "connection_credentials, oauth_client, oauth_connect: the connection of that app.",
          ),
        mode: z
          .enum(CONNECT_MODES)
          .optional()
          .describe(
            "oauth_connect: personal (the person's own account, e.g. their own Gmail) or org (an account the organization shares). connection_credentials: personal for the person's own mailbox or account (their own Gmail over IMAP); omit it (or org) for an account the organization shares.",
          ),
        identifier: z
          .string()
          .trim()
          .min(1)
          .max(254)
          // An address, a slug or an adapter id: never free text, since the card
          // shows it to the conversation (scope taint stamps the row too).
          .regex(
            /^[A-Za-z0-9._%+@-]+$/,
            "an address, a slug or an identifier: letters, digits and . _ % + @ - only",
          )
          .optional()
          .describe(
            "connection_credentials: which account (a mailbox address, the slug of a multi-account connection, or an API connection's adapter identifier), as a config tool's pending item names it. oauth_connect: the address being connected, when known (Google Drive: the email you passed kernel__google_setup).",
          ),
        label: z
          .string()
          .trim()
          .min(1)
          .max(60)
          // A name, not a sentence: letters, digits, spaces and a little
          // punctuation. It is shown in the key list and in the saved line.
          .regex(/^[\p{L}\p{N} ._,'&()-]+$/u, "letters, digits, spaces and . _ , ' & ( ) - only")
          .optional()
          .describe("api_key: what the key is for, shown in the key list (at most 60 characters)."),
        allowedOrigins: z
          .array(
            z
              .string()
              .trim()
              .min(1)
              .max(300)
              .refine(
                isWebOrigin,
                "an origin: http(s)://host[:port], with no path, query or credentials",
              ),
          )
          .max(20)
          .optional()
          .describe("api_key: the browser origins allowed to use the key."),
      })
      .strict()
      .default({}),
  })
  .strict()

export type RequestSecretParams = z.infer<typeof requestSecretParams>

/** Which target fields each kind takes, and which of them it requires. */
const KIND_FIELDS: Record<RequestKind, { required: string[]; optional: string[] }> = {
  byok: { required: ["provider"], optional: [] },
  connection_credentials: { required: ["app", "connection"], optional: ["identifier", "mode"] },
  oauth_client: { required: ["app", "connection"], optional: [] },
  google_integration_client: { required: [], optional: [] },
  oauth_connect: { required: ["app", "connection", "mode"], optional: ["identifier"] },
  api_connector_credentials: { required: ["identifier"], optional: [] },
  api_key: { required: ["label"], optional: ["allowedOrigins"] },
}

export type ParsedTarget = { ok: true; target: SecretTarget } | { ok: false; error: string }

/**
 * The credential field that names the account of a single-account connection
 * (the credentials route keys the account on `email`, else `identifier`), or
 * null when its fields name none.
 */
export function accountField(config: {
  credentialFields?: Array<{ name: string }>
}): "email" | "identifier" | null {
  const names = new Set((config.credentialFields ?? []).map((f) => f.name))
  if (names.has("email")) return "email"
  if (names.has("identifier")) return "identifier"
  return null
}

/** A config tool's pending item, as the provisioners report it (cli/provisioners/types.ts). */
export interface PendingSecretItem {
  kind: string
  app: string
  connection?: string
  identifier?: string
  action?: string
}

/**
 * The connections whose OAuth client is the org's Google integration client
 * (modules/settings/google-integration.ts): Gmail for mail and tickets, Google
 * Calendar. Google Drive is not one: it takes its own client (env, or its
 * connection's client row), asked with kind oauth_client.
 */
export const GOOGLE_CLIENT_CONNECTIONS: ReadonlySet<string> = new Set([
  "mail:gmail",
  "tickets:gmail",
  "calendar:google-calendar",
])

/** The provisioners' name for "the Google client of this mailbox" (mail-mailboxes.ts). */
const GOOGLE_CLIENT_PENDING_CONNECTION = "google-client"

export function usesGoogleIntegrationClient(app: string, connection: string): boolean {
  return GOOGLE_CLIENT_CONNECTIONS.has(`${app}:${connection}`)
}

/**
 * The `request_secret` call that fills a config tool's pending credentials, or
 * null when the item is not a secret (an OAuth consent, a knowledge source) or
 * names nothing the card can ask for.
 */
export function secretRequestForPending(
  orgId: string,
  item: PendingSecretItem,
): RequestSecretParams | null {
  if (item.kind !== "credentials" || !item.connection) return null
  if (apiConnFor(orgId, item.app)?.connection === item.connection) {
    return item.identifier
      ? {
          kind: "connection_credentials",
          target: { app: item.app, connection: item.connection, identifier: item.identifier },
        }
      : null
  }
  if (
    item.connection === GOOGLE_CLIENT_PENDING_CONNECTION ||
    usesGoogleIntegrationClient(item.app, item.connection)
  ) {
    return { kind: "google_integration_client", target: {} }
  }
  const config = connectionConfigRegistry.get([orgId, item.app, item.connection])
  if (!config) return null
  if (config.type === "oauth2") {
    return { kind: "oauth_client", target: { app: item.app, connection: item.connection } }
  }
  const keepIdentifier = item.identifier && (config.multiInstance || accountField(config))
  return {
    kind: "connection_credentials",
    target: {
      app: item.app,
      connection: item.connection,
      ...(keepIdentifier ? { identifier: item.identifier } : {}),
    },
  }
}

/** The client step that comes before a consent card, in words, for a refusal. */
function oauthClientStep(app: string, connection: string): string {
  return usesGoogleIntegrationClient(app, connection)
    ? " (when the organization has no Google client yet, ask for it first with kind google_integration_client)"
    : " (when the connection has no OAuth client yet, ask for it first with kind oauth_client)"
}

/**
 * The org's API connection a legacy `api_connector_credentials` request is
 * for: the only app of the org that declares one. Null when there is none, or
 * several (the request must then name its app with connection_credentials).
 */
function legacyApiConnection(
  orgId: string | undefined,
): { app: string; connection: string } | null {
  if (!orgId) return null
  const all = apiConnectionsOf(orgId)
  const only = all.length === 1 ? all[0] : undefined
  return only ? { app: only.app, connection: only.connection } : null
}

/**
 * The tool's params as one kind's target, or what is wrong with them, in words.
 * `orgId` resolves the legacy API kind to the org's API connection.
 */
export function parseSecretTarget(params: RequestSecretParams, orgId?: string): ParsedTarget {
  const t = params.target
  const fields = KIND_FIELDS[params.kind]
  const given = Object.entries(t)
    .filter(([, v]) => v !== undefined)
    .map(([k]) => k)
  const extra = given.filter((k) => !fields.required.includes(k) && !fields.optional.includes(k))
  if (extra.length > 0) {
    return { ok: false, error: `A ${params.kind} request takes no ${extra.join(", ")}.` }
  }
  const missing = fields.required.filter((k) => !given.includes(k))
  if (missing.length > 0) {
    return { ok: false, error: `A ${params.kind} request needs ${missing.join(", ")}.` }
  }
  switch (params.kind) {
    case "byok":
      return { ok: true, target: { kind: "byok", provider: t.provider as ByokProvider } }
    case "connection_credentials":
      return {
        ok: true,
        target: {
          kind: "connection_credentials",
          app: t.app as string,
          connection: t.connection as string,
          ...(t.identifier ? { identifier: t.identifier } : {}),
          ...(t.mode === "personal" ? { mode: "personal" as const } : {}),
        },
      }
    case "oauth_client":
      return {
        ok: true,
        target: { kind: "oauth_client", app: t.app as string, connection: t.connection as string },
      }
    case "google_integration_client":
      return { ok: true, target: { kind: "google_integration_client" } }
    case "oauth_connect":
      return {
        ok: true,
        target: {
          kind: "oauth_connect",
          app: t.app as string,
          connection: t.connection as string,
          mode: t.mode as ConnectMode,
          ...(t.identifier ? { identifier: t.identifier } : {}),
        },
      }
    case "api_connector_credentials": {
      const api = legacyApiConnection(orgId)
      if (!api) {
        return {
          ok: false,
          error:
            "Ask with kind connection_credentials and the API connection's app, connection and identifier.",
        }
      }
      return {
        ok: true,
        target: { kind: "connection_credentials", ...api, identifier: t.identifier as string },
      }
    }
    case "api_key":
      return {
        ok: true,
        target: {
          kind: "api_key",
          label: t.label as string,
          ...(t.allowedOrigins && t.allowedOrigins.length > 0
            ? { allowedOrigins: t.allowedOrigins }
            : {}),
        },
      }
  }
}

/** The stored target (the row's `target` column): the target without its kind. */
export function targetFields(target: SecretTarget): Record<string, unknown> {
  const { kind: _kind, ...rest } = target
  return rest
}

/** The row back as a target. Null for a row whose stored target no longer parses. */
export function targetFromRow(kind: string, stored: unknown, orgId: string): SecretTarget | null {
  const parsed = requestSecretParams.safeParse({ kind, target: stored ?? {} })
  if (!parsed.success) return null
  const target = parseSecretTarget(parsed.data, orgId)
  return target.ok ? target.target : null
}

/** One canonical string per target. */
export function targetKey(target: SecretTarget): string {
  const fields = targetFields(target)
  const sorted = Object.keys(fields)
    .sort()
    .map((k) => [k, fields[k]])
  return JSON.stringify(sorted)
}

/**
 * The key a pending request is deduplicated on (the row's `target_key`): the
 * target, and for a personal connect also the person it is for. Two people in
 * one conversation each asking to connect their own Gmail get a card each,
 * never the other's (which they could not submit).
 */
export function requestKey(target: SecretTarget, requestedBy: string): string {
  const key = targetKey(target)
  return isPersonalTarget(target) ? `${key}|for:${requestedBy}` : key
}

/** A card for the person's own account: a personal connect, or a personal login (their own IMAP mailbox). */
export function isPersonalTarget(target: SecretTarget): boolean {
  return (
    (target.kind === "oauth_connect" || target.kind === "connection_credentials") &&
    target.mode === "personal"
  )
}

/**
 * The scope a person needs to submit the card: the scope the target route
 * itself checks. Anyone else sees the card read-only. A personal connect is
 * submitted by the person it was asked for and nobody else (`canSubmitRequest`).
 */
export function targetScope(orgId: string, target: SecretTarget): string {
  switch (target.kind) {
    case "byok":
    case "google_integration_client":
      return "kernel:org:admin"
    case "oauth_client":
      return "kernel:apps:admin"
    case "oauth_connect":
      return target.mode === "org"
        ? connectionAdminScope(orgId, target.app, target.connection)
        : "kernel:threads:read"
    case "connection_credentials":
      return target.mode === "personal"
        ? "kernel:threads:read"
        : connectionAdminScope(orgId, target.app, target.connection)
    case "api_key":
      return API_KEY_ADMIN_SCOPE
  }
}

export function canSubmitTarget(orgId: string, target: SecretTarget, scopes: string[]): boolean {
  return hasScope(targetScope(orgId, target), scopes)
}

/**
 * Whether this person may submit this request: the intended submitter. A
 * personal connect connects the account of the person it was asked for, so
 * only they may complete it; every other kind takes the target route's scope.
 */
export function canSubmitRequest(
  orgId: string,
  target: SecretTarget,
  scopes: string[],
  userId: string,
  requestedBy: string,
): boolean {
  if (isPersonalTarget(target) && userId !== requestedBy) {
    return false
  }
  return canSubmitTarget(orgId, target, scopes)
}

/**
 * The target in words, for the agent's line and the card's title. `fence`
 * wraps the parts the AGENT chose (an account identifier, a key label): the
 * saved line is replayed to the agent as a trusted platform fact, so anything
 * it typed itself goes in fenced as untrusted text (lib/external-content.ts).
 * App and connection names are checked against the registry, the provider
 * against a fixed list: they need no fence.
 */
export function describeTarget(
  target: SecretTarget,
  fence: (text: string) => string = (t) => t,
): string {
  switch (target.kind) {
    case "byok":
      return `${BYOK_PROVIDER_NAMES[target.provider]} API key`
    case "connection_credentials":
      return `${target.app} ${target.connection} credentials${target.identifier ? ` (${fence(target.identifier)})` : ""}${target.mode === "personal" ? " (personal)" : ""}`
    case "oauth_client":
      return `${target.app} ${target.connection} OAuth client`
    case "google_integration_client":
      return "Google integration client"
    case "oauth_connect":
      return `${target.app} ${target.connection} connection (${target.mode === "org" ? "shared with the organization" : "personal"})`
    case "api_key":
      return `API key ${fence(target.label)}`
  }
}

/**
 * The org's connections that take this kind of secret, as the target to pass
 * (`app "mail", connection "imap", identifier: the account`): what a refusal
 * names so the next call picks a real one instead of guessing.
 */
export function declaredConnections(
  orgId: string,
  kind: "connection_credentials" | "oauth_client" | "oauth_connect",
  canSeeApp: (app: string) => boolean,
): string[] {
  const wanted = kind === "connection_credentials" ? "credentials" : "oauth2"
  const out: string[] = []
  for (const [[org, app, connection], config] of connectionConfigRegistry.entriesOf(orgId)) {
    if (org !== orgId || config.type !== wanted) continue
    // An API connection's accounts are named by its adapters (the caller lists them).
    if (apiConnFor(orgId, app)?.connection === connection) continue
    if (!canSeeApp(app)) continue
    // A Google connection's client is the integration client, never its own.
    if (kind === "oauth_client" && usesGoogleIntegrationClient(app, connection)) continue
    let identifier = ""
    if (kind === "connection_credentials") {
      const field = accountField(config)
      if (config.multiInstance) identifier = ", identifier: a slug naming the account"
      else if (field) identifier = `, identifier: the account's ${field}`
    }
    out.push(`app "${app}", connection "${connection}"${identifier}`)
  }
  return out.sort()
}

/**
 * Whether the target exists and takes this kind of secret, checked against
 * the org's live registries. An error names the problem in words the agent can
 * act on. Adapter existence (an API connection's identifier) is checked by
 * the caller, which owns that read.
 */
export function checkTargetRegistered(
  orgId: string,
  target: SecretTarget,
  /** Which apps the asking actor may use: only their connections are named in a refusal. */
  canSeeApp: (app: string) => boolean = () => false,
): string | null {
  switch (target.kind) {
    case "byok":
    case "google_integration_client":
      return null
    case "connection_credentials":
    case "oauth_client":
    case "oauth_connect": {
      const api = apiConnFor(orgId, target.app)
      if (api && api.connection === target.connection) {
        if (target.kind !== "connection_credentials") {
          return `The "${target.connection}" connection of "${target.app}" is an API connection: ask for its credentials with kind connection_credentials and the adapter's identifier.`
        }
        return target.identifier
          ? null
          : `The "${target.connection}" connection of "${target.app}" is an API connection: pass identifier, the adapter's slug.`
      }
      const config = connectionConfigRegistry.get([orgId, target.app, target.connection])
      if (!config) {
        const known = declaredConnections(orgId, target.kind, canSeeApp)
        return (
          `The app "${target.app}" declares no connection "${target.connection}" (is the app installed?).` +
          (known.length > 0
            ? ` The connections that take ${target.kind} here: ${known.join("; ")}.`
            : "")
        )
      }
      const wanted = target.kind === "connection_credentials" ? "credentials" : "oauth2"
      if (config.type !== wanted) {
        return target.kind === "connection_credentials"
          ? `The "${target.connection}" connection of "${target.app}" is an OAuth connection: the person connects it on a card, kind oauth_connect with this app and connection${oauthClientStep(target.app, target.connection)}.`
          : `The "${target.connection}" connection of "${target.app}" signs in with credentials, not OAuth: ask with kind connection_credentials.`
      }
      if (
        target.kind === "oauth_client" &&
        usesGoogleIntegrationClient(target.app, target.connection)
      ) {
        return `The "${target.connection}" connection of "${target.app}" connects with the organization's Google client: ask for it with kind google_integration_client.`
      }
      if (target.kind === "connection_credentials") {
        if (config.multiInstance && !target.identifier) {
          return `The "${target.connection}" connection of "${target.app}" holds several accounts: pass identifier, a lowercase slug naming this one.`
        }
        if (target.identifier && !config.multiInstance && !accountField(config)) {
          return `The "${target.connection}" connection of "${target.app}" holds one account: pass no identifier.`
        }
        if (
          target.identifier &&
          config.multiInstance &&
          !MULTI_INSTANCE_IDENTIFIER_RE.test(target.identifier)
        ) {
          return "identifier is a lowercase slug (letters, digits, -) of at most 40 characters."
        }
      }
      return null
    }
    case "api_key":
      return toolRegistry.get([orgId, API_KEY_MINT_TOOL.app, API_KEY_MINT_TOOL.name])
        ? null
        : "API keys are created in the tickets app, which is not installed."
  }
}
