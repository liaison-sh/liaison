// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Invariant K, Task 6.5: a gated mail send from an encrypted personal mailbox
// stores its drafted body, its subject and (above all) any quoted original as
// ciphertext, never as readable text.
//
// `kernel.approval_requests.tool_params` and `.current_payload` are ordinary
// jsonb columns an org admin with the approvals scope can read, and the approval
// create path copies the payload into a durable `kernel.pending_events` row on
// top of that. For a compose the subject is text the USER typed, so this is the
// one mail leak the Phase 12 purge can never heal.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import {
  MAIL_APPROVAL_SEALED_TOOLS,
  sealMailApprovalPayload,
} from "~/modules/mailbox-crypto/approval-payload"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)
const KEY_ID = 41

describe("Invariant K: sealed approval payloads for gated mail sends", () => {
  let orgId: string
  let userId: string
  let readyAccountId: string
  let orgAccountId: string
  let readyConversationId: string

  beforeAll(async () => {
    const user = await minimal.person((await createTestOrg()).id)
    orgId = user.orgId
    userId = user.id
    readyAccountId = crypto.randomUUID()
    orgAccountId = crypto.randomUUID()
    readyConversationId = crypto.randomUUID()

    const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as unknown as CryptoKeyPair
    const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair
    const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
    const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))

    await withSystemDb("approval-payload-fixture", async (tx) => {
      await tx.execute(drizzleSql`
        INSERT INTO kernel.user_mailbox_identities
          (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
        VALUES (${orgId}::uuid, ${userId}::uuid, ${KEY_ID}, ${ecdhSpki}, ${signSpki},
                ${Buffer.from("attestation")}, 'active')`)
      for (const [id, ownerType, ownerId, state] of [
        [readyAccountId, "user", userId, "ready"],
        [orgAccountId, "org", null, "none"],
      ] as Array<[string, string, string | null, string]>) {
        await tx.execute(drizzleSql`
          INSERT INTO ${MAIL}.accounts
            (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
             sync_status, encryption_state)
          VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, ${ownerType},
                  ${ownerId}, 'gmail', ${`${id}@approval.test`}, 'active', ${state})`)
      }
      await tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.conversations
          (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
           is_read, is_starred, message_count)
        VALUES (${readyConversationId}::uuid, ${orgId}::uuid, ${readyAccountId}::uuid, 'user',
                ${userId}::uuid, 'thread-approval-1', 'open', '[]'::jsonb, false, false, 1)`)
    })
  }, 60_000)

  afterAll(async () => {
    await withSystemDb("approval-payload-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${orgId}::uuid`)
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM kernel.user_mailbox_identities WHERE user_id = ${userId}::uuid`,
      )
    })
  })

  it("names exactly the three gated send tools", () => {
    expect([...MAIL_APPROVAL_SEALED_TOOLS].sort()).toEqual([
      "compose",
      "composeForApp",
      "forward",
      "reply",
    ])
  })

  it("seals a reply body, its subject and the quoted original", async () => {
    const params = {
      conversationId: readyConversationId,
      subject: "APPROVALSUBJECTNONCE",
      textBody: "APPROVALBODYNONCE the drafted reply",
      htmlBody: "<p>APPROVALBODYNONCE</p>",
      quotedOriginal: "APPROVALQUOTENONCE the original mail",
      to: [{ email: "nadia@example.test" }, { email: "sam@example.test" }],
    }
    const sealed = await sealMailApprovalPayload({
      orgId,
      appName: "mail",
      toolShortName: "reply",
      approvalRequestId: crypto.randomUUID(),
      toolParams: params,
    })

    // Non-vacuity: the seal must actually have RUN and produced key material,
    // or "no phrase present" is satisfied by a function that returned {}.
    expect(sealed.mailboxSealed).toBe(true)
    expect(typeof sealed.contentKeyWrapped).toBe("string")
    expect((sealed.contentKeyWrapped as string).length).toBeGreaterThan(0)
    expect(typeof sealed.bodyCiphertext).toBe("string")
    expect(sealed.encKeyId).toBe(KEY_ID)

    const serialized = JSON.stringify(sealed)
    expect(serialized).not.toContain("APPROVALSUBJECTNONCE")
    expect(serialized).not.toContain("APPROVALBODYNONCE")
    expect(serialized).not.toContain("APPROVALQUOTENONCE")

    // What the summariser is still allowed to read.
    expect(sealed.recipientCount).toBe(2)
    expect(sealed.byteLength).toBe(
      new TextEncoder().encode("APPROVALBODYNONCE the drafted reply").byteLength,
    )
    expect(typeof sealed.subjectHash).toBe("string")

    // The envelope survives: the executed send still needs to know its target.
    expect(sealed.conversationId).toBe(readyConversationId)
    expect(sealed.to).toEqual(params.to)
  })

  it("carries NO quoted original in any form, not even sealed", async () => {
    // Spec section 15 A10: there is no version of a quoted original that an
    // approver needs, so it is dropped rather than re-encrypted.
    const sealed = await sealMailApprovalPayload({
      orgId,
      appName: "mail",
      toolShortName: "forward",
      approvalRequestId: crypto.randomUUID(),
      toolParams: {
        conversationId: readyConversationId,
        textBody: "note",
        quotedOriginal: "QUOTED",
        quoted_original: "QUOTED",
        originalBody: "QUOTED",
      },
    })
    expect(sealed.quotedOriginal).toBeUndefined()
    expect(sealed.quoted_original).toBeUndefined()
    expect(sealed.originalBody).toBeUndefined()
    expect(sealed.quotedOriginalCiphertext).toBeUndefined()
  })

  it("leaves a compose from an ORG mailbox untouched", async () => {
    // The discriminating half. Sealing every mail send would pass every negative
    // assertion above and break the majority of today's traffic.
    const params = {
      accountId: orgAccountId,
      subject: "Org subject",
      textBody: "Org body",
      to: [{ email: "x@example.test" }],
    }
    const out = await sealMailApprovalPayload({
      orgId,
      appName: "mail",
      toolShortName: "compose",
      approvalRequestId: crypto.randomUUID(),
      toolParams: params,
    })
    expect(out).toEqual(params)
  })

  it("leaves a non-mail tool untouched", async () => {
    const params = { ticketId: "t1", body: "A ticket reply body" }
    const out = await sealMailApprovalPayload({
      orgId,
      appName: "tickets",
      toolShortName: "reply",
      approvalRequestId: crypto.randomUUID(),
      toolParams: params,
    })
    expect(out).toEqual(params)
  })

  it("refuses rather than storing plaintext when the mailbox cannot be sealed to", async () => {
    // A ready mailbox whose owner has no usable identity must FAIL the staging
    // call. Falling back to a cleartext payload is the one outcome that is not
    // allowed, so the error is asserted rather than a shape.
    const strandedAccount = crypto.randomUUID()
    const strandedUser = await minimal.person(orgId)
    await withSystemDb("approval-payload-stranded", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${strandedAccount}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                ${strandedUser.id}::uuid, 'gmail', ${`${strandedAccount}@approval.test`},
                'active', 'ready')`),
    )
    let raised: unknown
    try {
      await sealMailApprovalPayload({
        orgId,
        appName: "mail",
        toolShortName: "compose",
        approvalRequestId: crypto.randomUUID(),
        toolParams: { accountId: strandedAccount, subject: "s", textBody: "b", to: [] },
      })
    } catch (err) {
      raised = err
    }
    expect(raised).toBeDefined()
    expect((raised as { code?: string }).code).toBe("NO_ACTIVE_IDENTITY_KEY")
  })

  it("seals a server-managed mailbox's draft under the mailbox's own key, never in cleartext", async () => {
    const managedAccount = crypto.randomUUID()
    const managedUser = await minimal.person(orgId)
    await withSystemDb("approval-payload-managed", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${managedAccount}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                ${managedUser.id}::uuid, 'gmail', ${`${managedAccount}@approval.test`},
                'active', 'managed')`),
    )
    const out = await sealMailApprovalPayload({
      orgId,
      appName: "mail",
      toolShortName: "compose",
      approvalRequestId: crypto.randomUUID(),
      toolParams: { accountId: managedAccount, subject: "MGDSUBJ", textBody: "MGDBODY", to: [] },
    })
    expect(JSON.stringify(out)).not.toContain("MGDBODY")
    expect(JSON.stringify(out)).not.toContain("MGDSUBJ")
    expect(typeof out.bodyCiphertext).toBe("string")
  })
})
