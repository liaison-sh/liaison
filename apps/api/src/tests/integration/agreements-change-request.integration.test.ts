// SPDX-License-Identifier: FSL-1.1-ALv2
//
// change_request_send through the real path: the agreements app registered from its manifest,
// a person's own call in the sandbox, the change request frozen by the host renderer, its
// approval link minted by the kernel, and the reply as the declared mail call. When the reply
// cannot leave (here: the person has no mailbox for that conversation), the kernel withdraws
// the link in the same call and the change request stays a draft: nothing reaches the client.
// Approved on its link with the code, the change request is a recorded approval sealed like a
// signature, accepted, and its parent's amended total rises by its price; its parent's project
// then gets one milestone task, made as the person who sent the change request, and its billing
// plan one milestone for the price (invoicing's step, added once). A run killed half way and asked
// again, or asked twice at once, leaves one change request that can be accepted, never two.

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import postgres from "postgres"
import { createProject } from "~/apps/projects/service/create-project"
import { sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import type { EmailProvider } from "~/infra/email"
import { getSystemEmailProvider, setSystemEmailProvider } from "~/infra/email"
import { env } from "~/lib/env"
import { decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import { approvalPayloadHash } from "~/modules/approvals/payload-hash"
import { CatalogDerivationsTestAccess } from "~/modules/apps/catalog-derivations"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { forgetOrgApps, primeOrgApps } from "~/modules/apps/org-apps"
import { registerApps } from "~/modules/apps/runtime"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { initWorkerPool, shutdownWorkerPool } from "~/modules/apps/sandbox/worker-pool"
import { mintClientAction } from "~/modules/client-actions/mint"
import { seedContext } from "~/seed/context"
import { insertAppRow } from "~/seed/factories/app-tables"
import { insertSql } from "~/seed/factories/org/test-rows"
import { asUser } from "~/seed/factories/people/actors"
import * as minimal from "~/seed/tiers/minimal"
import { drainOutbox } from "~/tests/helpers/outbox"
import {
  acquireTestLock,
  clearRedisPatterns,
  releaseTestLock,
  superuserUrlForTestDb,
} from "~/tests/route-test-setup"
import {
  CaptureProvider,
  createDoorWorld,
  type DoorWorld,
  dropDoorWorld,
} from "~/tests/security/portal-doors/fixture"
import { call, codeOf, tokenOf } from "../../../test-support/client-actions-kit"
import {
  appendMailMessages,
  ensureMailAccount,
  seedMailConversation,
} from "../../../test-support/seed/mail"

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..")
const SCOPES = ["agreements:agreements:read", "agreements:agreements:write", "mail:*"]
const mutableEnv = env as { LIAISON_TSA_URL?: string }
const kernel = (table: string) => sql(`${schemaRef("kernel")}.${table}`)
const app = (table: string) => sql(`${schemaRef("app_agreements")}.${table}`)
const SHA = "c".repeat(64)
let crId = ""
let crVersionId = ""

async function mailTo(email: string, template: string, after: number) {
  for (let i = 0; i < 250; i++) {
    const m = capture.sent.find((x, n) => n >= after && x.to === email && x.template === template)
    if (m) return m
    await new Promise((r) => setTimeout(r, 20))
  }
  throw new Error(`no ${template} mail to ${email}`)
}

let w: DoorWorld
let parentId = ""
let versionId = ""
let projectId = ""
let conversationId = ""
let agentThreadId = ""
/** What the stubbed SMTP was handed: a row here is a mail that left the person's mailbox. */
const smtpSent: Array<Record<string, unknown>> = []
const capture = new CaptureProvider()
let previousMail: EmailProvider
let prevTsa: string | undefined

function descriptor(appName = "agreements"): Record<string, unknown> {
  const manifest = JSON.parse(
    readFileSync(join(REPO_ROOT, "bundled-apps", appName, "app.manifest.json"), "utf8"),
  ) as Record<string, unknown>
  return {
    ...manifest,
    trusted: false,
    _format: "manifest",
    // As the image installs it: its own catalog tarball, so its transaction keys hold.
    _firstParty: true,
    _bundlePath: join(REPO_ROOT, "bundled-apps", appName, String(manifest.version), "bundle.js"),
  }
}

type Out = { data?: Record<string, any>; error?: { code: string; message: string } }

async function asPerson(userId: string, tool: string, params: unknown): Promise<Out> {
  const actor: UserContext = {
    actorType: "user",
    userId,
    orgId: w.orgId,
    scopes: SCOPES,
    dimensionGrants: {},
  }
  return (await executeToolCore({
    toolName: `agreements:${tool}`,
    orgId: w.orgId,
    actor,
    params,
    origin: "human-ui",
  } as never)) as Out
}

beforeAll(async () => {
  await acquireTestLock()
  process.env.LIAISON_BUNDLED_APPS_FROM_SOURCE = "1"
  prevTsa = mutableEnv.LIAISON_TSA_URL
  mutableEnv.LIAISON_TSA_URL = "https://tsa.example.test/"
  previousMail = getSystemEmailProvider()
  setSystemEmailProvider(capture)
  w = await createDoorWorld()
  await ensureAppsForOrg(w.orgId)
  await initSandboxPool()
  await initWorkerPool()
  const { failedApps } = await registerApps(
    [descriptor() as never, descriptor("invoicing") as never],
    w.orgId,
  )
  expect(failedApps).toEqual([])
  await primeOrgApps(w.orgId, 0)
  await rebuildFilesSelectPolicy({ parents: CatalogDerivationsTestAccess.registryFileParents() })
  // The person's own mailbox and the client's mail the reply answers (an hour old).
  SandboxBridgeTestAccess.setSmtpSend(async (_connection, _identifier, message) => {
    smtpSent.push(message as Record<string, unknown>)
    return { messageId: `<sent-${smtpSent.length}@studio.test>`, deliveryState: "delivered" }
  })
  const seedCtx = seedContext({ orgId: w.orgId, now: new Date() })
  const { accountId } = await ensureMailAccount(seedCtx, {
    ownerType: "user",
    userId: w.admin.userId,
    email: "studio@studio.test",
    provider: "imap",
  })
  conversationId = (
    await seedMailConversation(seedCtx, {
      accountId,
      subject: "Single sign-on",
      status: "open",
      labels: [],
      isRead: false,
      isStarred: false,
      contactId: w.clientA.contactId,
      messageCount: 1,
      messages: [],
    })
  ).conversationId
  await appendMailMessages(seedCtx, {
    conversationId,
    messages: [
      {
        direction: "inbound",
        from: { email: w.clientA.email },
        to: [{ email: "studio@studio.test" }],
        textBody: "Could we add sign-in with our identity provider?",
        sentAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
      },
    ],
    updateConversation: true,
    announce: false,
  })
  agentThreadId = await minimal.thread(w.orgId, w.admin.userId)
  parentId = crypto.randomUUID()
  versionId = crypto.randomUUID()
  const owner: UserContext = {
    actorType: "user",
    userId: w.admin.userId,
    orgId: w.orgId,
    scopes: ["*"],
    dimensionGrants: {},
  }
  projectId = await asUser(owner, async (tx) => {
    const made = await createProject({
      tx: tx as never,
      orgId: w.orgId,
      actor: owner,
      input: { name: "Website", key: "WEB" },
    })
    return made.id
  })
  await withPrivilegedDb(w.orgId, "test:change-request-parent", async (tx) => {
    await insertAppRow(tx, "agreements", "agreements", {
      org_id: w.orgId,
      id: parentId,
      number: "AG-2026-014",
      kind: "sow",
      status: "signed",
      title: "Website",
      company_id: w.companyA,
      contact_id: w.clientA.contactId,
      currency: "EUR",
      price_minor: "4200000",
      project_id: projectId,
      org_access: "editor",
      created_by_user_id: w.admin.userId,
    })
    await insertAppRow(tx, "agreements", "agreement_versions", {
      org_id: w.orgId,
      id: versionId,
      agreement_id: parentId,
      number: 1,
      status: "signed",
      sha256: SHA,
      source_text:
        "1. Scope\nA website in two languages.\n8.2 Extra work is billed at 100.00 EUR per hour.",
      frozen_at: new Date().toISOString(),
    })
    // The project's billing plan, from its quote: one final step on the launch task.
    const issuerId = crypto.randomUUID()
    const quoteId = crypto.randomUUID()
    await insertAppRow(tx, "invoicing", "issuer_profiles", {
      org_id: w.orgId,
      id: issuerId,
      legal_name: "Maison Studio SAS",
      country: "FR",
      default_currency: "EUR",
    })
    await insertAppRow(tx, "invoicing", "documents", {
      org_id: w.orgId,
      id: quoteId,
      type: "quote",
      status: "accepted",
      number: "Q-0040",
      issuer_profile_id: issuerId,
      currency: "EUR",
      subtotal_minor: "4200000",
    })
    await insertAppRow(tx, "invoicing", "billing_steps", {
      org_id: w.orgId,
      billing_project_id: projectId,
      position: 1,
      kind: "final",
      label: "Launch",
      amount_minor: "4200000",
      currency: "EUR",
      task_id: crypto.randomUUID(),
      quote_document_id: quoteId,
      state: "planned",
    })
  })
}, 300_000)

afterAll(async () => {
  SandboxBridgeTestAccess.setSmtpSend(null)
  await rebuildFilesSelectPolicy()
  forgetOrgApps(w.orgId)
  await shutdownWorkerPool()
  await shutdownSandboxPool()
  setSystemEmailProvider(previousMail)
  mutableEnv.LIAISON_TSA_URL = prevTsa
  await clearRedisPatterns(["ca:*"])
  if (w) {
    await sql`DELETE FROM ${kernel("files")} WHERE org_id = ${w.orgId}`
    for (const t of ["billing_steps", "documents", "issuer_profiles"])
      await sql`DELETE FROM ${sql(`${schemaRef("app_invoicing")}.${t}`)} WHERE org_id = ${w.orgId}`
    for (const t of ["tasks", "projects"])
      await sql`DELETE FROM ${sql(`${schemaRef("app_projects")}.${t}`)} WHERE org_id = ${w.orgId}`
    for (const t of [
      "approved_handler_executions",
      "approval_requests",
      "thread_participants",
      "threads",
    ])
      await sql`DELETE FROM ${kernel(t)} WHERE org_id = ${w.orgId}`
    await dropDoorWorld(w)
  }
  await releaseTestLock()
})

describe("a change request sent through the sandbox", () => {
  it("a reply that cannot leave withdraws the approval link the kernel minted, and the change request stays a draft", async () => {
    const out = await asPerson(w.admin.userId, "change_request_send", {
      parent_agreement_id: parentId,
      title: "Single sign-on",
      work: ["Sign-in with the client's identity provider"],
      hours_minutes: 3600,
      hours_source: "past similar work",
      rate_minor: "10000",
      reply: { conversation_id: crypto.randomUUID(), body: "Here is a change request." },
      passage: { version_id: versionId, section: "8.2" },
      mail_message_id: "mail-1",
    })
    // The call answers the mail's refusal, named, and says the link was withdrawn.
    const message = String(out.error?.message ?? out.data?.error?.message ?? "")
    expect(message).toContain("was withdrawn")
    const crs = (await sql`
      SELECT id, number, status, price_minor::text AS price, hours_minutes FROM ${app("agreements")}
       WHERE org_id = ${w.orgId} AND parent_agreement_id = ${parentId}`) as unknown as Array<{
      id: string
      number: string
      status: string
      price: string
      hours_minutes: number
    }>
    expect(crs).toHaveLength(1)
    expect(crs[0]).toMatchObject({
      number: "CR-1",
      status: "draft",
      price: "600000",
      hours_minutes: 3600,
    })
    const [v] = (await sql`
      SELECT id, status FROM ${app("agreement_versions")} WHERE agreement_id = ${crs[0]?.id}`) as unknown as Array<{
      id: string
      status: string
    }>
    expect(v?.status).toBe("frozen")
    crId = crs[0]?.id ?? ""
    crVersionId = v?.id ?? ""
    const links = (await sql`
      SELECT kind, revoked_at IS NOT NULL AS revoked FROM ${kernel("client_actions")}
       WHERE org_id = ${w.orgId} AND target_id = ${v?.id}::uuid`) as unknown as Array<{
      kind: string
      revoked: boolean
    }>
    expect(links.length).toBeGreaterThan(0)
    expect(links.every((l) => l.kind === "approve" && l.revoked)).toBe(true)
  }, 120_000)

  it("approved on its link with the code, it is a recorded approval sealed like a signature, the parent's total rises by its price, and its project gets the task as its sender", async () => {
    // As if the reply had left: the change request waits for its client.
    await sql`UPDATE ${app("agreements")} SET status = 'sent' WHERE id = ${crId}`
    const before = capture.sent.length
    await mintClientAction({
      orgId: w.orgId,
      kind: "approve",
      targetApp: "agreements",
      targetType: "agreement_version",
      targetId: crVersionId,
      contactId: w.clientA.contactId,
      companyId: w.companyA,
      invitedEmail: w.clientA.email,
      invitedName: w.clientA.name,
      expiresInDays: 14,
      createdByUserId: w.admin.userId,
    })
    const token = tokenOf(await mailTo(w.clientA.email, "client-action.link", before))
    const h = { "x-bun-socket-ip": "198.51.100.92" }
    expect((await call("open", { t: token }, h)).status).toBe(200)
    expect((await call("document", { t: token, format: "blocks" }, h)).status).toBe(200)
    await clearRedisPatterns(["ca:code:gap:*"])
    const codeAt = capture.sent.length
    expect((await call("code", { t: token }, h)).status).toBe(202)
    const code = codeOf(await mailTo(w.clientA.email, "client-action.code", codeAt))
    const verified = await call("verify", { t: token, code, name: w.clientA.name }, h)
    expect(verified.status).toBe(200)
    const { proof } = (await verified.json()) as { proof: string }
    const approved = await call(
      "decide",
      { t: token, proof, decision: "approve", typed_name: w.clientA.name },
      h,
    )
    expect(approved.status).toBe(200)
    await drainOutbox()
    const [cr] = (await sql`
      SELECT status FROM ${app("agreements")} WHERE id = ${crId}`) as unknown as Array<{
      status: string
    }>
    expect(cr?.status).toBe("accepted")
    const [parent] = (await sql`
      SELECT amended_total_minor::text AS total FROM ${app("agreements")} WHERE id = ${parentId}`) as unknown as Array<{
      total: string | null
    }>
    expect(parent?.total).toBe("4800000")
    const events = (await sql`
      SELECT level FROM ${app("signature_events")} WHERE version_id = ${crVersionId}`) as unknown as Array<{
      level: string
    }>
    expect(events.map((e) => e.level)).toEqual(["recorded_approval"])
    const [pkg] = (await sql`
      SELECT level FROM ${app("evidence_packages")} WHERE version_id = ${crVersionId}`) as unknown as Array<{
      level: string
    }>
    expect(pkg?.level).toBe("recorded_approval")
    // The work follows: one milestone task in the parent's project, made by the person who sent
    // the change request (never a system identity), recorded on the change request.
    const tasks = (await sql`
      SELECT id::text AS id, title, created_by::text AS created_by
        FROM ${sql(`${schemaRef("app_projects")}.tasks`)}
       WHERE org_id = ${w.orgId} AND project_id = ${projectId}::uuid`) as unknown as Array<{
      id: string
      title: string
      created_by: string | null
    }>
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({ title: "CR-1: Single sign-on", created_by: w.admin.userId })
    const [effects] = (await sql`
      SELECT effects_task_id::text AS task, effects_done_at IS NOT NULL AS done, effects_note AS note
        FROM ${app("agreements")} WHERE id = ${crId}`) as unknown as Array<{
      task: string | null
      done: boolean
      note: string | null
    }>
    expect(effects).toMatchObject({ task: tasks[0]?.id, done: true })
    // Its billing plan has one more milestone for the price, on that task, named by the change
    // request, added by invoicing as the person who sent it.
    const steps = async () =>
      (await sql`
        SELECT kind, amount_minor::text AS amount, task_id::text AS task, change_request_ref AS ref
          FROM ${sql(`${schemaRef("app_invoicing")}.billing_steps`)}
         WHERE org_id = ${w.orgId} AND change_request_ref IS NOT NULL`) as unknown as Array<{
        kind: string
        amount: string
        task: string
        ref: string
      }>
    expect(await steps()).toEqual([
      { kind: "milestone", amount: "600000", task: tasks[0]?.id ?? "", ref: crId },
    ])
  }, 120_000)
  it("staged by an agent and its hours edited on the card, the approved change request is priced from the edit, its link is minted and the reply leaves the person's mailbox", async () => {
    const actor: UserContext = {
      actorType: "user",
      userId: w.admin.userId,
      orgId: w.orgId,
      scopes: ["*"],
      dimensionGrants: {},
    }
    const staged = (await executeToolCore({
      toolName: "agreements:change_request_send",
      orgId: w.orgId,
      actor,
      threadId: agentThreadId,
      origin: "in-app-agent",
      params: {
        parent_agreement_id: parentId,
        title: "Identity provider sign-in",
        work: ["Sign-in with the client's identity provider"],
        hours_minutes: 3600,
        hours_source: "past similar work",
        rate_minor: "10000",
        reply: { conversation_id: conversationId, body: "Here is a change request for it." },
        passage: { version_id: versionId, section: "8.2" },
        mail_message_id: "mail-2",
      },
    } as never)) as { blocked?: { approvalRequestId?: string }; error?: unknown }
    expect(staged.error).toBeUndefined()
    const requestId = staged.blocked?.approvalRequestId ?? ""
    expect(requestId).toMatch(/^[0-9a-f-]{36}$/)
    // The person changes the hours on the card: 70 h instead of 60 h.
    const edited = await updatePayload({
      orgId: w.orgId,
      requestId,
      actor,
      fields: { hours_minutes: 4200 },
    } as never)
    expect(edited.currentPayload.hours_minutes).toBe(4200)
    // The edit re-binds the payload: its fingerprint is the edited payload's.
    expect(edited.payloadHash).toBe(
      approvalPayloadHash("agreements:change_request_send", edited.currentPayload),
    )
    const [row] = (await sql`
      SELECT current_payload FROM ${kernel("approval_requests")} WHERE id = ${requestId}`) as unknown as Array<{
      current_payload: Record<string, unknown>
    }>
    expect(row?.current_payload.hours_minutes).toBe(4200)
    const before = smtpSent.length
    await decideApproval({ orgId: w.orgId, requestId, actor, decision: "approve" } as never)
    await drainOutbox()
    const crs = (await sql`
      SELECT id, number, status, hours_minutes, price_minor::text AS price FROM ${app("agreements")}
       WHERE org_id = ${w.orgId} AND parent_agreement_id = ${parentId} AND title = 'Identity provider sign-in'`) as unknown as Array<{
      id: string
      number: string
      status: string
      hours_minutes: number
      price: string
    }>
    expect(crs).toHaveLength(1)
    expect(crs[0]).toMatchObject({ status: "sent", hours_minutes: 4200, price: "700000" })
    const links = (await sql`
      SELECT a.kind, a.revoked_at IS NULL AS open FROM ${kernel("client_actions")} a
        JOIN ${app("agreement_versions")} v ON v.id = a.target_id
       WHERE a.org_id = ${w.orgId} AND v.agreement_id = ${crs[0]?.id}`) as unknown as Array<{
      kind: string
      open: boolean
    }>
    expect(links).toEqual([{ kind: "approve", open: true }])
    // The reply left the person's mailbox, once, to the client.
    const replies = smtpSent.slice(before)
    expect(replies).toHaveLength(1)
    expect(JSON.stringify(replies[0])).toContain(w.clientA.email)
  }, 180_000)

  describe("killed half way and asked again", () => {
    /** The test database's owner: the app's own role makes no trigger. */
    let owner: ReturnType<typeof postgres>
    beforeAll(() => {
      owner = postgres(superuserUrlForTestDb() as string, { max: 1, onnotice: () => {} })
    })
    afterEach(async () => {
      delete process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
      await owner.unsafe("DROP TRIGGER IF EXISTS cut_cr_test ON kernel.client_actions")
      await owner.unsafe("DROP FUNCTION IF EXISTS public.cut_cr_test_fn()")
    })
    afterAll(async () => {
      await owner.end()
    })

    /** Runs `act` in the database before this org's next link is written. */
    async function whileLinkIsWritten(act: string): Promise<void> {
      await owner.unsafe(`CREATE OR REPLACE FUNCTION public.cut_cr_test_fn() RETURNS trigger AS $$
        BEGIN
          IF NEW.org_id = '${w.orgId}' THEN ${act} END IF;
          RETURN NEW;
        END $$ LANGUAGE plpgsql SECURITY DEFINER`)
      await owner.unsafe(`CREATE TRIGGER cut_cr_test BEFORE INSERT ON kernel.client_actions
        FOR EACH ROW EXECUTE FUNCTION public.cut_cr_test_fn()`)
    }
    /** Staged by an agent and approved by the person: what the approved call answered. */
    async function ask(
      title: string,
      mail: string,
      over: Record<string, unknown> = {},
      runMs?: number,
    ): Promise<string> {
      const actor: UserContext = {
        actorType: "user",
        userId: w.admin.userId,
        orgId: w.orgId,
        scopes: ["*"],
        dimensionGrants: {},
      }
      const staged = (await executeToolCore({
        toolName: "agreements:change_request_send",
        orgId: w.orgId,
        actor,
        threadId: agentThreadId,
        origin: "in-app-agent",
        params: {
          parent_agreement_id: parentId,
          title,
          work: ["Extra work"],
          hours_minutes: 60,
          hours_source: "past similar work",
          rate_minor: "10000",
          reply: { conversation_id: conversationId, body: "Here is a change request." },
          passage: { version_id: versionId, section: "8.2" },
          mail_message_id: mail,
          ...over,
        },
      } as never)) as { blocked?: { approvalRequestId?: string } }
      const requestId = staged.blocked?.approvalRequestId
      if (!requestId) return JSON.stringify(staged)
      if (runMs) process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS = String(runMs)
      try {
        return JSON.stringify(
          await decideApproval({ orgId: w.orgId, requestId, actor, decision: "approve" } as never),
        )
      } catch (err) {
        return `${(err as { code?: string }).code ?? ""} ${String(err)}`
      } finally {
        delete process.env.LIAISON_SANDBOX_MAX_TOOL_TIMEOUT_MS
      }
    }
    const crsOf = async (title: string) =>
      (await sql`
        SELECT id, number, status, hours_minutes FROM ${app("agreements")}
         WHERE org_id = ${w.orgId} AND parent_agreement_id = ${parentId} AND title = ${title}
         ORDER BY number`) as unknown as Array<{
        id: string
        number: string
        status: string
        hours_minutes: number
      }>
    const openLinks = async (title: string) =>
      (await sql`
        SELECT a.id FROM ${kernel("client_actions")} a
          JOIN ${app("agreement_versions")} v ON v.id = a.target_id
          JOIN ${app("agreements")} g ON g.id = v.agreement_id
         WHERE a.org_id = ${w.orgId} AND g.title = ${title} AND a.revoked_at IS NULL`) as unknown as unknown[]
    const until = async (cond: () => Promise<boolean>) => {
      const end = Date.now() + 15_000
      while (!(await cond())) {
        if (Date.now() > end) throw new Error("did not settle")
        await new Promise((r) => setTimeout(r, 50))
      }
    }
    const linkMails = (after: number) =>
      capture.sent.slice(after).filter((m) => m.template === "client-action.link")

    it("while its link is written: the retry names it, and one can be accepted", async () => {
      const title = "Killed at its link"
      const [mailsAt, repliesAt] = [capture.sent.length, smtpSent.length]
      await whileLinkIsWritten("PERFORM pg_sleep(6);")
      await ask(title, "mail-cut-1", {}, 2500)
      expect(await openLinks(title)).toHaveLength(0)
      expect((await crsOf(title)).map((c) => c.status)).toEqual(["draft"])
      // The retry waits for the write it finds under way, and adds nothing to it.
      await ask(title, "mail-cut-1")
      await until(async () => (await openLinks(title)).length === 1)
      const after = await ask(title, "mail-cut-1")
      expect(after).toContain("CHANGE_REQUEST_ALREADY_SENT")
      expect(after).toContain("whether its reply left is not known")
      // Nor does another mail's change request go out beside it.
      expect(await ask("Beside it", "mail-cut-1b")).toContain("CHANGE_REQUEST_ALREADY_SENT")
      expect(await crsOf("Beside it")).toEqual([])
      const crs = await crsOf(title)
      expect(crs.map((c) => c.status)).toEqual(["draft"])
      expect(await openLinks(title)).toHaveLength(1)
      await until(async () => linkMails(mailsAt).length > 0)
      expect(linkMails(mailsAt)).toHaveLength(1)
      expect(smtpSent.length).toBe(repliesAt)
      // A void withdraws its link and frees the mail.
      const voided = await asPerson(w.admin.userId, "agreement_void", {
        id: crs[0]?.id,
        reason: "Start over",
      })
      expect(voided.data?.status).toBe("ok")
      expect(await openLinks(title)).toHaveLength(0)
      await owner.unsafe("DROP TRIGGER IF EXISTS cut_cr_test ON kernel.client_actions")
      await ask(title, "mail-cut-1")
      expect((await crsOf(title)).map((c) => c.status).sort()).toEqual(["sent", "voided"])
      expect(await openLinks(title)).toHaveLength(1)
      expect(smtpSent.length).toBe(repliesAt + 1)
      // One mail has one change request that can be accepted: the database holds it to that.
      const [sent] = (await crsOf(title)).filter((c) => c.status === "sent")
      const second = owner.unsafe(
        insertSql("app_agreements.agreements", {
          org_id: w.orgId,
          number: "CR-99",
          kind: "change_request",
          status: "draft",
          title,
          send_key: {
            raw: `(SELECT send_key FROM app_agreements.agreements WHERE id = '${sent?.id}')`,
          },
        }),
      )
      await expect(
        second.then(
          () => "written",
          (e: { code?: string }) => e.code,
        ),
      ).resolves.toBe("23505")
    }, 120_000)

    it("before its link, then asked with other hours: only the new one can be accepted", async () => {
      const title = "Asked again with other hours"
      await whileLinkIsWritten("RAISE EXCEPTION 'no link now';")
      await ask(title, "mail-cut-2")
      expect((await crsOf(title)).map((c) => c.status)).toEqual(["draft"])
      await owner.unsafe("DROP TRIGGER IF EXISTS cut_cr_test ON kernel.client_actions")
      await ask(title, "mail-cut-2", { hours_minutes: 120 })
      expect((await crsOf(title)).map((c) => [c.status, c.hours_minutes]).sort()).toEqual([
        ["sent", 120],
        ["voided", 60],
      ])
      expect(await openLinks(title)).toHaveLength(1)
    }, 120_000)

    it("before its link, then asked again the same: it is the one that goes out", async () => {
      const title = "Asked again the same"
      await whileLinkIsWritten("RAISE EXCEPTION 'no link now';")
      await ask(title, "mail-cut-3")
      await owner.unsafe("DROP TRIGGER IF EXISTS cut_cr_test ON kernel.client_actions")
      const [first] = await crsOf(title)
      await ask(title, "mail-cut-3")
      expect(await crsOf(title)).toEqual([{ ...first, status: "sent" } as never])
      expect(await openLinks(title)).toHaveLength(1)
      expect(await ask(title, "mail-cut-3")).toContain("CHANGE_REQUEST_ALREADY_SENT")
    }, 120_000)
  })

  it("a change request on a restricted agreement takes its list: a member off it reads the change request as a random id, and its link is the list's alone", async () => {
    const closedParent = crypto.randomUUID()
    const closedVersion = crypto.randomUUID()
    await withPrivilegedDb(w.orgId, "test:change-request-closed-parent", async (tx) => {
      await insertAppRow(tx, "agreements", "agreements", {
        org_id: w.orgId,
        id: closedParent,
        number: "AG-2026-015",
        kind: "sow",
        status: "signed",
        title: "Closed takeover review",
        company_id: w.companyA,
        contact_id: w.clientA.contactId,
        currency: "EUR",
        price_minor: "4200000",
        org_access: "none",
        created_by_user_id: w.admin.userId,
      })
      await insertAppRow(tx, "agreements", "agreement_shares", {
        org_id: w.orgId,
        agreement_id: closedParent,
        user_id: w.admin.userId,
        role: "editor",
      })
      await insertAppRow(tx, "agreements", "agreement_versions", {
        org_id: w.orgId,
        id: closedVersion,
        agreement_id: closedParent,
        number: 1,
        status: "signed",
        sha256: SHA,
        source_text: "1. Scope\nA review.\n8.2 Extra work is billed at 100.00 EUR per hour.",
        frozen_at: new Date().toISOString(),
      })
    })
    // The reply cannot leave (no mailbox for that conversation): the change request stays a
    // draft, written, frozen and its link minted then withdrawn, which is all this needs.
    await asPerson(w.admin.userId, "change_request_send", {
      parent_agreement_id: closedParent,
      title: "Extra review",
      work: ["A second review round"],
      hours_minutes: 600,
      hours_source: "past similar work",
      rate_minor: "10000",
      reply: { conversation_id: crypto.randomUUID(), body: "Here is a change request." },
      passage: { version_id: closedVersion, section: "8.2" },
      mail_message_id: "mail-2",
    })
    const [cr] = (await sql`
      SELECT id, org_access FROM ${app("agreements")}
       WHERE org_id = ${w.orgId} AND parent_agreement_id = ${closedParent}`) as unknown as Array<{
      id: string
      org_access: string
    }>
    expect(cr?.org_access).toBe("none")
    const shape = (out: Out, id: string) => ({
      data: out.data === undefined,
      code: out.error?.code,
      message: out.error?.message.replaceAll(id, "<id>"),
    })
    const random = crypto.randomUUID()
    expect(
      shape(await asPerson(w.member.userId, "agreement_get", { id: cr?.id ?? "" }), cr?.id ?? ""),
    ).toEqual(shape(await asPerson(w.member.userId, "agreement_get", { id: random }), random))
    const links = (await sql`
      SELECT a.visible_to FROM ${kernel("client_actions")} a
        JOIN ${app("agreement_versions")} v ON v.id = a.target_id
       WHERE a.org_id = ${w.orgId} AND v.agreement_id = ${cr?.id ?? ""}`) as unknown as Array<{
      visible_to: string[] | null
    }>
    expect(links.length).toBeGreaterThan(0)
    for (const l of links) expect(l.visible_to).toEqual([w.admin.userId])
  }, 120_000)
})
