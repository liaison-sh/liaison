// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The secret card's routes, mounted at /api/secret-requests:
//
//   GET  /:id           the card: what is asked, for which target, by whom, the
//                       form's fields and read-only destination, and whether the
//                       caller may submit or cancel it. Never a secret.
//   POST /:id/complete  no body: the server checks the store (service.ts).
//   POST /:id/cancel    the requester, or a holder of the target's scope.
//   POST /:id/authorize an `oauth_connect` card's Connect: starts the
//                       provider's consent for the request's own connection
//                       and owner, and answers the provider's URL. The grant
//                       settles the card (connect-settle.ts); the code and
//                       the tokens never pass through the card.
//
// The secret itself never comes here: the card posts it to the target's own
// route (targets.ts). Every route reads the row under the caller's RLS first,
// so a person outside the conversation gets a 404, as for a row that does not
// exist.

import { AUTH_CREDENTIAL_FIELDS } from "@liaison/api-connector-core"
import type { Context } from "hono"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { getAdapterRow } from "~/modules/apps/connections/api/store"
import type { SecretRequest } from "~/db/schema/kernel"
import { rootLogger } from "~/lib/logger"
import { connectBindingEnabled, setConnectBindingCookie } from "~/lib/oauth-browser-binding"
import { extractRlsContext, withRequestRls } from "~/lib/request-rls"
import { isAppOriginRequest, success } from "~/lib/response"
import { zValidator } from "~/lib/validate"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { ConnectionTurnedOffError } from "~/modules/apps/connections/oauth-client-config"
import {
  CONNECT_BINDING_COOKIE,
  CONNECT_CALLBACK_PATH,
  OAuthStartRefusedError,
  startOAuthFlow,
} from "~/modules/apps/connections/service"
import { parseConnectClient } from "~/modules/apps/connections/shell-connect"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { announceSecretRequestResult } from "~/modules/secret-requests/announce"
import {
  approvedImapSettings,
  knownImapSettings,
} from "~/modules/secret-requests/approved-settings"
import { clientCardGuide, type SecretRequestGuide } from "~/modules/secret-requests/guides"
import {
  cancelSecretRequest,
  completeSecretRequest,
  effectiveStatus,
  getSecretRequest,
  requestPeople,
} from "~/modules/secret-requests/service"
import {
  accountField,
  canSubmitRequest,
  describeTarget,
  type SecretTarget,
  targetFields,
  targetFromRow,
} from "~/modules/secret-requests/targets"

/** One field of the card's form. `secret` fields are password inputs, cleared after a save. */
export interface SecretFormField {
  name: string
  /** The manifest's label, when the app declares one; the card localizes the rest by name. */
  label?: string
  secret: boolean
  required: boolean
}

/** Where the secret goes, shown read-only and named, so nobody types it for the wrong place. */
export interface SecretDestination {
  name: string
  value: string
}

/** Which provider a connect card signs in with: its button says "Connect with <provider>". */
export type ConnectProvider = "google" | "shopify" | "microsoft" | "meta" | null

export interface SecretRequestView {
  id: string
  kind: SecretTarget["kind"]
  target: Record<string, unknown>
  title: string
  status: SecretRequest["status"]
  hint: string | null
  requestedBy: string
  agentId: string | null
  threadId: string
  createdAt: string
  expiresAt: string
  completedAt: string | null
  canSubmit: boolean
  canCancel: boolean
  fields: SecretFormField[]
  destination: SecretDestination[]
  /** Credential values the card sends as they are, never asks for: the account the request names. */
  fixed: Record<string, string>
  /** Who asked: the agent's name, and the person it asked for. */
  agentName: string | null
  requesterName: string | null
  /** An `oauth_connect` card: the provider its Connect button signs in with. */
  connect: { provider: ConnectProvider } | null
  /** A client card's setup steps (guides.ts), or null when there are none to show. */
  guide: SecretRequestGuide | null
}

const log = rootLogger.child({ module: "secret-request-routes" })

const idParam = z.object({ id: z.string().uuid() })

