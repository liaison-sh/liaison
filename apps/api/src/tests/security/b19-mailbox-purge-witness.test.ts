// SPDX-License-Identifier: FSL-1.1-ALv2
//
// b19, part three: what the ledger SAYS after a purge, and step 7d.
//
// Two defects, both of them the same shape: a destructive operation whose
// record of itself is misleading, on the one path a real mailbox actually
// takes.
//
//   1. `plaintext_purged_at` is a COMPLETION flag, not a record that the purge
//      ran. It is stamped only when every personal-mail attachment object is
//      sealed too, and nothing seals historical attachment bytes, so on the
//      owner's real mailbox that condition is false. The purge NULLs every
//      subject, body and snippet and then leaves the column NULL. An operator
//      who is interrupted, or who re-checks the next day, reads NULL and
//      concludes the purge never ran, when the only readable copies left are
//      inside compliance-locked backups.
//
//   2. Step 7d, the PRE-cutover control-plane residue, had no coverage on a
//      corpus that actually held residue. Invariant K's tests assert that rows
//      written on an already-sealed mailbox are clean, which a residue purge
//      that silently does nothing satisfies. Its first real exercise would have
//      been on prod, after the point where nothing can be undone.
//
// The fixture is therefore the AWKWARD case on purpose: a legacy corpus, a
// genuine attachment object that nothing ever sealed, and four kinds of
// pre-cutover residue seeded before the cutover. Nothing is hand-sealed; the
// REAL backfill job does the sealing.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { computeIdSetDigest, signAck } from "@liaison/mailbox-crypto/src/ack"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { ApprovalDecisionError, decideApproval } from "~/modules/approvals/decide"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import {
  type AckSqlExecutor,
  collectPersonalMessageIds,
  issueVerifyNonce,
  recordVerifiedAck,
  verifyMailboxAck,
} from "~/modules/mailbox-crypto/ack-verify"
import { sealMailApprovalPayload } from "~/modules/mailbox-crypto/approval-payload"
import { runMailboxBackfillForUser } from "~/modules/mailbox-crypto/backfill-job"
import { type PurgeResult, purgeMailboxPlaintext } from "~/modules/mailbox-crypto/purge"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const K = drizzleSql.raw(`"${schemaRef("kernel")}"`)

const KEY_ID = 73
const MESSAGE_COUNT = 3

/** One phrase per residue surface, so a partial residue purge cannot hide. */
const AUDIT_PHRASE = "WITNESSAUDITPHRASE"
const THREAD_PHRASE = "WITNESSTHREADPHRASE"
const APPROVAL_PHRASE = "WITNESSAPPROVALPHRASE"
const TOOLCALL_PHRASE = "WITNESSTOOLCALLPHRASE"
const BODY_PHRASE = "WITNESSBODYPHRASE"
/** Outside this mailbox's residue: must survive the purge. */
const COLLATERAL_PHRASE = "WITNESSCOLLATERALPHRASE"

