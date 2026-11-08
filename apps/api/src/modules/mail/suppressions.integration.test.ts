// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Opt-outs end to end: the mail tools record, check and lift them; waiting commercial drafts are
// withdrawn; the send check refuses commercial mail to them at send; the list keeps no address;
// the person's and the member's data exports say what it holds.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { z } from "zod"
import { sql } from "~/db"
import { type UserContext, withRlsContext } from "~/db/rls"
import { DurableConsumersTestAccess } from "~/infra/events/durable-consumers"
import * as eventBusModule from "~/infra/events/event-bus"
import { initEventBus, onEvent, resetEventBus } from "~/infra/events/event-bus"
import { registerEventSubscribers } from "~/infra/events/event-subscribers"
import * as jobsModule from "~/infra/jobs/jobs"
import { decideApproval } from "~/modules/approvals/decide"
import * as withdrawModule from "~/modules/approvals/withdraw-on-events"
import { handleWithdrawOnEvent, OPTED_OUT_REASON } from "~/modules/approvals/withdraw-on-events"
import { appBridgeManifestRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { executeToolCore } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { SandboxBridgeTestAccess } from "~/modules/apps/sandbox/bridge/shared"
import { initSandboxPool, shutdownSandboxPool } from "~/modules/apps/sandbox/pool"
import { deleteContact } from "~/modules/contacts/service"
import { buildDataSubjectBundle } from "~/modules/export/data-subject-export-tool"
import { readMemberSections } from "~/modules/export/member-data-subject-bundle"
import { hashEmail, suppressedAmong } from "~/modules/mail/suppressions"
import { seedContext } from "~/seed/context"
import { seedApprovalRequests } from "~/seed/factories/approvals/requests"
import { resolveContacts } from "~/seed/factories/people/contacts"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { drainOutbox } from "~/tests/helpers/outbox"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { ensureMailAccount } from "../../../test-support/seed/mail"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})
const jobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(async () => "job-id" as never)

let orgId = ""
let userId = ""
let admin: UserContext
let threadId = ""
let account = ""
const sent: Array<Record<string, unknown>> = []
let counter = 0
const unique = (name: string) => `${name}-${++counter}@client.test`

type Envelope = Awaited<ReturnType<typeof executeToolCore>>

function call(toolName: string, params: Record<string, unknown>, actor: UserContext = admin) {
  return executeToolCore({ toolName, orgId, actor, params, threadId, origin: "in-app-agent" })
}

function resultOf(envelope: Envelope): Record<string, any> {
  if (!("data" in envelope)) throw new Error(`no result: ${JSON.stringify(envelope)}`)
  return envelope.data as Record<string, any>
}

/** A refusal the tool answered with: its code and message. */
function refusalOf(envelope: Envelope): { code: string; message: string } {
  if (!("error" in envelope)) throw new Error(`not refused: ${JSON.stringify(envelope)}`)
  return envelope.error as { code: string; message: string }
}

const blockedId = (envelope: Envelope): string => {
  if (!("blocked" in envelope)) throw new Error(`not staged: ${JSON.stringify(envelope)}`)
  return envelope.blocked.approvalRequestId as string
}

/** A commercial follow-up, or a service message about an invoice when `service` is set. */
async function stageCompose(to: string, service = false): Promise<string> {
  const followUp = service
    ? { classification: "service", refs: [{ kind: "fixture:invoice", id: "1" }] }
    : {}
  return blockedId(
    await call("mail:compose", {
      accountId: account,
      to: [to],
      subject: "Checking in",
      textBody: "Any news on the order?",
      followUp,
    }),
  )
}

const approve = (requestId: string, actor: UserContext = admin) =>
  decideApproval({ orgId, requestId, actor, decision: "approve" })

async function approveSettled(requestId: string): Promise<void> {
  try {
    await approve(requestId)
  } catch {
    // The outcome is read from the rows.
  }
}

async function requestRow(requestId: string) {
  const [row] = await sql<Array<{ status: string; reason: string | null; summary: any }>>`
    SELECT status, reason, summary FROM kernel.approval_requests WHERE id = ${requestId}`
  if (!row) throw new Error("no request")
  return row
}