/** The provider an authorize URL belongs to, by its host, for the button's words. */
export function connectProviderOf(authorizationUrl: string | undefined): ConnectProvider {
  if (!authorizationUrl) return null
  let host: string
  try {
    // A per-store template (`https://{shop}/admin/...`) is not a URL until filled.
    host = new URL(authorizationUrl.replace(/\{[a-z]+\}/gi, "store.example")).hostname
  } catch {
    return null
  }
  if (host === "accounts.google.com" || host.endsWith(".google.com")) return "google"
  if (host === "store.example" || host.endsWith(".myshopify.com") || host.endsWith("shopify.com"))
    return "shopify"
  if (host.endsWith("microsoftonline.com") || host.endsWith("live.com")) return "microsoft"
  if (host.endsWith("facebook.com") || host.endsWith("instagram.com")) return "meta"
  return null
}

/** The template variables a connection's consent asks the person for (Shopify's `shop`). */
function connectFields(authorizationUrl: string | undefined): SecretFormField[] {
  const names = new Set<string>()
  for (const match of (authorizationUrl ?? "").matchAll(/\{([a-z]+)\}/gi)) names.add(match[1])
  return [...names].map((name) => ({ name, secret: false, required: true }))
}

/** Secret-bearing auth fields of an API connector adapter; the rest are typed in plain. */
const API_CONNECTOR_PLAIN_FIELDS = new Set(["username", "clientId"])

async function formFor(
  orgId: string,
  target: SecretTarget,
  /** The viewer may submit: only then are approved settings read and shown. */
  mayAdmin: boolean,
): Promise<{
  fields: SecretFormField[]
  destination: SecretDestination[]
  fixed?: Record<string, string>
  connect?: { provider: ConnectProvider }
}> {
  switch (target.kind) {
    case "byok":
      return {
        fields: [{ name: "apiKey", secret: true, required: true }],
        destination: [{ name: "provider", value: target.provider }],
      }
    case "oauth_client":
    case "google_integration_client":
      return {
        fields: [
          { name: "clientId", secret: false, required: true },
          { name: "clientSecret", secret: true, required: true },
        ],
        destination:
          target.kind === "oauth_client"
            ? [
                { name: "app", value: target.app },
                { name: "connection", value: target.connection },
              ]
            : [],
      }
    case "connection_credentials": {
      await ensureAppsForOrg(orgId)
      const config = connectionConfigRegistry.get([orgId, target.app, target.connection])
      // The account the request names is sent as it is: a multi-account
      // connection's slug, or the field a single-account one keys on.
      const fixedField = target.identifier
        ? config?.multiInstance
          ? "identifier"
          : config
            ? accountField(config)
            : null
        : null
      const fields = (config?.credentialFields ?? [])
        .filter((f) => f.name !== fixedField)
        .map((f) => ({
          name: f.name,
          label: f.label,
          secret: f.type === "password",
          required: f.required !== false,
        }))
      // The hosts, ports and username a person already approved in a config
      // call are shown read-only and sent as they are: the card asks only for
      // what is secret (approved-settings.ts).
      const plainFields = fields.filter((f) => !f.secret).map((f) => f.name)
      const fromConfig =
        mayAdmin && target.identifier
          ? await approvedImapSettings(orgId, target.app, target.identifier, plainFields)
          : {}
      // A personal Gmail address needs no settings: Google's servers are known.
      const approved =
        Object.keys(fromConfig).length > 0 || !target.identifier
          ? fromConfig
          : knownImapSettings(target.identifier, plainFields)
      const fixed = {
        ...(fixedField && target.identifier ? { [fixedField]: target.identifier } : {}),
        ...approved,
      }
      return {
        fields: fields.filter((f) => !(f.name in approved)),
        destination: [
          { name: "app", value: target.app },
          { name: "connection", value: target.connection },
          ...(target.identifier ? [{ name: "identifier", value: target.identifier }] : []),
          ...Object.entries(approved).map(([name, value]) => ({ name, value })),
        ],
        ...(Object.keys(fixed).length > 0 ? { fixed } : {}),
      }
    }
    case "api_connector_credentials": {
      const row = await getAdapterRow(orgId, target.identifier)
      if (!row)
        return { fields: [], destination: [{ name: "identifier", value: target.identifier }] }
      const auth = row.adapter.auth
      // The stored adapter was validated on save; an unparsable URL still
      // shows the card, naming the destination as stored, never a 500.
      let origin = row.adapter.baseUrl
      try {
        origin = new URL(row.adapter.baseUrl).origin
      } catch {
        // keep the raw value
      }
      return {
        fields: AUTH_CREDENTIAL_FIELDS[auth.type].map((name) => ({
          name,
          secret: !API_CONNECTOR_PLAIN_FIELDS.has(name),
          required: true,
        })),
        destination: [
          { name: "identifier", value: target.identifier },
          { name: "baseUrl", value: origin },
          { name: "authType", value: auth.type },
        ],
        fixed: { identifier: target.identifier },
      }
    }
    case "oauth_connect": {
      await ensureAppsForOrg(orgId)
      const config = connectionConfigRegistry.get([orgId, target.app, target.connection])
      return {
        fields: connectFields(config?.authorizationUrl),
        destination: [
          { name: "app", value: target.app },
          { name: "connection", value: target.connection },
          { name: "mode", value: target.mode },
        ],
        connect: { provider: connectProviderOf(config?.authorizationUrl) },
      }
    }
    case "api_key":
      return {
        fields: [],
        destination: [
          { name: "label", value: target.label },
          ...(target.allowedOrigins?.length
            ? [{ name: "allowedOrigins", value: target.allowedOrigins.join(", ") }]
            : []),
        ],
      }
  }
}

