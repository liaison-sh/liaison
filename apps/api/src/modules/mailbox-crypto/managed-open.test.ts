// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Server-managed mailboxes end to end against the database: the data key, the
// writer's dispatch, the owner-only opener with its audit row, the arming of
// the plaintext guard, and the agent's server-side answer (read and search).
//
// The property that matters most is the wall: the owner (and a host job for
// the owner) reads a managed mailbox; an org admin and any other member do not,
// whatever their scopes; and a private (zero-access) mailbox is never opened by
// any of this code.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { answerManagedMarker } from "~/modules/agent/mailbox-plaintext/mailbox-managed-reader"
import { sealMailFields } from "~/modules/mailbox-crypto/mail-writer"
import {
  destroyMailboxServerKeys,
  ensureMailboxServerKey,
  loadMailboxServerKey,
} from "~/modules/mailbox-crypto/managed-keys"
import { openManagedFile, openManagedMailRows } from "~/modules/mailbox-crypto/managed-open"
import * as minimal from "~/seed/tiers/minimal"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

let owner: minimal.Person
let other: minimal.Person
let admin: minimal.Person
let managedAccountId: string
let readyAccountId: string
let messageId: string
let conversationId: string

async function insertManagedMessage(id: string, subject: string, body: string) {
  const sealed = await sealMailFields({
    userId: owner.id,
    orgId: owner.orgId,
    entity: "messages",
    entityId: id,
    values: { subject, textBody: body, snippet: body.slice(0, 40) },
    account: { id: managedAccountId, encryptionState: "managed" },
  })
  const c = sealed.columns
  await withSystemDb("managed-open-test-message", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.messages
        (id, org_id, account_id, conversation_id, external_message_id, owner_type, owner_id,
         direction, sent_at, labels, is_read, is_starred, raw_headers,
         subject_ciphertext, text_body_ciphertext, snippet_ciphertext,
         content_key_wrapped, enc_key_id, enc_version)
      VALUES (${id}::uuid, ${owner.orgId}::uuid, ${managedAccountId}::uuid, ${conversationId}::uuid,
              ${`ext-${id}`}, 'user', ${owner.id}::uuid, 'inbound', now(), '[]'::jsonb, false, false,
              '{}'::jsonb, ${c.subjectCiphertext as Buffer}, ${c.textBodyCiphertext as Buffer},
              ${c.snippetCiphertext as Buffer}, ${c.contentKeyWrapped as Buffer},
              ${c.encKeyId as number}, ${c.encVersion as number})`),
  )
}

beforeAll(async () => {
  await acquireTestLock()
  owner = await minimal.person((await createTestOrg()).id)
  other = await minimal.person(owner.orgId)
  admin = await minimal.person(owner.orgId, { role: "admin" })
  managedAccountId = crypto.randomUUID()
  readyAccountId = crypto.randomUUID()
  conversationId = crypto.randomUUID()
  messageId = crypto.randomUUID()
  await withSystemDb("managed-open-test-fixture", async (tx) => {
    for (const [id, state] of [
      [managedAccountId, "managed"],
      [readyAccountId, "ready"],
    ] as const) {
      await tx.execute(drizzleSql`
        INSERT INTO ${MAIL}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${id}::uuid, ${owner.orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                ${owner.id}::uuid, 'gmail', ${`${id}@managed.test`}, 'active', ${state})`)
    }
    await ensureMailboxServerKey(tx, owner.orgId, managedAccountId)
    await tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.conversations
        (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
         is_read, is_starred, message_count)
      VALUES (${conversationId}::uuid, ${owner.orgId}::uuid, ${managedAccountId}::uuid, 'user',
              ${owner.id}::uuid, 'thread-managed-1', 'open', '[]'::jsonb, false, false, 1)`)
  })
  await insertManagedMessage(messageId, "MANAGEDSUBJECTNONCE invoice", "The MANAGEDBODYNONCE text")
}, 60_000)

