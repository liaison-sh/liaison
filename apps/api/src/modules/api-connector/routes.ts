// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * API connector admin and read routes, mounted at /api/api-connector (a
 * kernel module, outside /api/apps so the generic app routes never shadow it).
 *
 *   GET    /adapters                     list connections        api-connector:read
 *   PUT    /adapters/:identifier         upload an adapter       api-connector:admin
 *          (?confirmCredentialWipe=true when the save deletes stored credentials; 409 otherwise)
 *   DELETE /adapters/:identifier         remove adapter + creds  api-connector:admin
 *   POST   /adapters/:identifier/test    run one READ operation  api-connector:admin
 *   GET    /adapters/:identifier/versions  kept previous adapters api-connector:admin
 *   POST   /adapters/:identifier/restore   restore one of them    api-connector:admin
 *   GET    /customer?email=&phone=&domain=  customer card data   api-connector:read
 *
 * Credentials go through the generic multiInstance credentials route
 * (`POST /api/connections/api-connector/api/credentials`); the admission check
 * registered below holds it to an existing adapter and its auth type's fields.
 *
 * Demo orgs: the list says `readOnly` (reason "demo"); adapter upload,
 * removal and credentials are refused with one message (`api_connector_change`);
 * the seeded demo connection is answered in-process (modules/demo/api-connector).
 */
import {
  type Adapter,
  type AdapterDeleteResponse,
  type AdapterIssue,
  type AdapterPutResponse,
  type AdapterRestoreResponse,
  type AdaptersListResponse,
  type AdapterVersionsResponse,
  AUTH_CREDENTIAL_FIELDS,
  type ConnectionStatus,
  type ConnectionSummary,
  type ConnectorErrorResponse,
  type CredentialWipeRequiredResponse,
  type CustomerLookupResponse,
  type InvalidAdapterResponse,
  operationSummaries,
  type TestOperationResponse,
} from "@liaison/api-connector-core"
import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import type { AppEnv } from "~/app"
import { parseAdapterDocument } from "~/apps/api-connector/adapter-policy"
import { describeTarget, listVersionsWithTargets } from "~/apps/api-connector/authoring"
import { invalidateConnectionCaches } from "~/apps/api-connector/cache"
import { resolveCustomer } from "~/apps/api-connector/customer"
import { runConnectorOperation } from "~/apps/api-connector/service"
import {
  AdapterChangedError,
  type AdapterSavePlan,
  API_CONNECTOR_APP,
  API_CONNECTOR_CONNECTION,
  CredentialsChangedError,
  credentialStatuses,
  deleteConnection,
  getAdapterRow,
  getAdapterVersion,
  listAdapterRows,
  planAdapterSave,
  upsertAdapterRow,
} from "~/apps/api-connector/store"
import {
  API_CONNECTOR_ERROR_HTTP_STATUS,
  API_CONNECTOR_REQUEST_TIMEOUT_MS,
  ApiConnectorError,
  registerDemoApiConnectorResponder,
} from "~/apps/api-connector/transport"
import { zValidator } from "~/lib/validate"
import { getRequestSignal } from "~/middleware/request-timeout"
import { requireScope } from "~/middleware/require-scope"
import {
  MULTI_INSTANCE_IDENTIFIER_RE,
  registerMultiInstanceCredentialCheck,
} from "~/modules/apps/connections/service"
import { maybeDemoApiConnectorResponse } from "~/modules/demo/api-connector/responder"
import { assertDemoEgressAllowed, isDemoEgressRestricted } from "~/modules/demo/demo-egress"

export const API_CONNECTOR_READ_SCOPE = "api-connector:read"
export const API_CONNECTOR_ADMIN_SCOPE = "api-connector:admin"