describe("the purge tells the truth about itself, and step 7d clears real residue", () => {
  let orgId: string
  let userId: string
  let accountId: string
  let conversationId: string
  let threadId: string
  let signKeys: CryptoKeyPair
  let colleagueId: string
  let result: PurgeResult
  let draftApprovalId: string
  let sealedApprovalId: string
  let sealedPayload: Record<string, unknown>

  async function sys<T>(reason: string, fn: (tx: AckSqlExecutor) => Promise<T>): Promise<T> {
    return withSystemDb(reason, (tx) => fn(tx as unknown as AckSqlExecutor))
  }

  const purgeDeps = {
    privileged: <T>(
      _orgId: string,
      reason: string,
      fn: (tx: Pick<PrivilegedDb, "execute">) => Promise<T>,
    ) => withSystemDb(reason, (tx) => fn(tx as unknown as Pick<PrivilegedDb, "execute">)),
    deleteSearchDocuments: async () => {},
  }

  /** Rows outside this mailbox's residue that hold cleartext. */
  async function collateralCounts() {
    return withSystemDb("b19-witness-collateral", async (tx) => ({
      approvals: extractRows<{ tool_name: string }>(
        await tx.execute(drizzleSql`
          SELECT tool_name FROM ${K}.approval_requests
           WHERE org_id = ${orgId}::uuid
             AND tool_params::text LIKE ${`%${COLLATERAL_PHRASE}%`}
             AND current_payload::text LIKE ${`%${COLLATERAL_PHRASE}%`}
             AND summary::text LIKE ${`%${COLLATERAL_PHRASE}%`}
           ORDER BY tool_name`),
      ).map((r) => r.tool_name),
      toolCalls: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${K}.messages
           WHERE org_id = ${orgId}::uuid AND metadata::text LIKE ${`%${COLLATERAL_PHRASE}%`}`),
      )[0]?.n,
    }))
  }

  /** Every residue surface step 7d names, counted by its own phrase. */
  async function residueCounts() {
    return withSystemDb("b19-witness-residue", async (tx) => ({
      audit: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${K}.audit_log
           WHERE org_id = ${orgId}::uuid AND changes::text LIKE ${`%${AUDIT_PHRASE}%`}`),
      )[0]?.n,
      thread: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${K}.threads
           WHERE org_id = ${orgId}::uuid AND title LIKE ${`%${THREAD_PHRASE}%`}`),
      )[0]?.n,
      approval: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${K}.approval_requests
           WHERE org_id = ${orgId}::uuid
             AND (tool_params::text LIKE ${`%${APPROVAL_PHRASE}%`}
               OR current_payload::text LIKE ${`%${APPROVAL_PHRASE}%`}
               OR coalesce(summary::text, '') LIKE ${`%${APPROVAL_PHRASE}%`})`),
      )[0]?.n,
      toolCall: extractRows<{ n: number }>(
        await tx.execute(drizzleSql`
          SELECT count(*)::int AS n FROM ${K}.messages
           WHERE org_id = ${orgId}::uuid AND metadata::text LIKE ${`%${TOOLCALL_PHRASE}%`}`),
      )[0]?.n,
    }))
  }

  async function ledgerRow() {
    return (
      await withSystemDb("b19-witness-ledger", async (tx) =>
        extractRows<{
          plaintext_purged_at: Date | null
          plaintext_purge_ran_at: Date | null
          backups_clear_after: Date | null
        }>(
          await tx.execute(drizzleSql`
            SELECT plaintext_purged_at, plaintext_purge_ran_at, backups_clear_after
              FROM ${K}.mailbox_migration_state WHERE user_id = ${userId}::uuid`),
        ),
      )
    )[0]
  }

  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    try {
      const user = await minimal.person((await createTestOrg()).id)
      orgId = user.orgId
      userId = user.id
      colleagueId = (await minimal.person(orgId)).id
      // What a real requester holds, so an approved send reaches its tool.
      for (const scope of ["mail:conversations:write"]) await minimal.grantScope(userId, scope)
      await registerApps([mailAppManifest as unknown as AppDescriptor], orgId)

      accountId = crypto.randomUUID()
      conversationId = crypto.randomUUID()
      threadId = crypto.randomUUID()

      await withSystemDb("b19-witness-seed", async (tx) => {
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.accounts
            (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
             sync_status, encryption_state)
          VALUES (${accountId}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                  ${userId}::uuid, 'gmail', ${`${accountId}@witness.test`}, 'active', 'ready')`)

        // The internal discussion thread of the conversation, carrying the real
        // subject in its title. spec section 7 step 7d names this, and
        // `kernel.threads.title` is a Meili searchable field.
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.threads (id, org_id, handle, title, created_by)
          VALUES (${threadId}::uuid, ${orgId}::uuid, ${`witness-${threadId}`},
                  ${`Discussion: ${THREAD_PHRASE} quarterly numbers`}, ${userId}::uuid)`)
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.thread_participants (thread_id, user_id, org_id)
          VALUES (${threadId}::uuid, ${userId}::uuid, ${orgId}::uuid)`)

        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.conversations
            (id, org_id, account_id, owner_type, owner_id, external_thread_id, subject, snippet,
             status, labels, is_read, is_starred, message_count, from_email, internal_thread_id)
          VALUES (${conversationId}::uuid, ${orgId}::uuid, ${accountId}::uuid, 'user',
                  ${userId}::uuid, ${`thread-${conversationId}`},
                  ${`${BODY_PHRASE} conversation`}, ${`${BODY_PHRASE} snippet`},
                  'open', '[]'::jsonb, false, false, ${MESSAGE_COUNT}, 'sender@witness.test',
                  ${threadId}::uuid)`)

        for (let i = 0; i < MESSAGE_COUNT; i++) {
          await tx.execute(drizzleSql`
            INSERT INTO ${MAIL}.messages
              (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
               from_address, to_addresses, direction, subject, text_body, html_body, snippet,
               raw_headers, created_at)
            VALUES (gen_random_uuid(), ${orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
                    'user', ${userId}::uuid, ${`<witness-${i}-${crypto.randomUUID()}@witness.test>`},
                    ${JSON.stringify({ email: "sender@witness.test" })}::jsonb,
                    ${JSON.stringify([{ email: "me@witness.test" }])}::jsonb, 'inbound',
                    ${`${BODY_PHRASE} subject ${i}`}, ${`${BODY_PHRASE} body ${i}`},
                    ${`<p>${BODY_PHRASE} html ${i}</p>`}, ${`${BODY_PHRASE} snippet ${i}`},
                    ${JSON.stringify({
                      "message-id": `<witness-${i}@witness.test>`,
                      from: "sender@witness.test",
                      "x-originating-ip": "203.0.113.9",
                    })}::jsonb,
                    ${new Date(Date.UTC(2026, 3, 1, 0, i)).toISOString()}::timestamptz)`)
        }

        const messageId = extractRows<{ id: string }>(
          await tx.execute(drizzleSql`
            SELECT id::text AS id FROM ${MAIL}.messages
             WHERE account_id = ${accountId}::uuid ORDER BY created_at LIMIT 1`),
        )[0]?.id as string

        // 7d residue, seeded PRE cutover, one row per surface the purge names.
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.audit_log (org_id, actor_id, actor_type, app, entity_type, entity_id,
                                      action, changes)
          VALUES (${orgId}::uuid, ${userId}::uuid, 'user', 'mail', 'message', ${messageId},
                  'update', ${JSON.stringify({ subject: `${AUDIT_PHRASE} the old subject` })}::jsonb)`)

        // Approvals as the real write path stores them: `tool_name` is the
        // canonical `app:tool`, and the payload names its target.
        const seedApproval = async (
          toolName: string,
          payload: Record<string, unknown>,
          summaryText: string,
          requestedBy: string,
        ) =>
          (
            extractRows<{ id: string }>(
              await tx.execute(drizzleSql`
                INSERT INTO ${K}.approval_requests
                  (org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
                   current_payload, expires_at, requested_by, resource_owner_id, summary)
                VALUES (${orgId}::uuid, ${`witness-approval-${crypto.randomUUID()}`},
                        ${threadId}::uuid, ${threadId}::uuid, ${toolName},
                        ${JSON.stringify(payload)}::jsonb, ${JSON.stringify(payload)}::jsonb,
                        now() + interval '1 day', ${requestedBy}::uuid, ${userId}::uuid,
                        ${JSON.stringify({ text: summaryText })}::jsonb)
                RETURNING id::text AS id`),
            )[0] as { id: string }
          ).id

        // Cleartext from before the cutover, on this mailbox: the purge's job,
        // whoever asked for the send.
        draftApprovalId = await seedApproval(
          "mail:reply",
          { conversationId, textBody: `${APPROVAL_PHRASE} draft reply` },
          `${APPROVAL_PHRASE} summary`,
          userId,
        )
        await seedApproval(
          "mail:reply",
          { conversationId, textBody: `${APPROVAL_PHRASE} a colleague's draft` },
          `${APPROVAL_PHRASE} summary`,
          colleagueId,
        )

        // Not this mailbox's residue, though each resembles it.
        const sharedAccountId = crypto.randomUUID()
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.accounts
            (id, org_id, connected_account_id, owner_type, provider, email_address, sync_status)
          VALUES (${sharedAccountId}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'org',
                  'gmail', ${`${sharedAccountId}@witness.test`}, 'active')`)
        for (const [toolName, payload] of [
          ["mail:reply", { accountId: sharedAccountId }],
          ["mail:compose", {}],
          ["mailchimp:send", { accountId }],
        ] as const) {
          await seedApproval(
            toolName,
            { ...payload, textBody: `${COLLATERAL_PHRASE} draft` },
            `${COLLATERAL_PHRASE} summary`,
            userId,
          )
        }

        // `required_scopes` is named explicitly: 0066 dropped the 0059 default,
        // so an INSERT that omits it now raises 23502. `{}` is the honest value
        // for this row and the reason it is `{}`: the residue message is an
        // ordinary agent reply in the owner's own discussion thread, carrying
        // no scoped data, and T29 asks every writer to name the scopes it
        // actually needs.
        //
        // It is NOT what makes the witness work, and an earlier note here said
        // otherwise: it claimed a non-empty tag would hide the row from its
        // owner and change what is witnessed. That is false. Nothing on this
        // path reads the row through RLS. `residueCounts()` and the purge both
        // run inside `withSystemDb`, which does SET LOCAL ROLE liaison_admin
        // (BYPASSRLS), while 0060's messages_select is granted TO liaison_rls,
        // so the policy is never consulted here. Re-running this fixture with
        // required_scopes = '{zzz:secret:read}' gives the same 5 pass, 0 fail.
        // The epic's P4a constraint (messages_agent_author_named) refuses an
        // author_type='agent' row that names no agent, so the residue reply is
        // written by a real agent of this org rather than by nobody. It is a
        // fixture detail: the purge and residueCounts read metadata, never the
        // author.
        const agentId = crypto.randomUUID()
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.agents (id, org_id, kind, handle, display_name)
          VALUES (${agentId}::uuid, ${orgId}::uuid, 'role',
                  ${`witness-${agentId.slice(0, 8)}`}, 'Witness')`)

        await tx.execute(drizzleSql`
          INSERT INTO ${K}.messages (thread_id, org_id, author_id, author_type, author_agent_id,
                                     content, required_scopes, metadata)
          VALUES (${threadId}::uuid, ${orgId}::uuid, ${userId}::uuid, 'agent', ${agentId}::uuid,
                  'read your mail',
                  '{}'::text[],
                  ${JSON.stringify({
                    toolCalls: [
                      { toolName: "mail__read", result: { textBody: `${TOOLCALL_PHRASE} body` } },
                    ],
                  })}::jsonb)`)

        // Another app's tool call in the same thread. Only an unescaped `_` in
        // the filter could take `mailchimp__send` for a mail tool.
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.messages (thread_id, org_id, author_id, author_type, author_agent_id,
                                     content, required_scopes, metadata)
          VALUES (${threadId}::uuid, ${orgId}::uuid, ${userId}::uuid, 'agent', ${agentId}::uuid,
                  'sent a campaign',
                  '{}'::text[],
                  ${JSON.stringify({
                    toolCalls: [
                      {
                        toolName: "mailchimp__send",
                        result: { textBody: `${COLLATERAL_PHRASE} body` },
                      },
                    ],
                  })}::jsonb)`)

        // An attachment object nothing ever seals. This is what makes the
        // cutover incomplete, which is the whole point of the fixture.
        await tx.execute(drizzleSql`
          INSERT INTO ${K}.files
            (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes,
             storage_key, enc_version)
          VALUES (gen_random_uuid(), ${orgId}::uuid, 'mail', 'message', ${messageId},
                  'pre-enrollment.pdf', 'application/pdf', 4096,
                  ${`mail/${crypto.randomUUID()}/pre-enrollment.pdf`}, 0)`)
      })

      const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
        "deriveBits",
      ])) as unknown as CryptoKeyPair
      signKeys = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
        "sign",
        "verify",
      ])) as unknown as CryptoKeyPair
      const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
      const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", signKeys.publicKey))
      await withSystemDb("b19-witness-arm", (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO ${K}.user_mailbox_identities
            (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
          VALUES (${orgId}::uuid, ${userId}::uuid, ${KEY_ID}, ${ecdhSpki}, ${signSpki},
                  ${Buffer.from("attestation")}, 'active')`),
      )
      await runMailboxBackfillForUser(userId, orgId, { batchIntervalMs: 0, batchSize: 50 })

      // A draft staged AFTER the mailbox was sealed, in the real sealed shape,
      // waiting for its owner: the purge must leave it decidable.
      sealedApprovalId = crypto.randomUUID()
      sealedPayload = await sealMailApprovalPayload({
        orgId,
        appName: "mail",
        toolShortName: "compose",
        approvalRequestId: sealedApprovalId,
        toolParams: {
          accountId,
          to: ["someone@witness.test"],
          subject: "A sealed subject",
          textBody: "A sealed draft",
        },
      })
      expect(sealedPayload.mailboxSealed).toBe(true)
      expect(typeof sealedPayload.bodyCiphertext).toBe("string")
      await withSystemDb("b19-witness-sealed-approval", (tx) =>
        tx.execute(drizzleSql`
          INSERT INTO ${K}.approval_requests
            (id, org_id, handle, thread_id, originating_thread_id, tool_name, tool_params,
             current_payload, expires_at, requested_by, summary)
          VALUES (${sealedApprovalId}::uuid, ${orgId}::uuid, ${`sealed-${sealedApprovalId}`},
                  ${threadId}::uuid, ${threadId}::uuid, 'mail:compose',
                  ${JSON.stringify(sealedPayload)}::jsonb, ${JSON.stringify(sealedPayload)}::jsonb,
                  now() + interval '1 day', ${userId}::uuid,
                  ${JSON.stringify({ title: "Email to someone@witness.test" })}::jsonb)`),
      )
    } catch (err) {
      await releaseAppSchemaJsLock("app_mail")
      throw err
    }
  }, 180_000)

  afterAll(async () => {
    await releaseAppSchemaJsLock("app_mail")
    if (!orgId) return
    await withSystemDb("b19-witness-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${K}.files WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.approval_requests WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.drafts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.messages WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${K}.threads WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${K}.user_mailbox_identities WHERE user_id = ${userId}::uuid`,
      )
    })
  })

  it("non-vacuity: the fixture holds plaintext, four kinds of residue, and an unsealed attachment", async () => {
    const residue = await residueCounts()
    expect(residue.audit).toBe(1)
    expect(residue.thread).toBe(1)
    expect(residue.approval).toBe(2)
    expect(residue.toolCall).toBe(1)
    expect(await collateralCounts()).toEqual({
      approvals: ["mail:compose", "mail:reply", "mailchimp:send"],
      toolCalls: 1,
    })

    const row = await ledgerRow()
    expect(row?.plaintext_purged_at ?? null).toBeNull()
    expect(row?.plaintext_purge_ran_at ?? null).toBeNull()
  })

  it("runs the purge on a mailbox whose cutover CANNOT complete", async () => {
    const issued = await sys("b19-witness-nonce", (tx) => issueVerifyNonce(tx, userId, orgId))
    const ids = await sys("b19-witness-ids", (tx) => collectPersonalMessageIds(tx, userId, orgId))
    expect(ids.length).toBe(MESSAGE_COUNT)
    const digest = await computeIdSetDigest(ids)
    const submission = {
      keyId: KEY_ID,
      nonce: issued.nonce,
      count: ids.length,
      idSetDigest: Buffer.from(digest).toString("base64"),
      signature: Buffer.from(
        await signAck(signKeys.privateKey, {
          userId,
          accountId,
          keyId: KEY_ID,
          nonce: issued.nonce,
          count: ids.length,
          idSetDigest: digest,
          backfillCursor: issued.backfillCursor,
        }),
      ).toString("base64"),
      backfillCursor: issued.backfillCursor,
    }
    await sys("b19-witness-verify", async (tx) => {
      const verified = await verifyMailboxAck(tx, userId, orgId, accountId, submission)
      await recordVerifiedAck(tx, userId, accountId, submission, verified.digest)
    })

    result = await purgeMailboxPlaintext(userId, orgId, purgeDeps)
    expect(result.messagesPurged).toBe(MESSAGE_COUNT)
    expect(result.unsealedAttachments).toBeGreaterThan(0)
    expect(result.cutoverComplete).toBe(false)
  }, 180_000)

  it("records that the destructive purge RAN even though the cutover is not complete", async () => {
    // The defect: `plaintext_purged_at` is the completion flag and stays NULL
    // here, correctly. Without a second column an operator re-reading the
    // ledger sees NULL against a mailbox whose every body has been destroyed.
    const row = await ledgerRow()
    expect(row?.plaintext_purged_at ?? null).toBeNull()
    expect(row?.backups_clear_after ?? null).toBeNull()
    expect(row?.plaintext_purge_ran_at ?? null).not.toBeNull()
    expect(result.plaintextPurgeRanAt).toBeInstanceOf(Date)
  })

  it("reports the remaining plaintext counts, which are the real witness", async () => {
    // Not the flag: the absence of readable content. Zero here while
    // `plaintext_purged_at` is NULL is exactly the state the plan's
    // "plaintext_purged_at IS NULL means nothing was destroyed" reading gets
    // backwards.
    expect(result.remainingPlaintext.messages).toBe(0)
    expect(result.remainingPlaintext.conversations).toBe(0)
    expect(result.remainingPlaintext.drafts).toBe(0)
    expect(result.remainingPlaintext.messagesWithNonAllowlistedHeaders).toBe(0)
  })

  it("step 7d clears every kind of PRE-cutover control-plane residue", async () => {
    const residue = await residueCounts()
    expect(residue.audit).toBe(0)
    expect(residue.thread).toBe(0)
    expect(residue.approval).toBe(0)
    expect(residue.toolCall).toBe(0)
  })

  it("step 7d leaves what is not this mailbox's residue: another app, another mailbox, no mailbox", async () => {
    expect(await collateralCounts()).toEqual({
      approvals: ["mail:compose", "mail:reply", "mailchimp:send"],
      toolCalls: 1,
    })
  })

  it("step 7d leaves a sealed draft exactly as it was, so its owner can still decide it", async () => {
    const [row] = await withSystemDb("b19-witness-sealed-after", async (tx) =>
      extractRows<{
        status: string
        tool_params: Record<string, unknown>
        current_payload: Record<string, unknown>
        summary: Record<string, unknown> | null
      }>(
        await tx.execute(drizzleSql`
          SELECT status, tool_params, current_payload, summary FROM ${K}.approval_requests
           WHERE id = ${sealedApprovalId}::uuid`),
      ),
    )
    expect(row).toEqual({
      status: "pending",
      tool_params: sealedPayload,
      current_payload: sealedPayload,
      summary: { title: "Email to someone@witness.test" },
    })
  })

  it("approving a pending draft the purge emptied is refused, and nothing runs", async () => {
    let err: unknown
    try {
      await decideApproval({
        orgId,
        requestId: draftApprovalId,
        actor: { actorType: "user", userId, orgId, scopes: ["*"], dimensionGrants: {} },
        decision: "approve",
      })
    } catch (e) {
      err = e
    }
    expect(err).toBeInstanceOf(ApprovalDecisionError)
    expect((err as ApprovalDecisionError).code).toBe("mail_draft_removed")
    expect((err as ApprovalDecisionError).status).toBe(422)
    const [row] = await withSystemDb("b19-witness-emptied-after", async (tx) =>
      extractRows<{ status: string; decided_by: string | null }>(
        await tx.execute(drizzleSql`
          SELECT status, decided_by FROM ${K}.approval_requests
           WHERE id = ${draftApprovalId}::uuid`),
      ),
    )
    expect(row).toEqual({ status: "pending", decided_by: null })
  })
})