afterAll(async () => {
  await withSystemDb("managed-open-test-cleanup", async (tx) => {
    await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${owner.orgId}::uuid`)
    await tx.execute(
      drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${owner.orgId}::uuid`,
    )
    await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${owner.orgId}::uuid`)
    await destroyMailboxServerKeys(tx, owner.orgId, managedAccountId)
  })
  await releaseTestLock()
})

async function storedMessage(id: string) {
  return withSystemDb("managed-open-test-read", async (tx) =>
    extractRows<Record<string, unknown> & { id: string }>(
      await tx.execute(drizzleSql`SELECT * FROM ${MAIL}.messages WHERE id = ${id}::uuid`),
    ),
  )
}

describe("managed mailbox data keys", () => {
  it("mints one active key per mailbox, idempotently, wrapped (never stored raw)", async () => {
    const again = await withSystemDb("managed-open-test-ensure", (tx) =>
      ensureMailboxServerKey(tx, owner.orgId, managedAccountId),
    )
    expect(again).toBe(1)
    const rows = await withSystemDb("managed-open-test-keys", async (tx) =>
      extractRows<{ wrapped_key: string; kek_ref: string; status: string }>(
        await tx.execute(drizzleSql`
          SELECT wrapped_key, kek_ref, status FROM kernel.mailbox_server_keys
           WHERE account_id = ${managedAccountId}::uuid`),
      ),
    )
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kek_ref).toBe("env")
    const key = await withSystemDb("managed-open-test-load", (tx) =>
      loadMailboxServerKey(tx, owner.orgId, managedAccountId),
    )
    expect(key.key.byteLength).toBe(32)
    expect(rows[0]?.wrapped_key.includes(key.key.toString("hex"))).toBe(false)
  })

  it("is out of the request role's reach", async () => {
    // The request role holds no privilege on the table at all (migration
    // 0234 revoked the default grants), so even a wildcard-scoped owner is
    // refused outright rather than shown an empty result.
    const { withRlsContext } = await import("~/db/rls")
    const outcome = await withRlsContext(
      {
        actorType: "user",
        userId: owner.id,
        orgId: owner.orgId,
        scopes: ["*"],
        dimensionGrants: { "*": ["*"] },
      },
      async (tx) =>
        extractRows(await tx.execute(drizzleSql`SELECT id FROM kernel.mailbox_server_keys`)),
    ).then(
      (rows) => ({ rows: rows.length }),
      (err: unknown) => {
        const e = err as { code?: string; cause?: { code?: string } } | null
        return { code: e?.cause?.code ?? e?.code }
      },
    )
    expect(outcome).toEqual({ code: "42501" })
  })
})

describe("the writer and the opener", () => {
  it("stores version 2 ciphertext only, under the mailbox's key version", async () => {
    const [row] = await storedMessage(messageId)
    expect(Number(row?.enc_version)).toBe(2)
    expect(Number(row?.enc_key_id)).toBe(1)
    expect(row?.content_key_epk).toBeNull()
    expect(row?.subject).toBeNull()
    expect(row?.text_body).toBeNull()
    expect(Buffer.from(row?.subject_ciphertext as Uint8Array).includes("MANAGEDSUBJECTNONCE")).toBe(
      false,
    )
  })

  it("opens for the owner and writes an audit row without content", async () => {
    const rows = await storedMessage(messageId)
    const opened = await openManagedMailRows({
      orgId: owner.orgId,
      accountId: managedAccountId,
      entity: "messages",
      rows,
      actor: { userId: owner.id },
      purpose: { kind: "tool", tool: "mail__read" },
    })
    expect(opened.get(messageId)?.subject).toBe("MANAGEDSUBJECTNONCE invoice")
    expect(opened.get(messageId)?.textBody).toBe("The MANAGEDBODYNONCE text")
    const audit = await withSystemDb("managed-open-test-audit", async (tx) =>
      extractRows<{ metadata: Record<string, unknown> }>(
        await tx.execute(drizzleSql`
          SELECT metadata FROM kernel.audit_log
           WHERE org_id = ${owner.orgId}::uuid AND action = 'mail.content.decrypt'`),
      ),
    )
    expect(audit.length).toBeGreaterThan(0)
    expect(JSON.stringify(audit)).not.toContain("MANAGEDSUBJECTNONCE")
    expect(JSON.stringify(audit)).toContain(messageId)
  })

  it("opens for a host job acting for the owner", async () => {
    const opened = await openManagedMailRows({
      orgId: owner.orgId,
      accountId: managedAccountId,
      entity: "messages",
      rows: await storedMessage(messageId),
      actor: { userId: "system:mail:sync" },
      purpose: { kind: "reseal" },
    })
    expect(opened.get(messageId)?.subject).toBe("MANAGEDSUBJECTNONCE invoice")
  })

  it("refuses another member and an org admin", async () => {
    for (const reader of [other, admin]) {
      await expect(
        openManagedMailRows({
          orgId: owner.orgId,
          accountId: managedAccountId,
          entity: "messages",
          rows: await storedMessage(messageId),
          actor: { userId: reader.id },
          purpose: { kind: "web_view" },
        }),
      ).rejects.toThrow(/MAILBOX_MANAGED_ACCESS_DENIED/)
    }
  })

  it("never opens a private (version 1) row", async () => {
    const [row] = await storedMessage(messageId)
    const opened = await openManagedMailRows({
      orgId: owner.orgId,
      accountId: readyAccountId,
      entity: "messages",
      rows: [{ ...(row as { id: string }), enc_version: 1 }],
      actor: { userId: owner.id },
      purpose: { kind: "web_view" },
    })
    expect(opened.size).toBe(0)
  })

  it("arms the plaintext guard for a managed mailbox whose owner never enrolled", async () => {
    const armed = await withSystemDb("managed-open-test-armed", async (tx) =>
      extractRows<{ armed: boolean }>(
        await tx.execute(
          drizzleSql`SELECT ${MAIL}.mailbox_invariant_armed(${managedAccountId}::uuid) AS armed`,
        ),
      ),
    )
    expect(armed[0]?.armed).toBe(true)
  })
})

describe("the agent's server-side answer", () => {
  it("reads a managed message for its owner, and declines for anyone else", async () => {
    const marker = {
      requestKind: "mail.read" as const,
      messageIds: [messageId],
      purpose: "read",
    }
    const mine = await answerManagedMarker({
      orgId: owner.orgId,
      userId: owner.id,
      marker,
      purpose: { kind: "tool" },
    })
    expect(mine?.kind).toBe("plaintext")
    if (mine?.kind !== "plaintext") throw new Error("expected plaintext")
    expect(mine.items[0]?.textBody).toBe("The MANAGEDBODYNONCE text")
    const theirs = await answerManagedMarker({
      orgId: owner.orgId,
      userId: other.id,
      marker,
      purpose: { kind: "tool" },
    })
    expect(theirs).toBeNull()
  })

  it("searches the owner's managed mail server-side when no private mailbox is in scope", async () => {
    const found = await answerManagedMarker({
      orgId: owner.orgId,
      userId: owner.id,
      marker: {
        requestKind: "mail.search",
        messageIds: [],
        purpose: "search",
        search: { query: "managedsubjectnonce", filters: { accountId: managedAccountId } },
      },
      purpose: { kind: "search" },
    })
    expect(found).toEqual({ kind: "search", messageIds: [messageId], indexComplete: true })
    const none = await answerManagedMarker({
      orgId: owner.orgId,
      userId: owner.id,
      marker: {
        requestKind: "mail.search",
        messageIds: [],
        purpose: "search",
        search: { query: "absent-word", filters: { accountId: managedAccountId } },
      },
      purpose: { kind: "search" },
    })
    expect(none).toEqual({ kind: "search", messageIds: [], indexComplete: true })
    // A private mailbox in scope: only its browser can search it.
    const mixed = await answerManagedMarker({
      orgId: owner.orgId,
      userId: owner.id,
      marker: {
        requestKind: "mail.search",
        messageIds: [],
        purpose: "search",
        search: { query: "managedsubjectnonce" },
      },
      purpose: { kind: "search" },
    })
    expect(mixed).toBeNull()
  })
})

describe("review: walls of the opener", () => {
  async function rows() {
    return storedMessage(messageId)
  }

  it("refuses another app's host job, and the mail app's own job for anything but a re-seal", async () => {
    for (const [actor, purpose] of [
      ["system:google-drive", { kind: "reseal" }],
      ["system:mail:sync", { kind: "web_view" }],
      ["system:mail:sync", { kind: "tool" }],
    ] as const) {
      await expect(
        openManagedMailRows({
          orgId: owner.orgId,
          accountId: managedAccountId,
          entity: "messages",
          rows: await rows(),
          actor: { userId: actor },
          purpose,
        }),
      ).rejects.toThrow(/MAILBOX_MANAGED_ACCESS_DENIED/)
    }
  })

  it("opens only a mailbox that is server-managed", async () => {
    await expect(
      openManagedMailRows({
        orgId: owner.orgId,
        accountId: readyAccountId,
        entity: "messages",
        rows: (await rows()).map((r) => ({ ...r, account_id: readyAccountId })),
        actor: { userId: owner.id },
        purpose: { kind: "web_view" },
      }),
    ).rejects.toThrow(/not server-managed/)
  })

  it("a wrapped key moved to another mailbox does not open", async () => {
    const thief = crypto.randomUUID()
    await withSystemDb("managed-open-test-move-key", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.mailbox_server_keys (org_id, account_id, key_version, wrapped_key)
        SELECT org_id, ${thief}::uuid, key_version, wrapped_key FROM kernel.mailbox_server_keys
         WHERE account_id = ${managedAccountId}::uuid`),
    )
    await expect(
      withSystemDb("managed-open-test-load-moved", (tx) =>
        loadMailboxServerKey(tx, owner.orgId, thief),
      ),
    ).rejects.toThrow()
    await withSystemDb("managed-open-test-move-key-cleanup", (tx) =>
      destroyMailboxServerKeys(tx, owner.orgId, thief),
    )
  })

  it("never consents to a conversion on the owner's behalf", async () => {
    const answer = await answerManagedMarker({
      orgId: owner.orgId,
      userId: owner.id,
      marker: { requestKind: "mail.convert", messageIds: [messageId], purpose: "convert" },
      purpose: { kind: "tool" },
    })
    expect(answer?.kind).toBe("denied")
  })

  it("an attachment opens for its owner only, checked before storage is read", async () => {
    const fileId = crypto.randomUUID()
    await withSystemDb("managed-open-test-file", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
                                  size_bytes, storage_key, enc_version, enc_key_id, content_key_wrapped)
        VALUES (${fileId}::uuid, ${owner.orgId}::uuid, 'mail', 'message', ${messageId}::uuid,
                'a.pdf', 'application/pdf', 3, ${`managed-open-test/${fileId}`}, 2, 1,
                ${Buffer.alloc(60, 1)})`),
    )
    try {
      for (const reader of [other.id, admin.id, "system:google-drive"]) {
        await expect(
          // Production opens a file on an org privileged transaction (the
          // make-private conversion, the agent's attachment read) or a request one.
          withPrivilegedDb(owner.orgId, "managed-open-test-file-read", (tx) =>
            openManagedFile(tx, {
              orgId: owner.orgId,
              userId: reader,
              fileId,
              purpose: { kind: "tool", tool: "multipart" },
            }),
          ),
        ).rejects.toThrow(/MAILBOX_MANAGED_ACCESS_DENIED/)
      }
    } finally {
      await withSystemDb("managed-open-test-file-cleanup", (tx) =>
        tx.execute(drizzleSql`DELETE FROM kernel.files WHERE id = ${fileId}::uuid`),
      )
    }
  })
})