beforeAll(async () => {
  await acquireTestLock()
  await initSandboxPool()
  resetEventBus()
  initEventBus()
  DurableConsumersTestAccess.reset()
  registerEventSubscribers({
    bufferAndBroadcast: async () => {},
    broadcast: async () => {},
    closeConnectionsForUser: () => {},
  } as never)
  // The withdrawal subscriber, as event-subscribers.ts registers it.
  onEvent(handleWithdrawOnEvent, { delivery: "once", name: "suppression-withdraw-drafts" })
  const a = await bootstrapAdminCtx()
  orgId = a.orgId
  userId = a.userId
  admin = a.actor
  threadId = await minimal.thread(orgId, userId)
  await ensureAppsForOrg(orgId)
  SandboxBridgeTestAccess.setSmtpSend(async (_connection, _identifier, message) => {
    sent.push(message as Record<string, unknown>)
    return { messageId: `<sent-${sent.length}@org.test>`, deliveryState: "delivered" }
  })
  const ctx = seedContext({ orgId, now: new Date() })
  account = (
    await ensureMailAccount(ctx, {
      ownerType: "org",
      userId,
      email: "sales@org.test",
      provider: "imap",
    })
  ).accountId
  // An invoice is a service record: mail about it is not commercial.
  appBridgeManifestRegistry.set([orgId, "fixture"], {
    name: "fixture",
    sendGuardProviders: { "fixture:invoice": { tool: "invoice_state", serviceMessage: true } },
  })
  toolRegistry.set([orgId, "fixture", "invoice_state"], {
    appName: "fixture",
    name: "invoice_state",
    description: "Fixture provider.",
    requiredScopes: ["fixture:read"],
    readOnly: true,
    params: z.object({ ref: z.object({ kind: z.string(), id: z.string() }) }),
    handler: async () => ({ stop: false }),
  })
  await drainOutbox()
}, 120_000)

afterAll(async () => {
  SandboxBridgeTestAccess.setSmtpSend(null)
  broadcastSpy.mockRestore()
  jobSpy.mockRestore()
  resetEventBus()
  await shutdownSandboxPool()
  await releaseTestLock()
})