async function viewOf(c: Context<AppEnv>, row: SecretRequest): Promise<SecretRequestView> {
  const orgId = c.get("orgId")
  const userId = c.get("userId")
  const scopes = (c.get("scopes") as string[] | undefined) ?? []
  const target = targetFromRow(row.kind, row.target)
  if (!target)
    throw new HTTPException(409, { message: "This request's target is no longer valid." })
  const status = effectiveStatus(row)
  const mayAdmin = canSubmitRequest(orgId, target, scopes, userId, row.requestedBy)
  const [form, people, guide] = await Promise.all([
    formFor(orgId, target, mayAdmin && status === "pending"),
    requestPeople(orgId, row),
    status === "pending" ? clientCardGuide(orgId, target) : Promise.resolve(null),
  ])
  return {
    id: row.id,
    kind: target.kind,
    target: targetFields(target),
    title: describeTarget(target),
    status,
    hint: row.hint,
    requestedBy: row.requestedBy,
    agentId: row.agentId,
    threadId: row.threadId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    canSubmit: status === "pending" && mayAdmin,
    canCancel: status === "pending" && (mayAdmin || row.requestedBy === userId),
    fields: form.fields,
    destination: form.destination,
    fixed: form.fixed ?? {},
    agentName: people.agentName,
    requesterName: people.requesterName,
    connect: form.connect ?? null,
    guide,
  }
}

/** The sentences a refused start shows, by code (the card words them in the person's language). */
const START_REFUSALS: Record<OAuthStartRefusedError["code"], string> = {
  missing_value: "Type the store's domain, like your-store.myshopify.com.",
  invalid_value: "That is not a store domain: type it like your-store.myshopify.com.",
  no_client: "This connection has no OAuth client yet: it is entered on a client card first.",
  missing_setting:
    "This connection needs an app setting first (the setup guide names it): an admin sets it in the app's settings, or asks the agent to.",
}

const CONNECT_TURNED_OFF =
  "This connection is switched off for the organization. An admin turns it on in the app's settings (Gmail: Settings > Mail), or asks the agent to."

const authorizeBody = z
  .object({
    /** Shopify: the store's domain, typed on the card. */
    shop: z.string().trim().min(1).max(255).optional(),
    /** How the card opened the consent: its popup, or this tab when the popup was blocked. */
    display: z.enum(["popup", "tab"]).default("popup"),
    // A desktop or mobile shell's own binding (shell-connect.ts), checked there.
    client: z.string().optional(),
    code_challenge: z.string().optional(),
    code_challenge_method: z.string().optional(),
    state: z.string().optional(),
  })
  .strict()

async function visibleRow(c: Context<AppEnv>, id: string): Promise<SecretRequest> {
  const row = await withRequestRls(c, (tx) => getSecretRequest(tx, id))
  if (!row) throw new HTTPException(404, { message: "Secret request not found" })
  return row
}

