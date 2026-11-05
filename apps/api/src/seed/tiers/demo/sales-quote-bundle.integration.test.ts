// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SALES ROUTINE'S ONE APPROVAL: CRM RECORD, QUOTE, REPLY WITH THE QUOTE.
//
// The Sales scenario's routine prepares one request the owner approves once:
// the prospect's CRM record (api-connector connector_write), a quote whose
// customer reference is that record's id (invoicing quote_create_and_issue),
// and the reply that attaches the quote's PDF and names its number (mail
// reply). The later steps cite the earlier ones with @ref tokens, so they are
// staged as deferred steps of one bundle and filled in when the head runs.
//
// No model runs here: the tool calls are made directly, as the routine's agent
// makes them (the owner, under the routine's scopes bounded by its agent, on
// the routine's report thread), on a real seeded Sales visitor org.
//
// It needs the app catalog (invoicing is a catalog app): build it once with
// `bun run scripts/build-app-catalog.ts --no-artifacts` (repo-root
// `app-catalog/`, or `--out-dir <dir>` plus `LIAISON_APP_CATALOG_DIR=<dir>`).
// Run it from `apps/api` (the modules it imports use apps/api's `~/` alias):
//   bun run scripts/test-run.ts demo-seed --file src/seed/tiers/demo/sales-quote-bundle.integration.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { buildRefToken } from "@liaison/shared"
import { sql } from "drizzle-orm"
import {
  type DemoApiConnectorResponder,
  registerDemoApiConnectorResponder,
} from "~/apps/api-connector/transport"
import { withPrivilegedDb } from "~/db/privileged"
import { isJobWorkerRegistered, registerJobWorker } from "~/infra/jobs/jobs"
import { resolveRoutineOwnerDimensionGrants } from "~/infra/jobs/kernel-jobs"
import { resolveTurnScope } from "~/modules/agent/runtime/agent-service"
import { decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import { resetAppRegistries } from "~/modules/apps/app-registries"
import { installCatalogApp } from "~/modules/apps/catalog"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { maybeDemoApiConnectorResponse } from "~/modules/demo/api-connector/responder"
import { DemoModeTestAccess } from "~/modules/demo/demo-mode"
import {
  SALES_WORLD_PRODUCT,
  SALES_WORLD_PROSPECT,
  salesEmailInjector,
} from "~/modules/demo/world/sales-email"
import { loadEffectivePermissions } from "~/modules/permissions/permissions"
import { PROSPECT_SCENARIO_ROUTINE } from "./seed-agent-native"
import { salesIssuerProfileId } from "./seed-commerce"
import { type SeedDemoWorldResult, seedDemoWorld } from "./seed-demo"

const DB_URL = process.env.DATABASE_URL ?? ""
const PROSPECT_DOMAIN = SALES_WORLD_PROSPECT.email.split("@")[1] ?? ""
const QUANTITY = 40
const UNIT_PRICE_MINOR = 89900
const DISCOUNT_MINOR = 1366480

let appsDir: string | null = null

type ReinvokePayload = { bundleId?: string; context?: string }
const reinvoked: ReinvokePayload[] = []

async function rows<T>(orgId: string, query: ReturnType<typeof sql>): Promise<T[]> {
  return withPrivilegedDb(orgId, "sales-quote-bundle-test", async (tx) => {
    const result = await tx.execute(query)
    return (Array.isArray(result) ? result : ((result as { rows?: unknown[] }).rows ?? [])) as T[]
  })
}

beforeAll(async () => {
  if (DB_URL === "") throw new Error("DATABASE_URL must be set for this test")
  if (/liaison_dev|liaison_test(?!_)/.test(DB_URL)) {
    throw new Error("refusing to seed a shared database")
  }
  // A demo instance: the CRM is the in-process fixture and the reply to a
  // reserved-domain prospect is delivered as a fixture only there.
  DemoModeTestAccess.set(true)
  if (!process.env.LIAISON_APPS_DIR) {
    appsDir = mkdtempSync(path.join(tmpdir(), "sales-quote-bundle-"))
    process.env.LIAISON_APPS_DIR = path.join(appsDir, "apps")
  }
  // The server registers the fixture CRM transport when it loads the API
  // connector routes; this process loads no routes.
  const responder: DemoApiConnectorResponder = maybeDemoApiConnectorResponse
  registerDemoApiConnectorResponder(responder)
  // A failed bundle re-invokes the proposing agent through a kernel job. No
  // model runs here: the job records what the agent would be told.
  if (!isJobWorkerRegistered("kernel", "agent-reinvoke")) {
    registerJobWorker("kernel", "agent-reinvoke", async (payload: ReinvokePayload) => {
      reinvoked.push(payload)
    })
  }
  await initSandboxPool()
})

afterAll(async () => {
  await shutdownSandboxPool()
  registerDemoApiConnectorResponder(null)
  resetAppRegistries()
  DemoModeTestAccess.set(null)
  if (appsDir) {
    rmSync(appsDir, { recursive: true, force: true })
    delete process.env.LIAISON_APPS_DIR
  }
})

describe("the sales routine's sequenced approval: CRM record, quote, reply", () => {
  let world: SeedDemoWorldResult
  let ownerUserId: string
  let routine: { id: string; scopes: string[]; report_thread_id: string }
  let profileId: string
  let turnScopes: string[]
  let dimensionGrants: Awaited<ReturnType<typeof resolveRoutineOwnerDimensionGrants>>

  /** One prospect conversation per scenario run (the injector keys ids to the run). */
  async function deliverProspectEmail(run: number): Promise<string> {
    const beat = {
      orgId: world.orgId,
      ownerUserId,
      tourId: "demo-sales",
      beatId: "live-email",
      run,
      runStartedAt: new Date(),
    }
    await salesEmailInjector.injectWorldEvent(beat)
    const id = (await salesEmailInjector.entityOf?.(beat)) ?? ""
    if (!id) throw new Error(`no prospect conversation for run ${run}`)
    return id
  }

  /** A tool call as the routine's tick makes it. */
  function call(toolName: string, params: Record<string, unknown>) {
    return executeTool<Record<string, unknown>>({
      toolName,
      orgId: world.orgId,
      actor: {
        actorType: "user",
        userId: ownerUserId,
        orgId: world.orgId,
        scopes: turnScopes,
        dimensionGrants,
      },
      params,
      threadId: routine.report_thread_id,
      origin: "in-app-agent",
    })
  }

  async function ownerActor() {
    const perms = await withPrivilegedDb(world.orgId, "sales-quote-bundle-perms", (tx) =>
      loadEffectivePermissions(tx, ownerUserId, world.orgId),
    )
    return {
      actorType: "user" as const,
      userId: ownerUserId,
      orgId: world.orgId,
      scopes: perms.scopes,
      dimensionGrants: perms.dimensionGrants ?? {},
    }
  }

  async function approve(requestId: string) {
    return decideApproval({
      orgId: world.orgId,
      requestId,
      actor: await ownerActor(),
      decision: "approve",
    })
  }

  function quoteParams(customerReference: string) {
    return {
      issuer_profile_id: profileId,
      counterparty: {
        legal_name: "Northwind Acoustics",
        country: "PT",
        address: "Rua do Exemplo 12\n1100-001 Lisboa\nPortugal",
        email: SALES_WORLD_PROSPECT.email,
      },
      customer_reference: customerReference,
      items: [
        {
          description: SALES_WORLD_PRODUCT,
          quantity: QUANTITY,
          unit_price_minor: UNIT_PRICE_MINOR,
          discount_minor: DISCOUNT_MINOR,
        },
      ],
    }
  }

  type BundleStep = {
    id: string
    tool_name: string
    status: string
    bundle_position: number | null
    depends_on_id: string | null
    current_payload: Record<string, unknown>
    metadata: Record<string, unknown>
    finished_at: string | null
    result: Record<string, unknown> | null
  }

  function bundleSteps(headId: string): Promise<BundleStep[]> {
    return rows<BundleStep>(
      world.orgId,
      sql`SELECT ar.id::text AS id, ar.tool_name, ar.status, ar.bundle_position,
            ar.depends_on_id::text AS depends_on_id, ar.current_payload, ar.metadata,
            (SELECT e.finished_at::text FROM kernel.approved_handler_executions e
              WHERE e.approval_request_id = ar.id AND e.status = 'succeeded' LIMIT 1) AS finished_at,
            (SELECT e.result FROM kernel.approved_handler_executions e
              WHERE e.approval_request_id = ar.id AND e.status = 'succeeded' LIMIT 1) AS result
          FROM kernel.approval_requests ar
          WHERE ar.org_id = ${world.orgId} AND ar.bundle_id = ${headId}
          ORDER BY ar.bundle_position`,
    )
  }

  type Quote = {
    id: string
    number: string
    external_refs: Record<string, unknown>
    pdf_file_id: string | null
    discount_minor: string
    quantity: string
    unit_price_minor: string
  }

  async function quoteById(documentId: string): Promise<Quote | undefined> {
    const [q] = await rows<Quote>(
      world.orgId,
      sql`SELECT d.id::text AS id, d.number, d.external_refs, d.pdf_file_id::text AS pdf_file_id,
            l.discount_minor::text AS discount_minor, l.quantity::text AS quantity,
            l.unit_price_minor::text AS unit_price_minor
          FROM app_invoicing.documents d
          JOIN app_invoicing.document_lines l ON l.document_id = d.id
          WHERE d.org_id = ${world.orgId} AND d.id = ${documentId} AND d.type = 'quote'`,
    )
    return q
  }

  type Outbound = { id: string; text_body: string | null; attachment_sources: string[] }

  function outboundReplies(conversationId: string): Promise<Outbound[]> {
    return rows<Outbound>(
      world.orgId,
      sql`SELECT m.id::text AS id, m.text_body,
            COALESCE((SELECT array_agg(f.copied_from_id::text) FROM kernel.files f
              WHERE f.org_id = m.org_id AND f.app = 'mail' AND f.entity_type = 'message'
                AND f.entity_id = m.id::text), '{}') AS attachment_sources
          FROM app_mail.messages m
          WHERE m.org_id = ${world.orgId} AND m.conversation_id = ${conversationId}
            AND m.direction = 'outbound'`,
    )
  }

  beforeAll(async () => {
    world = await seedDemoWorld({
      orgSlug: `demo-sales-quote-${crypto.randomUUID().slice(0, 8)}`,
      variant: "visitor",
      owner: {
        email: `visitor-${crypto.randomUUID()}@visitor.demo.invalid`,
        name: "Visitor",
        password: "VisitorOwner1!Seed",
      },
      needs: ["sales"],
    })
    ownerUserId = world.org.ownerUserId ?? ""
    if (!ownerUserId) throw new Error("the visitor org was seeded with no owner")
    await ensureAppsForOrg(world.orgId)
    // Invoicing is a catalog app. Its install is instance-wide (a database row)
    // while its files live in this run's apps dir: an earlier run on the same
    // database leaves the row and no files, and the seed then skips the
    // install. Reinstalling the baked package (a plain overwrite) puts the
    // files back and registers it for this org.
    await installCatalogApp({ orgId: world.orgId, name: "invoicing", installedBy: ownerUserId })
    const [row] = await rows<{ id: string; scopes: string[]; report_thread_id: string }>(
      world.orgId,
      sql`SELECT id::text AS id, scopes, report_thread_id::text AS report_thread_id
          FROM kernel.routines
          WHERE org_id = ${world.orgId} AND name = ${PROSPECT_SCENARIO_ROUTINE}`,
    )
    if (!row) {
      throw new Error(
        `the prospect routine was not seeded: ${world.failures.map((f) => `${f.layer}: ${f.message.slice(-600)}`).join("; ")}`,
      )
    }
    routine = row
    profileId = salesIssuerProfileId(world.orgId)
    // What a tick runs with: the routine's scopes bounded by its acting agent,
    // and the owner's dimension grants (kernel-jobs.ts, the routine invoker).
    const turn = await withPrivilegedDb(world.orgId, "sales-quote-bundle-turn", (tx) =>
      resolveTurnScope(
        tx,
        world.orgId,
        routine.report_thread_id,
        { userId: ownerUserId, scopes: routine.scopes },
        routine.id,
      ),
    )
    turnScopes = turn ? turn.effectiveScope : routine.scopes
    dimensionGrants = await resolveRoutineOwnerDimensionGrants(world.orgId, ownerUserId)
  }, 2_400_000)

  it("a new prospect: one approval creates the CRM contact, issues the quote citing it, and sends the reply with the quote", async () => {
    expect(world.failures).toEqual([])
    const conversationId = await deliverProspectEmail(0)

    // 1. The CRM record: gated, its record id handed out as a token.
    const write = await call("api-connector:connector_write", {
      connection: "crm",
      operation: "create_contact",
      params: {
        email: SALES_WORLD_PROSPECT.email,
        firstName: "Inês",
        lastName: "Duarte",
        companyName: "Northwind Acoustics",
        companyDomain: PROSPECT_DOMAIN,
        companyIndustry: "Rents out studio and field recording equipment",
      },
    })
    expect(write.blocked?.reason).toBe("gated")
    const headId = write.blocked?.approvalRequestId ?? ""
    expect(write.blocked?.outputs?.record_id).toBe(buildRefToken(headId, "record_id"))

    // 2. The quote, citing the record: sequenced behind it, not parked alone.
    const quote = await call(
      "invoicing:quote_create_and_issue",
      quoteParams(buildRefToken(headId, "record_id")),
    )
    expect(quote.blocked?.reason).toBe("gated")
    expect(quote.blocked?.sequenced).toBe(true)
    const quoteStepId = quote.blocked?.approvalRequestId ?? ""
    expect(quote.blocked?.outputs?.pdf_file_id).toBe(buildRefToken(quoteStepId, "pdf_file_id"))
    expect(quote.blocked?.outputs?.number).toBe(buildRefToken(quoteStepId, "number"))

    // 3. The reply, attaching the quote's PDF and naming its number.
    const reply = await call("mail:reply", {
      conversationId,
      attachments: [buildRefToken(quoteStepId, "pdf_file_id")],
      textBody: `Hello Inês,\n\nPlease find our quote ${buildRefToken(quoteStepId, "number")} for ${QUANTITY} ${SALES_WORLD_PRODUCT} units attached. Lead time is 2 to 3 weeks, payment at 30 days.`,
    })
    expect(reply.blocked?.reason).toBe("gated")
    expect(reply.blocked?.sequenced).toBe(true)
    const replyStepId = reply.blocked?.approvalRequestId ?? ""

    const staged = await bundleSteps(headId)
    expect(staged.map((s) => [s.id, s.tool_name, s.status, s.bundle_position])).toEqual([
      [headId, "api-connector:connector_write", "pending", 0],
      [quoteStepId, "invoicing:quote_create_and_issue", "deferred", 1],
      [replyStepId, "mail:reply", "deferred", 2],
    ])
    expect(staged.map((s) => s.depends_on_id)).toEqual([null, headId, quoteStepId])

    // The owner approves once.
    const decided = await approve(headId)
    expect(decided.status).toBe("approved")

    const ran = await bundleSteps(headId)
    expect(ran.map((s) => [s.tool_name, s.status])).toEqual([
      ["api-connector:connector_write", "approved"],
      ["invoicing:quote_create_and_issue", "approved"],
      ["mail:reply", "approved"],
    ])
    // In order: each step finished no earlier than the one it depends on.
    const finished = ran.map((s) => Date.parse(s.finished_at ?? ""))
    expect(finished.every((t) => Number.isFinite(t))).toBe(true)
    expect(finished[0]).toBeLessThanOrEqual(finished[1])
    expect(finished[1]).toBeLessThanOrEqual(finished[2])

    // The CRM contact exists: a real record id, and the CRM finds the prospect now.
    const recordId = String(ran[0].result?.record_id ?? "")
    expect(recordId).toMatch(/^ct_\d+$/)
    const lookup = await call("api-connector:connector_read", {
      connection: "crm",
      operation: "find_customers",
      params: { email: SALES_WORLD_PROSPECT.email },
    })
    expect(JSON.stringify(lookup.data)).toContain(PROSPECT_DOMAIN)

    // The quote cites the resolved record id, carries the discount and has a PDF.
    const documentId = String(ran[1].result?.document_id ?? "")
    const issued = await quoteById(documentId)
    expect(issued?.external_refs.customer_reference).toBe(recordId)
    expect(Number(issued?.quantity)).toBe(QUANTITY)
    expect(Number(issued?.unit_price_minor)).toBe(UNIT_PRICE_MINOR)
    expect(Number(issued?.discount_minor)).toBe(DISCOUNT_MINOR)
    expect(issued?.pdf_file_id).toBeTruthy()
    expect(ran[1].result?.pdf_file_id).toBe(issued?.pdf_file_id ?? "")
    expect(issued?.number).toMatch(/^SQ-\d{4}-/)

    // The reply went out with the quote PDF and the real number, no token left.
    const sent = await outboundReplies(conversationId)
    expect(sent).toHaveLength(1)
    expect(sent[0].attachment_sources).toEqual([issued?.pdf_file_id ?? ""])
    expect(sent[0].text_body ?? "").toContain(issued?.number ?? "<no number>")
    expect(sent[0].text_body ?? "").not.toContain("@ref:")
    expect(JSON.stringify(ran[2].current_payload)).not.toContain("@ref:")
    expect(JSON.stringify(ran[1].current_payload)).not.toContain("@ref:")
  })

  it("a prospect already in the CRM: the quote parks itself, the reply joins its approval, one approval runs both", async () => {
    const conversationId = await deliverProspectEmail(1)

    // The sales profile gates every quote (threshold 0): the handler parks it.
    const quote = await call("invoicing:quote_create_and_issue", quoteParams("cmp_001"))
    expect(quote.blocked).toBeUndefined()
    const parked = quote.data
    expect(parked.status).toBe("pending_approval")
    const quoteId = String(parked.approval_id ?? "")
    expect(quoteId).not.toBe("")
    expect(parked.outputs).toMatchObject({
      pdf_file_id: buildRefToken(quoteId, "pdf_file_id"),
      number: buildRefToken(quoteId, "number"),
    })

    const reply = await call("mail:reply", {
      conversationId,
      attachments: [buildRefToken(quoteId, "pdf_file_id")],
      textBody: `Hello Inês,\n\nOur quote ${buildRefToken(quoteId, "number")} is attached.`,
    })
    expect(reply.blocked?.sequenced).toBe(true)
    const replyStepId = reply.blocked?.approvalRequestId ?? ""
    const staged = await bundleSteps(quoteId)
    expect(staged.map((s) => [s.id, s.status, s.bundle_position])).toEqual([
      [quoteId, "pending", 0],
      [replyStepId, "deferred", 1],
    ])

    expect((await approve(quoteId)).status).toBe("approved")
    const ran = await bundleSteps(quoteId)
    expect(ran.map((s) => [s.tool_name, s.status])).toEqual([
      ["invoicing:quote_create_and_issue", "approved"],
      ["mail:reply", "approved"],
    ])
    const issued = await quoteById(String(ran[0].result?.document_id ?? ""))
    expect(issued?.external_refs.customer_reference).toBe("cmp_001")
    expect(issued?.pdf_file_id).toBeTruthy()
    const sent = await outboundReplies(conversationId)
    expect(sent).toHaveLength(1)
    expect(sent[0].attachment_sources).toEqual([issued?.pdf_file_id ?? ""])
    expect(sent[0].text_body ?? "").toContain(issued?.number ?? "<no number>")
    expect(sent[0].text_body ?? "").not.toContain("@ref:")
  })

  it("a step that cannot be filled in after approval fails the bundle cleanly: the reply is not sent", async () => {
    const conversationId = await deliverProspectEmail(2)
    const quote = await call("invoicing:quote_create_and_issue", quoteParams("cmp_002"))
    const quoteId = String(quote.data.approval_id ?? "")
    expect(quoteId).not.toBe("")
    const reply = await call("mail:reply", {
      conversationId,
      attachments: [buildRefToken(quoteId, "pdf_file_id")],
      textBody: `Our quote ${buildRefToken(quoteId, "number")} is attached.`,
    })
    const replyStepId = reply.blocked?.approvalRequestId ?? ""
    expect(replyStepId).not.toBe("")

    // A person edits the waiting reply and cites a key the quote does not have.
    await updatePayload({
      orgId: world.orgId,
      requestId: replyStepId,
      fields: { textBody: `Our quote ${buildRefToken(quoteId, "quote_number")} is attached.` },
      actor: await ownerActor(),
      actingAgentId: null,
    })

    expect((await approve(quoteId)).status).toBe("approved")
    const steps = await bundleSteps(quoteId)
    // The quote ran (it is committed); the reply was cancelled and never sent.
    expect(steps.map((s) => [s.tool_name, s.status])).toEqual([
      ["invoicing:quote_create_and_issue", "approved"],
      ["mail:reply", "cancelled"],
    ])
    expect(await outboundReplies(conversationId)).toEqual([])
    const failure = JSON.stringify(
      steps.find((s) => s.metadata.executionFailure)?.metadata.executionFailure ?? null,
    )
    expect(failure).toContain(replyStepId)
    expect(failure).toContain("quote_number")
    expect(failure).toContain("invoicing:quote_create_and_issue")
    expect(failure).toContain("pdf_file_id")
    // What the proposing agent is told, to correct the call.
    // The job runs on this process's worker, just after the decision returns.
    for (let i = 0; i < 100 && !reinvoked.some((p) => p.bundleId === quoteId); i++) {
      await Bun.sleep(100)
    }
    const context = String(reinvoked.find((p) => p.bundleId === quoteId)?.context ?? "")
    expect(context).toContain("mail:reply")
    expect(context).toContain("quote_number")
    expect(context).toContain("pdf_file_id")
  })
})