/** The public summary of one connection (no credential, ever). */
export function summarizeConnection(
  identifier: string,
  adapter: Adapter,
  status: ConnectionStatus,
): ConnectionSummary {
  const auth = adapter.auth
  return {
    identifier,
    name: adapter.name,
    adapterId: adapter.id,
    adapterVersion: adapter.version,
    baseUrl: adapter.baseUrl,
    auth: {
      type: auth.type,
      ...(auth.type === "apiKey" ? { in: auth.in, name: auth.name } : {}),
    },
    roles: adapter.operations.flatMap((o) => (o.role ? [o.role] : [])),
    operations: operationSummaries(adapter),
    status,
  }
}

function requireIdentifier(raw: string): string {
  if (!MULTI_INSTANCE_IDENTIFIER_RE.test(raw)) {
    throw new HTTPException(400, {
      message: "identifier must be a lowercase slug (letters, digits, -) of at most 40 characters",
    })
  }
  return raw
}

function invalidAdapter(issues: AdapterIssue[]): InvalidAdapterResponse {
  return {
    error: {
      code: "invalid_adapter",
      message: `The adapter is invalid (${issues.length} issue${issues.length === 1 ? "" : "s"}).`,
      issues,
    },
  }
}

function connectorError(err: ApiConnectorError): ConnectorErrorResponse {
  return {
    error: {
      code: err.code,
      message: err.message,
      ...(err.upstreamStatus !== undefined ? { status: err.upstreamStatus } : {}),
    },
  }
}

/** Codes a /test call answers as a refused request rather than as a test result. */
const TEST_REQUEST_ERRORS = new Set([
  "write_not_testable",
  "unknown_connection",
  "unknown_operation",
  "invalid_params",
])

/** The 409 of a save or restore that would delete stored credentials without the confirmation. */
function credentialWipeRequired(
  action: "Saving this adapter" | "Restoring this version",
  plan: { priorTarget: string | null; newTarget: string },
): CredentialWipeRequiredResponse {
  const priorTarget = describeTarget(plan.priorTarget)
  const newTarget = describeTarget(plan.newTarget)
  return {
    error: {
      code: "confirm_credential_wipe",
      message: `${action} moves the credential target from ${priorTarget} to ${newTarget}, which deletes the stored credentials.`,
      priorTarget,
      newTarget,
      details: { priorTarget, newTarget },
    },
  }
}

/** Write a planned save; a stored document or credentials changed since the plan is a 409. */
async function savePlanned(
  orgId: string,
  identifier: string,
  plan: AdapterSavePlan,
  userId: string,
): Promise<boolean> {
  const { credentialsCleared } = await upsertAdapterRow(orgId, identifier, plan.adapter, userId, {
    expectPriorHash: plan.priorHash,
    expectCredentialsPresent: plan.credentialsPresent,
  }).catch((err: unknown) => {
    if (err instanceof AdapterChangedError || err instanceof CredentialsChangedError) {
      throw new HTTPException(409, { message: err.message })
    }
    throw err
  })
  await invalidateConnectionCaches(orgId, identifier)
  return credentialsCleared
}

const restoreBodySchema = z.object({
  versionId: z.string().uuid(),
  confirmCredentialWipe: z.boolean().optional(),
})

const customerQuerySchema = z
  .object({
    email: z.string().trim().max(320).optional(),
    phone: z.string().trim().max(40).optional(),
    domain: z
      .string()
      .trim()
      .max(253)
      .regex(/^[A-Za-z0-9.-]*$/, "a domain name")
      .optional(),
  })
  .refine((q) => Boolean(q.email || q.phone || q.domain), {
    message: "email, phone or domain is required",
  })

const testBodySchema = z.object({
  operation: z.string().min(1).max(64),
  params: z.record(z.string(), z.unknown()).default({}),
})

