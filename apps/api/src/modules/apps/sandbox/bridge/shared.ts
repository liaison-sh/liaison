// SPDX-License-Identifier: FSL-1.1-ALv2

import type { ActorContext } from "~/db/rls"
import { UnsafeOutboundUrlError, validateOutboundUrlNoDns } from "~/lib/outbound-fetch"

/** The id a create_routine running-doc binding directive names in the authored prompt ("MAINTAIN THIS
 *  EXISTING RUNNING DOC … id <UUID>"). Extracted to redirect a routine-tick knowledge_create onto the
 *  bound doc regardless of the (invented) title. The UUID is the FIRST such id in the prompt. */
export const ROUTINE_BOUND_DOC_ID_RE =
  /MAINTAIN THIS EXISTING RUNNING DOC[\s\S]*?\bid\s+([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i

/** Extract the bound running-doc id a create_routine binding directive named in a routine prompt (the
 *  FIRST one), or null. Pure — exported for the regression test that pins the parse the redirect keys on. */
export function extractRoutineBoundDocId(prompt: string | null | undefined): string | null {
  if (!prompt) return null
  return prompt.match(ROUTINE_BOUND_DOC_ID_RE)?.[1] ?? null
}
export const SANDBOX_FETCH_MAX_REDIRECTS = 5

export const ERROR_NOT_FOUND = { code: "not_found", retryable: false }

/**
 * Kernel-managed base columns present on every app entity table (see
 * generateTableDdl `systemCols`: id, org_id, created_at, updated_at). Apps may
 * filter/order by these without redeclaring them in the manifest `fields` block.
 * `orgId` is intentionally excluded — it is kernel-scoped (where.orgId is
 * rejected outright; ordering within a single org is meaningless).
 */
export const BASE_ENTITY_FIELDS = new Set(["id", "createdAt", "updatedAt"])

export function envelopeError(code: string, message: string, retryable = false): string {
  return JSON.stringify({ error: { code, message, retryable } })
}

export function toIso(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString()
  if (typeof value === "string") return value
  return null
}

// jsonb columns can surface EITHER pre-parsed (the default postgres.js path, e.g. host tests) OR as a
// raw JSON STRING (observed for app_mail.messages.from_address/to_addresses in the chaos world DB
// connection). A mapper that only handles the parsed form silently drops the value in the string case
// — which made mail:convertToTicket copy an inbound message with an EMPTY from_email, so the later
// gated tickets:reply preflight failed "ticket has no customer recipient" (sofia-promote, l445). Coerce
// both shapes before reading.
export function coerceJson(value: unknown): unknown {
  if (typeof value !== "string") return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

type SmtpSendStub = (
  connectionName: string,
  identifier: string,
  message: unknown,
) => Promise<{ messageId: string; deliveryState: string }>

/**
 * Transport overrides for the sandbox egress primitives. All null in production.
 *
 * - `fetch`: a fetch-impl the e2e and chaos entrypoints install so external APIs
 *   (Boxtal, Shopify, VIES, Pennylane) answer deterministically.
 * - `smtpSend`: stubs the SMTP send. Real `smtp_send` resolves the connected
 *   account's stored credentials then connects via nodemailer to a real SMTP
 *   host, neither of which works in a chaos world with no real mailbox. When set,
 *   the `smtp_send` bridge primitive routes here instead, so an approved
 *   mail:reply/compose executes deterministically (the agent behaviour, the gated
 *   approval and the send ATTEMPT are all real; only the SMTP TCP is mocked).
 * - `fetchInterceptsHost`: a predicate naming the hosts the installed fetch-impl
 *   actually serves. When set, the sandbox `fetch` primitive calls the override
 *   DIRECTLY for those hosts (bypassing the DNS-pin path that fails on
 *   unreachable third-party sandbox domains) and leaves every other host on the
 *   unchanged production pinned-host path. Unset means "intercept nothing".
 */
export const sandboxEgressOverrides: {
  fetch: typeof fetch | null
  smtpSend: SmtpSendStub | null
  fetchInterceptsHost: ((hostname: string) => boolean) | null
} = { fetch: null, smtpSend: null, fetchInterceptsHost: null }

/**
 * Test access to the sandbox egress overrides, grouped in one object so the
 * production surface carries a single named door. Production code never calls it.
 */
export const SandboxBridgeTestAccess = {
  setFetch(fn: typeof fetch | null): void {
    sandboxEgressOverrides.fetch = fn
  },
  setSmtpSend(fn: SmtpSendStub | null): void {
    sandboxEgressOverrides.smtpSend = fn
  },
  /** Hosts this predicate matches route to the stub fetch above, guards skipped. */
  setFetchInterceptsHost(fn: ((hostname: string) => boolean) | null): void {
    sandboxEgressOverrides.fetchInterceptsHost = fn
  },
}

export interface AppManifestForBridge {
  name: string
  schema?: Record<string, { fields?: Record<string, any> }>
  events?: { emits?: string[] }
  capabilities?: string[]
  /** I9 — declared scopes used to intersect `grants_setUserScopes` args. */
  scopes?: string[]
  /**
   * Trust posture (T10): the bridge methods that hand back kernel-level
   * primitives (currently `agent_spawn`) refuse to execute unless the manifest
   * sets `trusted: true`. Untrusted apps can still call sandboxed methods
   * (`fetch`, `db`, `emit`, …) but cannot manufacture nested agent runs.
   */
  trusted?: boolean
  connections?: Record<
    string,
    {
      allowedDomains?: string[]
      credentialFields?: Array<{ name: string }>
      /**
       * Config keys naming an ENCRYPTED connection secret in `apps.config` — the
       * OAuth client-secret mirror and the kernel-minted webhook secret. The
       * `config_get` bridge derives "which keys to decrypt" from THESE manifest
       * declarations (the stable source always present at the call site), so a
       * gap in the in-memory `connectionConfigRegistry` (process restart, code
       * path that skipped registration) can never cause a stored secret to be
       * handed back as raw ciphertext — which would break webhook HMAC verify.
       */
      clientSecretConfigKey?: string
      webhookSecretConfigKey?: string
      /** Provider-minted secrets the app stores through `config_setSecret`. */
      appSecretConfigKeys?: string[]
    }
  >
  network?: { allowedDomains?: string[]; allowPrivateHostsInTest?: boolean }
  /**
   * Phase 17 B7 — when present, the sandbox `executeTool` bridge translates
   * the in-process `{ data | blocked | error }` envelope into the K4
   * `{ status, result | approval_id | code }` envelope. Apps that pre-date
   * Phase 17 (Mail, Tickets) do not set this, so they observe the legacy
   * shape and their existing handlers continue to work unchanged.
   */
  cross_app_calls?: Array<{ target: string; reason: string }>
}

/** Re-wrap a Drizzle "Failed query: <sql>" error with the postgres cause inlined.
 *  The sandbox worker IPC serializes only `message` (the `.cause` chain is lost
 *  crossing the process boundary), so without this the job/tool log shows the SQL
 *  but not WHY it failed (RLS, timeout, constraint, connection). Same pattern as
 *  db_insert/db_findMany. */
export function withPgCause(err: unknown, label: string): Error {
  const e = err as { message?: string; cause?: { message?: string; code?: string } }
  if (e?.cause?.message) {
    return new Error(
      `${e.message ?? label} — pg: ${e.cause.message}${e.cause.code ? ` (${e.cause.code})` : ""}`,
    )
  }
  return err instanceof Error ? err : new Error(String(err))
}

export function snakeCase(str: string): string {
  return str.replace(/([A-Z])/g, "_$1").toLowerCase()
}

function matchesDomain(url: string | URL, allowedDomains: string[]): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return allowedDomains.some((pattern) => {
    if (pattern.startsWith("*.")) {
      const suffix = pattern.slice(2)
      return hostname.endsWith(`.${suffix}`) // subdomains only, NOT root domain
    }
    return hostname === pattern
  })
}

function defaultPort(url: URL): string {
  return url.port || (url.protocol === "https:" ? "443" : "80")
}

/**
 * LIAISON_APP_PRIVATE_HOSTS: the operator's comma-separated list of private hosts (`host` or
 * `host:port`, exact names, no wildcards) an app may reach on a private or loopback address and
 * over plain HTTP, for a service on the deployment's own network. Empty by default. The app's own
 * domain allow-list still applies, and link-local and metadata addresses are always refused.
 */
export function isOperatorPrivateAppHost(url: URL): boolean {
  const raw = process.env.LIAISON_APP_PRIVATE_HOSTS ?? ""
  if (!raw.trim()) return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "")
  const port = defaultPort(url)
  for (const entry of raw.split(",")) {
    const e = entry.trim().toLowerCase()
    if (!e) continue
    // `[v6]:port`, `[v6]`, `host:port`, `host` (a bare v6 literal has several colons).
    const m = /^\[([^\]]+)\](?::(\d+))?$/.exec(e) ?? /^([^:]+):(\d+)$/.exec(e)
    const entryHost = m ? m[1] : e
    const entryPort = m ? m[2] : undefined
    if (entryHost === host && (entryPort === undefined || entryPort === port)) return true
  }
  return false
}

