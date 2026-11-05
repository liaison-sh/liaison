// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Editing a pending mail send drafted from an end-to-end encrypted personal
// mailbox (Invariant K). The draft is stored sealed to the mailbox owner, and the
// owner's browser decrypts it to show it on the card and to send it on approval.
// An edit of its body used to merge the new text into the payload as PLAINTEXT
// next to the untouched ciphertext: the card and the send kept the old body
// while the agent reported the draft updated, and the new text sat at rest in
// the approval row and in the edit diff. An edit now seals the new body again,
// the same way the draft was sealed when it was staged, and stores no plaintext.

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { openField, unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { sql as drizzleSql } from "drizzle-orm"
import { summarizeMailCompose, summarizeMailReply } from "~/apps/mail/summarizers"
import { sql } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import type { ActorContext, UserContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import * as jobsModule from "~/infra/jobs/jobs"
import { redactMailToolArgs } from "~/modules/agent/mailbox-plaintext/mail-plaintext-redaction"
import { decideApproval } from "~/modules/approvals/decide"
import { updatePayload } from "~/modules/approvals/edit"
import { recordStarted, recordSucceeded } from "~/modules/approvals/handler-protocol"
import {
  approvalDedupeKeyRegistry,
  approvalDedupeSameRequesterRegistry,
  approvalEditableFieldsRegistry,
  approvalResourceOwnerRegistry,
  approvalSummarizerRegistry,
  toolRegistry,
} from "~/modules/apps/app-registries"
import { registerApprovalSummarizer } from "~/modules/apps/approval-summarizers"
import { executeTool } from "~/modules/apps/execute-tool"
import {
  isManagedApprovalPayload,
  openManagedApprovalPayload,
} from "~/modules/mailbox-crypto/managed-approval"
import { TestKeyring } from "~/modules/mailbox-keys/__fixtures__/keyring"
import { enrollKeyring } from "~/modules/mailbox-keys/service"
import { seedContext } from "~/seed/context"
import { actorFor, asUser } from "~/seed/factories/people/actors"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import { ensureMailAccount, seedMailConversation } from "../../../test-support/seed/mail"
import mailManifest from "../../apps/mail/app.manifest.json"

type MailToolDecl = {
  params: unknown
  editableFields: unknown
  resourceOwner: unknown
  approvalDedupeKeyParam?: string
  approvalDedupeSameRequester?: boolean
}
const MAIL_TOOLS = (mailManifest as unknown as { tools: Record<string, MailToolDecl> }).tools

const enqueueAppJobSpy = spyOn(jobsModule, "enqueueAppJob").mockImplementation(
  (async (_appName: string, jobName: string) =>
    `${jobName}:stub`) as typeof jobsModule.enqueueAppJob,
)

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const SCOPES = ["mail:conversations:write", "mail:approve", "kernel:approvals:read"]
const ORIGINAL = "ORIGINALBODYNONCE thanks for your order"
const EDITED = "EDITEDBODYNONCE the parcel ships on Monday"

let ORG = ""
let USER = ""
let THREAD = ""
let SEALED_CONVERSATION = ""
let SHARED_CONVERSATION = ""
let MANAGED_ACCOUNT = ""
let PERSONAL_ACCOUNT = ""
let keyring: TestKeyring
let actor: ActorContext & UserContext

/** What the reply handler was handed, per execution. */
const replyCalls: Array<Record<string, unknown>> = []

beforeAll(async () => {
  await acquireTestLock()
  ORG = (await createTestOrg()).id
  USER = (await minimal.person(ORG, { name: "Owner" })).id
  for (const scope of SCOPES) await minimal.grantScope(USER, scope)
  actor = { actorType: "user", userId: USER, orgId: ORG, scopes: SCOPES, dimensionGrants: {} }
  THREAD = await minimal.thread(ORG, USER, { title: "Sealed draft edit" })

  const ctx = seedContext({ orgId: ORG, now: new Date() })
  const conversationOf = async (accountId: string) =>
    (
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

  // A personal mailbox, end-to-end encrypted to its owner's enrolled keyring.
  const personal = await ensureMailAccount(ctx, {
    ownerType: "user",
    userId: USER,
    email: "owner@sealed-edit.test",
    provider: "gmail",
  })
  SEALED_CONVERSATION = await conversationOf(personal.accountId)
  PERSONAL_ACCOUNT = personal.accountId
  keyring = new TestKeyring(USER)
  const enrolled = await keyring.enrollPayload(1)
  await asUser(await actorFor(ctx, USER), (tx) =>
    enrollKeyring(tx as never, USER, ORG, {
      ...enrolled,
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
  await withSystemDb("sealed-edit-fixture", (tx) =>
    tx.execute(drizzleSql`UPDATE ${MAIL}.accounts SET encryption_state = 'ready'
      WHERE id = ${personal.accountId}::uuid`),
  )

  // A shared (org) mailbox: never sealed, edited in the clear as before.
  const shared = await ensureMailAccount(ctx, {
    ownerType: "org",
    userId: USER,
    email: "support@sealed-edit.test",
    provider: "gmail",
  })
  SHARED_CONVERSATION = await conversationOf(shared.accountId)

  // A server-managed personal mailbox: sealed under the mailbox's own key.
  const managed = await ensureMailAccount(ctx, {
    ownerType: "user",
    userId: USER,
    email: "owner-managed@sealed-edit.test",
    provider: "gmail",
  })
  // No conversation: a managed mailbox holds no plaintext rows, so the draft is a compose.
  MANAGED_ACCOUNT = managed.accountId
  await withSystemDb("sealed-edit-fixture", (tx) =>
    tx.execute(drizzleSql`UPDATE ${MAIL}.accounts SET encryption_state = 'managed'
      WHERE id = ${managed.accountId}::uuid`),
  )

  // Reply and compose exactly as the mail manifest declares them: their params
  // schema, editable fields, resource owner and dedupe key.
  // And their real summarizers, which keep an encrypted mailbox's subject out of
  // the stored summary.
  registerApprovalSummarizer(ORG, "mail", "reply", summarizeMailReply as never)
  registerApprovalSummarizer(ORG, "mail", "compose", summarizeMailCompose as never)
  for (const name of ["reply", "compose"] as const) {
    const decl = MAIL_TOOLS[name]
    approvalResourceOwnerRegistry.set([ORG, "mail", name], decl.resourceOwner as never)
    approvalEditableFieldsRegistry.set([ORG, "mail", name], decl.editableFields as never)
    if (decl.approvalDedupeKeyParam) {
      approvalDedupeKeyRegistry.set([ORG, "mail", name], decl.approvalDedupeKeyParam as never)
      approvalDedupeSameRequesterRegistry.set(
        [ORG, "mail", name],
        (decl.approvalDedupeSameRequester === true) as never,
      )
    }
    toolRegistry.set([ORG, "mail", name], {
      appName: "mail",
      name,
      description: name,
      requiredScopes: ["mail:conversations:write"],
      gated: true,
      params: decl.params,
      handler: async (p: Record<string, unknown>) => {
        replyCalls.push(p)
        const r = { sent: true }
        const toolName = `mail:${name}`
        const [row] = await sql`SELECT id, decided_by FROM kernel.approval_requests
          WHERE org_id = ${ORG} AND tool_name = ${toolName} AND status = 'approving' LIMIT 1`
        const c = {
          orgId: ORG,
          approvalRequestId: row.id,
          approvalDeciderId: row.decided_by,
          toolName,
        }
        await withPrivilegedDb(ORG, "sealed-edit-rec", (tx) => recordStarted(tx, c, toolName))
        await withPrivilegedDb(ORG, "sealed-edit-rec", (tx) => recordSucceeded(tx, c, toolName, r))
        return r
      },
    } as never)
  }
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
  approvalEditableFieldsRegistry.deleteByPrefix([ORG])
  approvalDedupeKeyRegistry.deleteByPrefix([ORG])
  approvalDedupeSameRequesterRegistry.deleteByPrefix([ORG])
  approvalSummarizerRegistry.deleteByPrefix([ORG])
  await withSystemDb("sealed-edit-cleanup", async (tx) => {
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

async function stage(toolName: string, params: Record<string, unknown>): Promise<string> {
  const staged = await executeTool({
    toolName,
    orgId: ORG,
    actor,
    params,
    origin: "in-app-agent",
    threadId: THREAD,
  })
  const id = staged.blocked?.approvalRequestId
  if (!id) throw new Error(`${toolName} was not staged: ${JSON.stringify(staged)}`)
  return id
}

const stageReply = (params: Record<string, unknown>) => stage("mail:reply", params)

async function payloadOf(id: string): Promise<Record<string, unknown>> {
  const [r] = await sql`SELECT current_payload FROM kernel.approval_requests WHERE id = ${id}`
  return r.current_payload as Record<string, unknown>
}

/** Everything durable this org wrote that could carry the draft's text. */
async function everythingStored(id: string): Promise<string> {
  const [row] = await sql`SELECT row_to_json(a)::text AS t FROM kernel.approval_requests a
    WHERE id = ${id}`
  const messages = await sql`SELECT content, metadata::text AS m FROM kernel.messages
    WHERE org_id = ${ORG}`
  // This request's events: the shared-mailbox case below legitimately queues its
  // plaintext edit, and queued events outlive each test.
  const events = await sql`SELECT payload::text AS p FROM kernel.pending_events
    WHERE org_id = ${ORG} AND payload::text LIKE ${`%${id}%`}`
  // After a decision: the audit trail and the recorded handler execution.
  const audit = await sql`SELECT row_to_json(l)::text AS t FROM kernel.audit_log l
    WHERE org_id = ${ORG}`
  const executions = await sql`SELECT row_to_json(e)::text AS t
    FROM kernel.approved_handler_executions e WHERE org_id = ${ORG}`
  return [
    String(row?.t ?? ""),
    ...messages.map((m) => `${m.content} ${m.m}`),
    ...events.map((e) => String(e.p)),
    ...audit.map((a) => String(a.t)),
    ...executions.map((e) => String(e.t)),
  ].join("\n")
}

/** Open a stored draft part the way the owner's unlocked browser does. */
async function openStored(
  id: string,
  part: "bodyCiphertext" | "subjectCiphertext" = "bodyCiphertext",
): Promise<string> {
  const p = await payloadOf(id)
  const identity = keyring.ecdhIdentity(Number(p.encKeyId))
  const contentKey = await unsealContentKey({
    privateKey: identity.privateKey,
    recipientEcdhSpki: identity.spki,
    userId: USER,
    keyId: Number(p.encKeyId),
    wrapped: new Uint8Array(Buffer.from(String(p.contentKeyWrapped), "base64")),
    epkSpki: new Uint8Array(Buffer.from(String(p.contentKeyEpk), "base64")),
  })
  const opened = await openField({
    contentKey,
    context: part === "subjectCiphertext" ? mailboxAad.draftSubject(id) : mailboxAad.draftBody(id),
    blob: new Uint8Array(Buffer.from(String(p[part]), "base64")),
  })
  return new TextDecoder().decode(opened)
}

const openStoredBody = (id: string) => openStored(id)

describe("editing a sealed mail draft", () => {
  it("re-seals the edited body, stores no plaintext, and the approval sends the new text", async () => {
    const id = await stageReply({ conversationId: SEALED_CONVERSATION, textBody: ORIGINAL })
    const before = await payloadOf(id)
    expect(before.mailboxSealed).toBe(true)
    expect(await openStoredBody(id)).toBe(ORIGINAL)

    const result = await updatePayload({
      orgId: ORG,
      requestId: id,
      fields: { textBody: EDITED },
      actor,
      actingAgentId: null,
    })

    // The stored draft is the new body, sealed: a new ciphertext under a new
    // content key that opens, for the owner, to exactly the edited text.
    const after = await payloadOf(id)
    expect(after.mailboxSealed).toBe(true)
    expect(after.textBody).toBeUndefined()
    expect(after.bodyCiphertext).not.toBe(before.bodyCiphertext)
    expect(after.contentKeyWrapped).not.toBe(before.contentKeyWrapped)
    expect(after.byteLength).toBe(new TextEncoder().encode(EDITED).byteLength)
    expect(after.conversationId).toBe(SEALED_CONVERSATION)
    expect(await openStoredBody(id)).toBe(EDITED)

    // No plaintext anywhere: the row (tool_params, current_payload, summary,
    // metadata), the edit's system message and its diff, the queued events.
    const stored = await everythingStored(id)
    expect(stored).not.toContain("EDITEDBODYNONCE")
    expect(stored).not.toContain("ORIGINALBODYNONCE")
    const diff = result.lastEdit?.diff ?? []
    expect(diff).toEqual([
      {
        field: "textBody",
        from: { sealed: true, byteLength: new TextEncoder().encode(ORIGINAL).byteLength },
        to: { sealed: true, byteLength: new TextEncoder().encode(EDITED).byteLength },
      },
    ])
    // What the caller is told is what happened, and carries no plaintext either.
    expect(result.sealedEdit?.resealedFields).toEqual(["textBody"])
    expect(result.sealedEdit?.note).toContain("encrypted again")
    expect(JSON.stringify(result)).not.toContain("EDITEDBODYNONCE")

    // Approving: the owner's browser decrypts the stored draft and supplies it;
    // the send carries the EDITED text.
    await decideApproval({
      orgId: ORG,
      requestId: id,
      actor,
      decision: "approve",
      mailboxFulfilment: { draft: { textBody: await openStoredBody(id) } },
    })
    expect(replyCalls).toHaveLength(1)
    expect(replyCalls[0]?.textBody).toBe(EDITED)
    expect(replyCalls[0]?.bodyCiphertext).toBeUndefined()
    // And after the send: still nothing readable at rest, audit log and the
    // recorded execution included.
    const afterSend = await everythingStored(id)
    expect(afterSend).not.toContain("EDITEDBODYNONCE")
    expect(afterSend).not.toContain("ORIGINALBODYNONCE")
  })

  it("an envelope-only edit keeps the sealed body and updates the recipient count", async () => {
    const id = await stageReply({ conversationId: SEALED_CONVERSATION, textBody: ORIGINAL })
    const before = await payloadOf(id)
    await updatePayload({
      orgId: ORG,
      requestId: id,
      fields: { cc: ["a@example.test", "b@example.test"] },
      actor,
      actingAgentId: null,
    })
    const after = await payloadOf(id)
    expect(after.cc).toEqual(["a@example.test", "b@example.test"])
    expect(after.bodyCiphertext).toBe(before.bodyCiphertext)
    expect(after.recipientCount).toBe(2)
    expect(await openStoredBody(id)).toBe(ORIGINAL)
  })

  it("a compose edit carrying its subject and body re-seals both, and sends them", async () => {
    const id = await stage("mail:compose", {
      accountId: PERSONAL_ACCOUNT,
      to: ["customer@example.test"],
      subject: "SUBJECTNONCE your order",
      textBody: ORIGINAL,
    })
    const before = await payloadOf(id)
    expect(typeof before.subjectCiphertext).toBe("string")
    // What the card sends: every sealed part it decrypted, the body edited.
    await updatePayload({
      orgId: ORG,
      requestId: id,
      fields: { textBody: EDITED, subject: "SUBJECTNONCE your order" },
      actor,
      actingAgentId: null,
    })
    expect(await openStored(id)).toBe(EDITED)
    expect(await openStored(id, "subjectCiphertext")).toBe("SUBJECTNONCE your order")
    expect((await payloadOf(id)).subjectHash).toBe(before.subjectHash)
    await decideApproval({
      orgId: ORG,
      requestId: id,
      actor,
      decision: "approve",
      mailboxFulfilment: {
        draft: {
          subject: await openStored(id, "subjectCiphertext"),
          textBody: await openStored(id),
        },
      },
    })
    expect(replyCalls[0]).toMatchObject({ subject: "SUBJECTNONCE your order", textBody: EDITED })
    const stored = await everythingStored(id)
    for (const nonce of ["EDITEDBODYNONCE", "ORIGINALBODYNONCE"]) {
      expect(stored).not.toContain(nonce)
    }
    // The subject never reaches the payload or the edit; the staged summary's
    // title is the summarizer's own concern (security/b19), not this edit's.
    const [row] = await sql`SELECT tool_params::text || current_payload::text AS t
      FROM kernel.approval_requests WHERE id = ${id}`
    expect(String(row?.t)).not.toContain("SUBJECTNONCE")
  })

  it("refuses a compose edit that leaves out a sealed part, and stores nothing", async () => {
    // The subject is sealed with the body under one content key the server
    // cannot open: an edit that does not carry it cannot be re-sealed whole.
    const id = await stage("mail:compose", {
      accountId: PERSONAL_ACCOUNT,
      to: ["customer@example.test"],
      subject: "SUBJECTNONCE your order",
      textBody: ORIGINAL,
    })
    const before = await payloadOf(id)
    await expect(
      updatePayload({ orgId: ORG, requestId: id, fields: { textBody: EDITED }, actor }),
    ).rejects.toMatchObject({
      code: "sealed_draft_not_editable",
      message: expect.stringContaining("pass subject again"),
    })
    expect(await payloadOf(id)).toEqual(before)
    expect(await everythingStored(id)).not.toContain("EDITEDBODYNONCE")
  })

  it("a server-managed mailbox's draft is re-sealed under its own key and sends the edit", async () => {
    const id = await stage("mail:compose", {
      accountId: MANAGED_ACCOUNT,
      to: ["customer@example.test"],
      subject: "SUBJECTNONCE managed",
      textBody: ORIGINAL,
    })
    const before = await payloadOf(id)
    expect(isManagedApprovalPayload(before)).toBe(true)
    await updatePayload({
      orgId: ORG,
      requestId: id,
      fields: { textBody: EDITED, subject: "SUBJECTNONCE managed" },
      actor,
      actingAgentId: null,
    })
    const after = await payloadOf(id)
    expect(isManagedApprovalPayload(after)).toBe(true)
    expect(after.bodyCiphertext).not.toBe(before.bodyCiphertext)
    expect(after.textBody).toBeUndefined()
    const opened = await openManagedApprovalPayload({
      payload: after,
      orgId: ORG,
      deciderId: USER,
      approvalRequestId: id,
    })
    expect(opened).toMatchObject({ textBody: EDITED, subject: "SUBJECTNONCE managed" })
    await decideApproval({ orgId: ORG, requestId: id, actor, decision: "approve" })
    expect(replyCalls[0]).toMatchObject({ textBody: EDITED, subject: "SUBJECTNONCE managed" })
    const stored = await everythingStored(id)
    for (const nonce of ["EDITEDBODYNONCE", "ORIGINALBODYNONCE"]) {
      expect(stored).not.toContain(nonce)
    }
    // The subject never reaches the payload or the edit; the staged summary's
    // title is the summarizer's own concern (security/b19), not this edit's.
    const [row] = await sql`SELECT tool_params::text || current_payload::text AS t
      FROM kernel.approval_requests WHERE id = ${id}`
    expect(String(row?.t)).not.toContain("SUBJECTNONCE")
  })

  it("keeps the agent's edit call args out of the transcript for a sealed draft only", async () => {
    const sealedId = await stageReply({ conversationId: SEALED_CONVERSATION, textBody: ORIGINAL })
    const redacted = (await redactMailToolArgs(ORG, "kernel__approval_update_payload", {
      requestId: sealedId,
      fields: { textBody: EDITED, cc: ["a@example.test"] },
    })) as Record<string, unknown>
    expect(JSON.stringify(redacted)).not.toContain("EDITEDBODYNONCE")
    expect(redacted).toMatchObject({
      requestId: sealedId,
      fields: { cc: ["a@example.test"] },
      redacted: true,
      redactedFields: ["textBody"],
    })

    const sharedId = await stageReply({ conversationId: SHARED_CONVERSATION, textBody: ORIGINAL })
    const args = { requestId: sharedId, fields: { textBody: EDITED } }
    expect(await redactMailToolArgs(ORG, "kernel__approval_update_payload", args)).toBe(args)
  })

  it("a shared mailbox draft is edited in the clear, as before", async () => {
    const id = await stageReply({
      conversationId: SHARED_CONVERSATION,
      textBody: ORIGINAL,
      htmlBody: "<p>ORIGINAL</p>",
    })
    const before = await payloadOf(id)
    expect(before.mailboxSealed).toBeUndefined()
    const result = await updatePayload({
      orgId: ORG,
      requestId: id,
      fields: { textBody: EDITED },
      actor,
      actingAgentId: null,
    })
    const after = await payloadOf(id)
    expect(after.textBody).toBe(EDITED)
    expect(after.htmlBody).toBe("")
    expect(result.sealedEdit).toBeUndefined()
    expect(result.lastEdit?.diff).toEqual([
      { field: "textBody", from: ORIGINAL, to: EDITED },
      { field: "htmlBody", from: "<p>ORIGINAL</p>", to: "" },
    ])
  })
  it("re-calling the reply restages the pending draft sealed, never as plaintext", async () => {
    // Texts of their own, so nothing an earlier test stored can match them.
    const id = await stageReply({
      conversationId: SEALED_CONVERSATION,
      textBody: `${ORIGINAL} (restage)`,
    })
    const again = await stageReply({
      conversationId: SEALED_CONVERSATION,
      textBody: `${EDITED} (restage)`,
    })
    expect(again).toBe(id)
    const after = await payloadOf(id)
    expect(after.mailboxSealed).toBe(true)
    expect(after.textBody).toBeUndefined()
    expect(await openStoredBody(id)).toBe(`${EDITED} (restage)`)
    const stored = await everythingStored(id)
    expect(stored).not.toContain("EDITEDBODYNONCE")
    expect(stored).not.toContain("ORIGINALBODYNONCE")
  })
})