// The generic credentials route holds a multiInstance post to this check:
// the adapter must exist, and the fields must be exactly what its auth type needs.
registerMultiInstanceCredentialCheck(
  API_CONNECTOR_APP,
  API_CONNECTOR_CONNECTION,
  async ({ orgId, identifier, credentials }) => {
    // Before the generic credential refusal, so a demo org reads why: its
    // connections are pre-configured, not merely "no real credentials".
    await assertDemoEgressAllowed(orgId, "api_connector_change")
    const row = await getAdapterRow(orgId, identifier)
    if (!row) {
      return {
        ok: false,
        status: 404,
        message: `Upload the adapter for "${identifier}" before its credentials.`,
      }
    }
    const needed = AUTH_CREDENTIAL_FIELDS[row.adapter.auth.type]
    const missing = needed.filter((f) => !credentials[f])
    if (missing.length > 0) {
      return {
        ok: false,
        status: 400,
        message: `The ${row.adapter.auth.type} auth of "${identifier}" needs: ${missing.join(", ")}`,
      }
    }
    const extra = Object.keys(credentials).filter((f) => !needed.includes(f))
    if (extra.length > 0) {
      return {
        ok: false,
        status: 400,
        message: `The ${row.adapter.auth.type} auth of "${identifier}" takes no ${extra.join(", ")}`,
      }
    }
    await invalidateConnectionCaches(orgId, identifier)
    return { ok: true }
  },
)

// A demo org's connection (installed by the demo seeder) is answered by the
// in-process fixture CRM; every other request goes on to the egress checks.
registerDemoApiConnectorResponder(maybeDemoApiConnectorResponse)