/** Spread into every sandbox `fetchWithPinnedHost` call: the operator's private hosts, per hop. */
export const SANDBOX_PRIVATE_HOST_POLICY = {
  privateAllowedFor: isOperatorPrivateAppHost,
} as const

export function validateSandboxFetchUrl(
  url: string | URL,
  allowedDomains: string[],
  allowPrivateHostsInTest: boolean,
): URL {
  const parsed = new URL(url)
  if (!matchesDomain(parsed, allowedDomains)) {
    throw new Error(`Domain not in allowlist: ${parsed.hostname}`)
  }

  try {
    // DNS resolution + private-net check happens inside fetchWithPinnedHost
    // (single lookup, pinned at connect time). This call only validates
    // scheme + literal-IP private ranges.
    if (isOperatorPrivateAppHost(parsed)) {
      return validateOutboundUrlNoDns(parsed, { requireHttps: false, allowPrivate: true })
    }
    return validateOutboundUrlNoDns(parsed, { requireHttps: true, allowPrivateHostsInTest })
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new Error(err.message)
    }
    throw err
  }
}

/**
 * The Knowledge actor a bridge method reads and writes as: the calling person's
 * org, id, scopes, dimension grants and ROLES. Every Knowledge bridge method
 * builds its actor here, so a document shared with a role the person holds is
 * readable on every path (search, get, find by title, update) alike; a path
 * that dropped the roles found a document in search and then could not open it.
 */
export function bridgeKnowledgeActorInput(ctx: {
  orgId: string
  userId: string
  callerScopes: string[] | undefined
  inheritedActor: ActorContext
}): {
  orgId: string
  userId: string
  scopes: string[]
  dimensionGrants: Record<string, string[]>
  roles: string[]
} {
  const person = ctx.inheritedActor.actorType === "user" ? ctx.inheritedActor : null
  return {
    orgId: ctx.orgId,
    userId: ctx.userId,
    scopes: ctx.callerScopes ?? [],
    dimensionGrants: person?.dimensionGrants ?? {},
    roles: person?.roles ?? [],
  }
}