export const secretRequestRoutes = new Hono<AppEnv>()
  .get("/:id", zValidator("param", idParam), async (c) => {
    const row = await visibleRow(c, c.req.valid("param").id)
    return success(c, await viewOf(c, row))
  })
  .post("/:id/complete", zValidator("param", idParam), async (c) => {
    const row = await visibleRow(c, c.req.valid("param").id)
    // Already saved by this person: the save itself settled it (a key route
    // settles every pending request for its target), and the card's own
    // completion call that follows reads "saved", not a conflict.
    if (row.status === "saved" && row.completedBy === c.get("userId")) {
      return success(c, await viewOf(c, row))
    }
    const saved = await completeSecretRequest({
      orgId: c.get("orgId"),
      id: row.id,
      userId: c.get("userId"),
      scopes: (c.get("scopes") as string[] | undefined) ?? [],
    })
    // After the commit, never inside it: the conversation hears the save and
    // the agent that asked takes its turn (announce.ts).
    await announceSecretRequestResult(extractRlsContext(c), saved)
    return success(c, await viewOf(c, saved))
  })
  .post(
    "/:id/authorize",
    zValidator("param", idParam),
    zValidator("json", authorizeBody),
    async (c) => {
      const row = await visibleRow(c, c.req.valid("param").id)
      const body = c.req.valid("json")
      const orgId = c.get("orgId")
      const userId = c.get("userId")
      const target = targetFromRow(row.kind, row.target)
      if (target?.kind !== "oauth_connect") {
        throw new HTTPException(400, { message: "This request is not a connect card." })
      }
      const status = effectiveStatus(row)
      if (status !== "pending") {
        throw new HTTPException(409, {
          message: status === "saved" ? "Already connected." : `This request is ${status}.`,
        })
      }
      const scopes = (c.get("scopes") as string[] | undefined) ?? []
      if (!canSubmitRequest(orgId, target, scopes, userId, row.requestedBy)) {
        throw new HTTPException(403, { message: "You cannot connect this account." })
      }
      await ensureAppsForOrg(orgId)
      const client = parseConnectClient(body, isAppOriginRequest(c))
      if (client.kind === "invalid") throw new HTTPException(400, { message: client.message })
      const shellFlow = client.kind === "shell" ? client.flow : undefined
      const bind = connectBindingEnabled() && !shellFlow
      let redirectUrl: string
      try {
        redirectUrl = await startOAuthFlow(orgId, userId, target.app, target.connection, {
          ownerType: target.mode === "org" ? "org" : "user",
          ...(body.shop ? { shop: body.shop } : {}),
          browserBound: bind,
          shellFlow,
          card: { requestId: row.id, threadId: row.threadId, display: body.display },
          ...(target.identifier ? { accountHint: target.identifier } : {}),
          onState: (state) => {
            if (bind) {
              setConnectBindingCookie(c, CONNECT_BINDING_COOKIE, CONNECT_CALLBACK_PATH, state)
            }
          },
        })
      } catch (err) {
        // A connection the workspace switched off (Gmail mailboxes off): the
        // card says who turns it on and where, by its code.
        if (err instanceof ConnectionTurnedOffError) {
          return c.json({ error: { message: CONNECT_TURNED_OFF, code: "connect_turned_off" } }, 400)
        }
        // Our own refusals worded for a person (an app turned off) pass through.
        if (err instanceof HTTPException) throw err
        // What the person can act on gets a fixed sentence and a code the
        // card words in their language; anything else stays in the log.
        if (err instanceof OAuthStartRefusedError) {
          return c.json(
            { error: { message: START_REFUSALS[err.code], code: `connect_${err.code}` } },
            400,
          )
        }
        log.error(
          { err, orgId, secretRequestId: row.id, app: target.app, connection: target.connection },
          "a connect card's consent could not start",
        )
        return c.json(
          {
            error: {
              message: "The connection could not start. Try again, or ask an admin.",
              code: "connect_failed",
            },
          },
          400,
        )
      }
      return success(c, { redirectUrl })
    },
  )
  .post("/:id/cancel", zValidator("param", idParam), async (c) => {
    const row = await visibleRow(c, c.req.valid("param").id)
    const cancelled = await cancelSecretRequest({
      orgId: c.get("orgId"),
      id: row.id,
      userId: c.get("userId"),
      scopes: (c.get("scopes") as string[] | undefined) ?? [],
    })
    await announceSecretRequestResult(extractRlsContext(c), cancelled)
    return success(c, await viewOf(c, cancelled))
  })