describe("opt-outs", () => {
  it("adding a suppression withdraws pending commercial drafts to it and the guard refuses later sends, while a service message still goes", async () => {
    const to = unique("stop")
    const commercial = await stageCompose(to)
    const service = await stageCompose(to, true)
    const other = await stageCompose(unique("other"))

    const added = resultOf(await call("mail:suppression_add", { email: to }))
    expect(added.withdrawn).toBe(1)
    expect(added.message).toContain(`${to} is opted out of commercial mail`)
    expect(added.message).toContain("1 waiting commercial draft was withdrawn")
    expect(await requestRow(commercial)).toMatchObject({
      status: "cancelled",
      reason: OPTED_OUT_REASON,
    })
    expect((await requestRow(service)).status).toBe("pending")
    expect((await requestRow(other)).status).toBe("pending")

    // A later commercial draft to them is refused at stage.
    const later = await call("mail:compose", {
      accountId: account,
      to: [to],
      subject: "One more",
      textBody: "Still interested?",
      followUp: {},
    })
    expect("error" in later && later.error.code).toBe("SEND_GUARD_OPTED_OUT")

    // The service message goes.
    const before = sent.length
    await approve(service)
    expect(sent.length).toBe(before + 1)

    // Recording it again changes nothing and says so.
    const again = resultOf(await call("mail:suppression_add", { email: to.toUpperCase() }))
    expect(again.alreadyOptedOut).toBe(true)
    expect(again.message).toContain("Nothing changed")
  }, 90_000)

  it("an opt-out recorded elsewhere withdraws the waiting drafts through the event", async () => {
    const to = unique("event")
    const commercial = await stageCompose(to)
    // The request's own withdrawal is lost: the subscriber does it once the event is out.
    const spy = spyOn(withdrawModule, "withdrawCommercialDraftsTo").mockImplementationOnce(
      async () => [],
    )
    try {
      resultOf(await call("mail:suppression_add", { email: to, reason: "reply" }))
    } finally {
      spy.mockRestore()
    }
    expect((await requestRow(commercial)).status).toBe("pending")
    await drainOutbox()
    expect(await requestRow(commercial)).toMatchObject({
      status: "cancelled",
      reason: OPTED_OUT_REASON,
    })
  }, 90_000)

  it("a suppression survives the contact's erasure and a new contact with that address is suppressed", async () => {
    const email = unique("erased")
    const ctx = seedContext({ orgId, now: new Date() })
    const [[, first]] = (await resolveContacts(ctx, admin, [
      { key: "a", email, name: "Erased Person" },
    ])) as Array<[string, { id: string }]>
    resultOf(await call("mail:suppression_add", { email }))
    await withRlsContext(admin, (tx) => deleteContact(tx, { orgId, userId, contactId: first.id }))
    expect(await sql`SELECT 1 FROM kernel.contacts WHERE id = ${first.id}`).toHaveLength(0)
    const [[, second]] = (await resolveContacts(ctx, admin, [
      { key: "b", email, name: "Same Address" },
    ])) as Array<[string, { id: string }]>
    expect(second.id).not.toBe(first.id)
    expect(await suppressedAmong(orgId, [email])).toEqual([email])
    const later = await call("mail:compose", {
      accountId: account,
      to: [email],
      subject: "Hello again",
      textBody: "New offer",
      followUp: {},
    })
    expect("error" in later && later.error.code).toBe("SEND_GUARD_OPTED_OUT")
  }, 90_000)

  it("no stored value equals the address", async () => {
    const email = unique("Fingerprint")
    resultOf(await call("mail:suppression_add", { email, source: "msg-1" }))
    const rows = await sql<Array<{ row: string }>>`
      SELECT row_to_json(s)::text AS row FROM kernel.suppressions s WHERE org_id = ${orgId}`
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) {
      expect(r.row.toLowerCase()).not.toContain(email.toLowerCase())
      expect(r.row.toLowerCase()).not.toContain("@client.test")
    }
    expect(rows.some((r) => r.row.includes(hashEmail(orgId, email)))).toBe(true)
    // A source carrying an address is refused.
    const refused = refusalOf(
      await call("mail:suppression_add", { email: unique("src"), source: "someone@client.test" }),
    )
    expect(refused.code).toBe("invalid_params")
    expect(refused.message).toContain("Nothing was recorded")
  }, 90_000)

  it("bulk approval of five follow-ups with one suppressed sends four and fails one with no effect", async () => {
    const people = [1, 2, 3, 4, 5].map(() => unique("bulk"))
    const ids: string[] = []
    for (const to of people) ids.push(await stageCompose(to))
    // The opt-out lands with its withdrawal lost, so the check at send is what stops it.
    const spy = spyOn(withdrawModule, "withdrawCommercialDraftsTo").mockImplementation(
      async () => [],
    )
    try {
      resultOf(await call("mail:suppression_add", { email: people[2] }))
    } finally {
      spy.mockRestore()
    }
    const before = sent.length
    for (const id of ids) await approveSettled(id)
    expect(sent.length).toBe(before + 4)
    const recipients = sent.slice(before).map((m) => JSON.stringify(m))
    expect(recipients.some((m) => m.includes(people[2] as string))).toBe(false)
    const stopped = await requestRow(ids[2] as string)
    expect(stopped.status).toBe("cancelled")
    const [execution] = await sql<Array<{ status: string; error: any }>>`
      SELECT status, error FROM kernel.approved_handler_executions
       WHERE approval_request_id = ${ids[2] as string}`
    expect(execution?.status).toBe("failed_no_effect")
    expect(execution?.error?.code).toBe("send_guard_opted_out")
  }, 120_000)

  it("removing a suppression parks with who opted out and when, and approving lets the guard pass", async () => {
    const email = unique("lift")
    resultOf(await call("mail:suppression_add", { email }))
    const parked = await call("mail:suppression_remove", { email })
    const id = blockedId(parked)
    const card = await requestRow(id)
    const lines = JSON.stringify(card.summary)
    expect(lines).toContain(`Let ${email} receive commercial mail again`)
    expect(lines).toMatch(/Opted out on \d{1,2} [A-Z][a-z]{2} \d{4}, by /)
    expect(await suppressedAmong(orgId, [email])).toEqual([email])
    await approve(id)
    expect(await suppressedAmong(orgId, [email])).toEqual([])
    const staged = await stageCompose(email)
    expect((await requestRow(staged)).status).toBe("pending")
  }, 90_000)

  it("the check answers 50 addresses and refuses 51", async () => {
    const fifty = Array.from({ length: 50 }, () => unique("many"))
    resultOf(await call("mail:suppression_add", { email: fifty[7] }))
    const ok = resultOf(await call("mail:suppression_check", { emails: fifty }))
    expect(ok.checked).toBe(50)
    expect(ok.results.filter((r: { optedOut: boolean }) => r.optedOut)).toHaveLength(1)
    expect(ok.message).toContain(`1 of 50 opted out: ${fifty[7]}`)
    const refused = refusalOf(
      await call("mail:suppression_check", { emails: [...fifty, unique("one-more")] }),
    )
    expect(refused.code).toBe("too_many_addresses")
    expect(refused.message).toContain("Nothing was checked")
  }, 90_000)

  it("the check gives no reason to an agent without the scope", async () => {
    const email = unique("reason")
    resultOf(await call("mail:suppression_add", { email, reason: "reply", source: "msg-9" }))
    const full = resultOf(await call("mail:suppression_check", { emails: [email] }))
    expect(full.results[0]).toMatchObject({ optedOut: true, by: "reply" })
    expect(full.results[0].line).toContain("by a reply asking to stop")
    const limited: UserContext = {
      ...admin,
      scopes: ["mail:conversations:read", "mail:conversations:write"],
    }
    const bare = resultOf(await call("mail:suppression_check", { emails: [email] }, limited))
    expect(bare.results[0]).toEqual({ email, optedOut: true })
  }, 90_000)

  it("approving a reply's proposal adds the suppression, by a seeded admin with no fixture grant", async () => {
    const email = unique("proposal")
    const ctx = seedContext({ orgId, now: new Date() })
    const [id] = await seedApprovalRequests(ctx, [
      {
        id: crypto.randomUUID(),
        handle: `AP-${counter}`,
        threadId,
        toolName: "mail:suppression_add",
        payload: { email, reason: "reply", source: "msg-proposal" },
        requestedBy: userId,
        agentId: null,
        notifyUserIds: [userId],
        status: "pending",
        createdAt: new Date(),
      },
    ])
    // The org's own admin, from its default roles: no scope added by this test.
    expect(admin.scopes).not.toContain("mail:conversations:write")
    await approve(id as string)
    expect(await suppressedAmong(orgId, [email])).toEqual([email])
    const [row] = await sql<Array<{ reason: string; source: string }>>`
      SELECT reason, source FROM kernel.suppressions
       WHERE org_id = ${orgId} AND email_hash = ${hashEmail(orgId, email)}`
    expect(row).toMatchObject({ reason: "reply", source: "msg-proposal" })
  }, 90_000)

  it("a contact's export says when and how they opted out", async () => {
    const email = unique("export")
    const ctx = seedContext({ orgId, now: new Date() })
    const [[, contact]] = (await resolveContacts(ctx, admin, [
      { key: "x", email, name: "Exported Person" },
    ])) as Array<[string, { id: string }]>
    const before = await withRlsContext(admin, (tx) =>
      buildDataSubjectBundle(contact.id, { orgId, userId, db: tx }),
    )
    expect("subject" in before && before.subject.optedOut).toBeNull()
    resultOf(await call("mail:suppression_add", { email, reason: "reply" }))
    const bundle = await withRlsContext(admin, (tx) =>
      buildDataSubjectBundle(contact.id, { orgId, userId, db: tx }),
    )
    if (!("subject" in bundle)) throw new Error(JSON.stringify(bundle))
    expect(bundle.subject.optedOut?.by).toBe("reply")
    expect(bundle.subject.optedOut?.line).toMatch(
      /^Opted out on \d{1,2} [A-Z][a-z]{2} \d{4}, by a reply asking to stop\.$/,
    )
  }, 90_000)

  it("a member's bundle lists the suppressions they added", async () => {
    const sections = await withRlsContext(admin, (tx) =>
      readMemberSections(tx, { orgId, subjectUserId: userId }),
    )
    const added = sections.suppressionsAdded
    expect(added?.rows.length).toBeGreaterThan(3)
    for (const r of added?.rows ?? []) {
      expect(Object.keys(r).sort()).toEqual(["created_at", "reason"])
      expect(JSON.stringify(r)).not.toContain("@")
    }
    expect(added?.note).toContain("not kept")
  }, 90_000)
})