export const apiConnectorRoutes = new Hono<AppEnv>()
  .get("/adapters", requireScope(API_CONNECTOR_READ_SCOPE), async (c) => {
    const orgId = c.get("orgId")
    const [rows, statuses, demo] = await Promise.all([
      listAdapterRows(orgId),
      credentialStatuses(orgId),
      isDemoEgressRestricted(orgId),
    ])
    return c.json({
      data: {
        connections: rows.map((r) =>
          summarizeConnection(
            r.identifier,
            r.adapter,
            statuses.get(r.identifier) ?? "needs_credentials",
          ),
        ),
        readOnly: demo,
        ...(demo ? { readOnlyReason: "demo" as const } : {}),
      },
    } satisfies AdaptersListResponse)
  })
  .put("/adapters/:identifier", requireScope(API_CONNECTOR_ADMIN_SCOPE), async (c) => {
    const orgId = c.get("orgId")
    const identifier = requireIdentifier(c.req.param("identifier"))
    await assertDemoEgressAllowed(orgId, "api_connector_change")
    const parsed = parseAdapterDocument(await c.req.text())
    if (!parsed.ok) return c.json(invalidAdapter(parsed.issues), 422)
    const plan = await planAdapterSave(orgId, identifier, parsed.adapter)
    if (!plan.ok) return c.json(invalidAdapter(plan.issues), 422)
    if (plan.wipesCredentials && c.req.query("confirmCredentialWipe") !== "true") {
      return c.json(credentialWipeRequired("Saving this adapter", plan), 409)
    }
    const credentialsCleared = await savePlanned(orgId, identifier, plan, c.get("userId"))
    const statuses = await credentialStatuses(orgId)
    return c.json({
      data: {
        ...summarizeConnection(
          identifier,
          parsed.adapter,
          statuses.get(identifier) ?? "needs_credentials",
        ),
        credentialsCleared,
      },
    } satisfies AdapterPutResponse)
  })
  .delete("/adapters/:identifier", requireScope(API_CONNECTOR_ADMIN_SCOPE), async (c) => {
    const orgId = c.get("orgId")
    const identifier = requireIdentifier(c.req.param("identifier"))
    await assertDemoEgressAllowed(orgId, "api_connector_change")
    const removed = await deleteConnection(orgId, identifier)
    await invalidateConnectionCaches(orgId, identifier)
    if (!removed)
      throw new HTTPException(404, { message: `No API connection named "${identifier}".` })
    return c.json({ data: { identifier, removed: true } } satisfies AdapterDeleteResponse)
  })
  .post(
    "/adapters/:identifier/test",
    requireScope(API_CONNECTOR_ADMIN_SCOPE),
    zValidator("json", testBodySchema),
    async (c) => {
      const identifier = requireIdentifier(c.req.param("identifier"))
      const body = c.req.valid("json")
      const started = Date.now()
      try {
        const result = await runConnectorOperation({
          actor: { orgId: c.get("orgId"), userId: c.get("userId"), actorType: "user" },
          identifier,
          operation: body.operation,
          params: body.params,
          mode: "test",
          maxPages: 1,
          budgetMs: API_CONNECTOR_REQUEST_TIMEOUT_MS + 2_000,
          signal: getRequestSignal(c),
        })
        return c.json({
          data: {
            ok: true,
            status: result.status,
            items: result.items,
            truncated: result.truncated,
            ms: result.ms,
          },
        } satisfies TestOperationResponse)
      } catch (err) {
        if (!(err instanceof ApiConnectorError)) throw err
        if (TEST_REQUEST_ERRORS.has(err.code)) {
          return c.json(connectorError(err), API_CONNECTOR_ERROR_HTTP_STATUS[err.code])
        }
        return c.json({
          data: {
            ok: false,
            status: err.upstreamStatus ?? null,
            code: err.code,
            message: err.message,
            ms: Date.now() - started,
          },
        } satisfies TestOperationResponse)
      }
    },
  )
  .get("/adapters/:identifier/versions", requireScope(API_CONNECTOR_ADMIN_SCOPE), async (c) => {
    const identifier = requireIdentifier(c.req.param("identifier"))
    return c.json({
      data: await listVersionsWithTargets(c.get("orgId"), identifier),
    } satisfies AdapterVersionsResponse)
  })
  // Restore a kept adapter: the same validation and credential-target rule as
  // a save, and the current document is kept in turn. A restore that would
  // delete stored credentials needs `confirmCredentialWipe` (409 otherwise).
  .post(
    "/adapters/:identifier/restore",
    requireScope(API_CONNECTOR_ADMIN_SCOPE),
    zValidator("json", restoreBodySchema),
    async (c) => {
      const orgId = c.get("orgId")
      const identifier = requireIdentifier(c.req.param("identifier"))
      const body = c.req.valid("json")
      await assertDemoEgressAllowed(orgId, "api_connector_change")
      const version = await getAdapterVersion(orgId, identifier, body.versionId)
      if (!version) {
        throw new HTTPException(404, {
          message: `No kept version ${body.versionId} of "${identifier}".`,
        })
      }
      const plan = await planAdapterSave(orgId, identifier, version.adapter)
      if (!plan.ok) return c.json(invalidAdapter(plan.issues), 422)
      if (plan.wipesCredentials && body.confirmCredentialWipe !== true) {
        return c.json(credentialWipeRequired("Restoring this version", plan), 409)
      }
      const credentialsCleared = await savePlanned(orgId, identifier, plan, c.get("userId"))
      const statuses = await credentialStatuses(orgId)
      return c.json({
        data: {
          ...summarizeConnection(
            identifier,
            plan.adapter,
            statuses.get(identifier) ?? "needs_credentials",
          ),
          credentialsCleared,
        },
      } satisfies AdapterRestoreResponse)
    },
  )
  .get(
    "/customer",
    requireScope(API_CONNECTOR_READ_SCOPE),
    zValidator("query", customerQuerySchema),
    async (c) => {
      const q = c.req.valid("query")
      const result = await resolveCustomer({
        actor: { orgId: c.get("orgId"), userId: c.get("userId"), actorType: "user" },
        email: q.email,
        phone: q.phone,
        domain: q.domain,
        signal: getRequestSignal(c),
      })
      return c.json({ data: result } satisfies CustomerLookupResponse)
    },
  )
