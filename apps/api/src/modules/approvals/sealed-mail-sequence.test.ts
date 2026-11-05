// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sequenced mail send from an end-to-end encrypted personal mailbox: "issue
// the document, then reply with it attached". The reply step is staged as a
// deferred dependent of the head. Its draft must be sealed at rest exactly like
// a single approval's (Invariant K), and since only the mailbox owner's
// unlocked browser can make it executable, approving the head must NOT run it
// server side (it used to, and failed, which cancelled the reply). It becomes
// the owner's own pending decision with the attachment @ref already resolved,
// and approving that with a fulfilment sends it and continues the sequence.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import * as jobsModule from "~/infra/jobs/jobs"
import { decideApproval } from "~/modules/approvals/decide"
import { recordStarted, recordSucceeded } from "~/modules/approvals/handler-protocol"
import { approvalResourceOwnerRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { createSequencedApprovalStep, executeTool } from "~/modules/apps/execute-tool"
import { TestKeyring } from "~/modules/mailbox-keys/__fixtures__/keyring"
import { enrollKeyring } from "~/modules/mailbox-keys/service"
import { seedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { ensureMailAccount, seedMailConversation } from "../../../test-support/seed/mail"

const enqueueAppJobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (_appName: string, jobName: string) =>
    `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
let ORG = ""
let USER = ""
let THREAD = ""
let CONVERSATION = ""
const PDF_FILE = "00000000-0000-4000-8000-0000000a7106"
const SCOPES = [
  "sealed_seq:write",
  "sealed_seq:approve",
  "mail:conversations:write",
  "mail:approve",
]
let actor: ActorContext & UserContext

/** What the reply handler was handed, per execution. */
const replyCalls: Array<Record<string, unknown>> = []

async function recordSelf(toolName: string, result: Record<string, unknown>) {
  const [row] = await sql`SELECT id, decided_by FROM kernel.approval_requests
    WHERE org_id = ${ORG} AND tool_name = ${toolName} AND status = 'approving' LIMIT 1`
  const ctx = { orgId: ORG, approvalRequestId: row.id, approvalDeciderId: row.decided_by, toolName }
  await withPrivilegedDb(ORG, "sealed-seq-rec", (tx) => recordStarted(tx, ctx, toolName))
  await withPrivilegedDb(ORG, "sealed-seq-rec", (tx) => recordSucceeded(tx, ctx, toolName, result))
}

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await createTestOrg()).id
  const owner = await minimal.person(ORG, { name: "Owner" })
  USER = owner.id
  for (const scope of SCOPES) await minimal.grantScope(USER, scope)
  actor = { actorType: "user", userId: USER, orgId: ORG, scopes: SCOPES, dimensionGrants: {} }
  THREAD = await minimal.thread(ORG, USER, { title: "Sealed sequence" })

  // A personal mailbox owned by USER, with one conversation, seeded while the
  // mailbox is still unarmed (the seed writes its envelope in plaintext).
  const ctx = seedContext({ orgId: ORG, now: new Date() })
  const { accountId } = await ensureMailAccount(ctx, {
    ownerType: "user",
    userId: USER,
    email: "owner@sealed-seq.test",
    provider: "gmail",
  })
  CONVERSATION = (
    await seedMailConversation(ctx, {
      accountId,
      subject: "Your order",
      status: "open",
      labels: [],
      isRead: false,
      isStarred: false,
      messageCount: 1,
      messages: [],
    })
  ).conversationId

  // The owner enrols a keyring the way the browser does: that makes the
  // mailbox end-to-end encrypted, sealed to this identity from now on.
  const keyring = await new TestKeyring(USER).enrollPayload(1)
  const ownerActor = await actorFor(ctx, USER)
  await asUser(ownerActor, (tx) =>
    enrollKeyring(tx as never, USER, ORG, {
      ...keyring,
      wraps: [
        {
          wrapType: "passphrase",
          label: "Mailbox password",
          wrappedAccountKey: Buffer.from("wrapped-under-the-password").toString("base64"),
          kdfParams: { salt: "c2FsdA==" },
        },
      ],
    }),
  )
  await withSystemDb("sealed-seq-fixture", (tx) =>
    tx.execute(drizzleSql`UPDATE ${MAIL}.accounts SET encryption_state = 'ready'
      WHERE id = ${accountId}::uuid`),
  )

  approvalResourceOwnerRegistry.set([ORG, "mail", "reply"], {
    table: "conversations",
    param: "conversationId",
    account: { table: "accounts", column: "account_id" },
  } as never)
  toolRegistry.set([ORG, "sealed_seq", "issue"], {
    appName: "sealed_seq",
    name: "issue",
    description: "issues a document",
    requiredScopes: ["sealed_seq:write"],
    gated: true,
    referenceableOutputs: ["pdf_file_id", "number"],
    handler: async () => {
      const r = { pdf_file_id: PDF_FILE, number: "PF-0042" }
      await recordSelf("sealed_seq:issue", r)
      return r
    },
  } as never)
  // Stands in for the mail app's reply handler: records what it was handed.
  toolRegistry.set([ORG, "mail", "reply"], {
    appName: "mail",
    name: "reply",
    description: "reply",
    requiredScopes: ["mail:conversations:write"],
    gated: true,
    referenceableOutputs: ["sent"],
    handler: async (p: Record<string, unknown>) => {
      replyCalls.push(p)
      const r = { sent: true }
      await recordSelf("mail:reply", r)
      return r
    },
  } as never)
  toolRegistry.set([ORG, "sealed_seq", "after"], {
    appName: "sealed_seq",
    name: "after",
    description: "runs after the reply",
    requiredScopes: ["sealed_seq:write"],
    gated: true,
    handler: async () => {
      const r = { done: true }
      await recordSelf("sealed_seq:after", r)
      return r
    },
  } as never)
}, 60_000)

afterEach(async () => {
  replyCalls.length = 0
  await sql`DELETE FROM kernel.approved_handler_executions WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.messages WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.approval_requests WHERE org_id = ${ORG}`
})

afterAll(async () => {
  enqueueAppJobSpy.mockRestore()
  toolRegistry.deleteByPrefix([ORG])
  approvalResourceOwnerRegistry.deleteByPrefix([ORG])
  await withSystemDb("sealed-seq-cleanup", async (tx) => {
    await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${ORG}::uuid`)
    await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${ORG}::uuid`)
    await tx.execute(drizzleSql`DELETE FROM kernel.user_key_wraps WHERE user_id = ${USER}::uuid`)
    await tx.execute(
      drizzleSql`DELETE FROM kernel.mailbox_migration_state WHERE user_id = ${USER}::uuid`,
    )
    await tx.execute(
      drizzleSql`DELETE FROM kernel.user_mailbox_identities WHERE user_id = ${USER}::uuid`,
    )
  })
  await releaseTestLock()
})

async function rowOf(id: string) {
  const [r] = await sql`SELECT status, tool_params, current_payload, resource_owner_id,
      notify_user_ids, metadata
    FROM kernel.approval_requests WHERE id = ${id}`
  return r as {
    status: string
    tool_params: Record<string, unknown>
    current_payload: Record<string, unknown>
    resource_owner_id: string | null
    notify_user_ids: string[]
    metadata: Record<string, unknown> | null
  }
}

/** Head (issue the document) -> reply with it attached -> one more step. */
async function stageSequence() {
  const head = await executeTool({
    toolName: "sealed_seq:issue",
    orgId: ORG,
    actor,
    params: { kind: "proforma" },
    origin: "in-app-agent",
    threadId: THREAD,
  })
  const headId = head.blocked!.approvalRequestId!
  // The head of a sequence carries its own bundle (resolveBundleForRefs).
  await sql`UPDATE kernel.approval_requests SET bundle_id = id, bundle_position = 0
    WHERE id = ${headId}`
  const step = (toolName: string, toolParams: Record<string, unknown>, dependsOnId: string) =>
    createSequencedApprovalStep({
      orgId: ORG,
      threadId: THREAD,
      toolName,
      toolParams,
      requestedBy: USER,
      summary: { title: toolName } as never,
      appName: toolName.split(":")[0] as string,
      toolShortName: toolName.split(":")[1] as string,
      approveScope: `${toolName.split(":")[0]}:approve`,
      bundle: { bundleId: headId, dependsOnId, position: -1 },
    })
  const replyId = await step(
    "mail:reply",
    {
      conversationId: CONVERSATION,
      subject: "SEALEDSUBJECTNONCE",
      textBody: "SEALEDBODYNONCE here is your proforma",
      attachments: [`@ref:${headId}:pdf_file_id`],
    },
    headId,
  )
  const afterId = await step("sealed_seq:after", { note: "after" }, replyId)
  return { headId, replyId, afterId }
}

describe("sequenced mail send from an encrypted personal mailbox", () => {
  it("stores the deferred reply sealed, never as cleartext", async () => {
    const { replyId } = await stageSequence()
    const row = await rowOf(replyId)
    expect(row.status).toBe("deferred")
    for (const payload of [row.tool_params, row.current_payload]) {
      expect(payload.mailboxSealed).toBe(true)
      expect(typeof payload.bodyCiphertext).toBe("string")
      expect(JSON.stringify(payload)).not.toContain("SEALEDBODYNONCE")
      expect(JSON.stringify(payload)).not.toContain("SEALEDSUBJECTNONCE")
      // The envelope stays cleartext: the target and the attachment reference.
      expect(payload.conversationId).toBe(CONVERSATION)
    }
    const events = await sql`SELECT payload::text AS p FROM kernel.pending_events
      WHERE org_id = ${ORG} AND payload::text LIKE ${`%${replyId}%`}`
    for (const e of events) expect(String(e.p)).not.toContain("SEALEDBODYNONCE")
  })

  it("approving the head makes the reply the owner's pending decision, then a fulfilled approve sends it", async () => {
    const { headId, replyId, afterId } = await stageSequence()

    await decideApproval({ orgId: ORG, requestId: headId, actor, decision: "approve" })

    expect((await rowOf(headId)).status).toBe("approved")
    const pending = await rowOf(replyId)
    // Not cancelled and not executed: waiting for the owner's browser.
    expect(pending.status).toBe("pending")
    expect(replyCalls).toHaveLength(0)
    expect(pending.resource_owner_id).toBe(USER)
    expect(pending.notify_user_ids).toEqual([USER])
    expect(pending.metadata?.executionFailure).toBeUndefined()
    // The attachment reference is resolved to the real file, still sealed.
    expect(pending.current_payload.attachments).toEqual([PDF_FILE])
    expect(pending.current_payload.mailboxSealed).toBe(true)
    expect(JSON.stringify(pending.current_payload)).not.toContain("SEALEDBODYNONCE")
    // The step after it keeps waiting.
    expect((await rowOf(afterId)).status).toBe("deferred")
    const [notice] = await sql`SELECT metadata FROM kernel.messages
      WHERE org_id = ${ORG} AND metadata->>'type' = 'approval-created'
        AND metadata->>'requestId' = ${replyId}`
    expect(notice).toBeDefined()

    // Approving without the decrypted draft is refused before anything runs.
    await expect(
      decideApproval({ orgId: ORG, requestId: replyId, actor, decision: "approve" }),
    ).rejects.toMatchObject({ code: "mailbox_fulfilment_required" })
    expect((await rowOf(replyId)).status).toBe("pending")

    // The owner's unlocked browser supplies the draft: it sends, with the file.
    await decideApproval({
      orgId: ORG,
      requestId: replyId,
      actor,
      decision: "approve",
      mailboxFulfilment: {
        draft: { subject: "Re: your order", textBody: "here is your proforma" },
      },
    })
    expect(replyCalls).toHaveLength(1)
    const sent = replyCalls[0] as Record<string, unknown>
    expect(sent.textBody).toBe("here is your proforma")
    expect(sent.subject).toBe("Re: your order")
    expect(sent.attachments).toEqual([PDF_FILE])
    expect(sent.bodyCiphertext).toBeUndefined()
    expect(sent.mailboxSealed).toBeUndefined()
    expect((await rowOf(replyId)).status).toBe("approved")
    // The sequence continues past the reply.
    expect((await rowOf(afterId)).status).toBe("approved")
    // The row on disk still holds ciphertext, never the sent text.
    expect(JSON.stringify((await rowOf(replyId)).current_payload)).not.toContain(
      "here is your proforma",
    )
  })

  it("fills @ref tokens the agent wrote inside the sealed body from the decrypted draft", async () => {
    const { headId, replyId } = await stageSequence()
    await decideApproval({ orgId: ORG, requestId: headId, actor, decision: "approve" })
    expect((await rowOf(replyId)).status).toBe("pending")

    // A token naming a request outside the sequence is refused, not sent.
    await expect(
      decideApproval({
        orgId: ORG,
        requestId: replyId,
        actor,
        decision: "approve",
        mailboxFulfilment: {
          draft: { textBody: `See @ref:${crypto.randomUUID()}:number` },
        },
      }),
    ).rejects.toMatchObject({ code: "invalid_mailbox_fulfilment" })
    expect(replyCalls).toHaveLength(0)
    expect((await rowOf(replyId)).status).toBe("pending")

    await decideApproval({
      orgId: ORG,
      requestId: replyId,
      actor,
      decision: "approve",
      mailboxFulfilment: {
        draft: {
          subject: `Proforma @ref:${headId}:number`,
          textBody: `The proforma is number @ref:${headId}:number.`,
        },
      },
    })
    const sent = replyCalls[0] as Record<string, unknown>
    expect(sent.textBody).toBe("The proforma is number PF-0042.")
    expect(sent.subject).toBe("Proforma PF-0042")
    expect(JSON.stringify(sent)).not.toContain("@ref:")
  })

  it("denying the waiting reply cancels the steps behind it", async () => {
    const { headId, replyId, afterId } = await stageSequence()
    await decideApproval({ orgId: ORG, requestId: headId, actor, decision: "approve" })
    expect((await rowOf(replyId)).status).toBe("pending")
    await decideApproval({ orgId: ORG, requestId: replyId, actor, decision: "deny", reason: "no" })
    expect((await rowOf(replyId)).status).toBe("denied")
    expect((await rowOf(afterId)).status).toBe("cancelled")
  })
})
