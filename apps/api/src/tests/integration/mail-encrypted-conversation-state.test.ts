// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-INT-6: `recomputeConversationState` must not blank a sealed snippet.
//
// This is the subtlest bug the encryption feature can produce. The function
// re-derives a conversation's state from its stored message rows and is called
// from ordinary operations long after ingest, with no key material anywhere in
// reach. Under encryption the plaintext `snippet` of every message is NULL, so
// the pre-encryption code would have written NULL over the conversation's
// sealed snippet on every archive or relabel, silently, with no error anywhere.
//
// The bridge here is the REAL one, for the same reason T-INT-1 gives.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { openField, unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL_SCHEMA = schemaRef("app_mail")
const KEY_ID = 44

describe("T-INT-6: archiving an encrypted conversation keeps its sealed snippet", () => {
  let bundle: string
  let orgId: string
  let userId: string
  let keys: CryptoKeyPair

  beforeAll(async () => {
    await acquireAppSchemaJsLock("app_mail")
    const user = await minimal.person((await createTestOrg()).id)
    orgId = user.orgId
    userId = user.id
    await registerApps([mailAppManifest as unknown as AppDescriptor], orgId)

    const ecdh = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ])) as unknown as CryptoKeyPair
    const sign = (await crypto.subtle.generateKey({ name: "Ed25519" }, true, [
      "sign",
      "verify",
    ])) as unknown as CryptoKeyPair
    keys = ecdh
    const ecdhSpki = Buffer.from(await crypto.subtle.exportKey("spki", ecdh.publicKey))
    const signSpki = Buffer.from(await crypto.subtle.exportKey("spki", sign.publicKey))
    await withSystemDb("t-int-6-enroll", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO kernel.user_mailbox_identities
          (org_id, user_id, key_id, ecdh_public_key, sign_public_key, keyring_attestation, status)
        VALUES (${orgId}::uuid, ${userId}::uuid, ${KEY_ID}, ${ecdhSpki}, ${signSpki},
                ${Buffer.from("attestation")}, 'active')`),
    )

    const { initSandboxPool } = await import("~/modules/apps/sandbox/pool")
    const { loadBundle } = await import("~/modules/apps/sandbox/bundle-loader")
    await initSandboxPool()
    const nodePath = await import("node:path")
    const source = await loadBundle(
      nodePath.resolve(import.meta.dir, "../../apps/mail/handlers.ts"),
    )
    bundle = `${source}
async function __test_processMessages(params, ctx) { await processMessages(params.messages, params.account, ctx) }
async function __test_recompute(params, ctx) { await recomputeConversationState(params.conversationId, params.account, ctx) }`
  }, 120_000)

  afterAll(async () => {
    await releaseAppSchemaJsLock("app_mail")
  })

  async function makeAccount(): Promise<string> {
    const id = crypto.randomUUID()
    await withSystemDb("t-int-6-account", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                ${userId}::uuid, 'gmail', ${`${id}@enc.test`}, 'active', 'ready')`),
    )
    return id
  }

  async function run(exportName: string, params: Record<string, unknown>): Promise<void> {
    // The jobs pool, as the mail job that runs this in production: the host's
    // short privileged reads under the bridge (sender contacts) must not nest.
    await withPrivilegedDb(
      orgId,
      "t-int-6-run",
      async (tx) => {
        const real = createRpcBridge(
          "mail",
          userId,
          orgId,
          tx as unknown as RlsClient,
          mailAppManifest as never,
        )
        const bridge: Record<string, any> = {
          ...real,
          emit: async () => {},
          enqueueJob: async () => {},
          resolveContact: async () => JSON.stringify({ id: crypto.randomUUID() }),
          log_info: () => {},
          log_warn: () => {},
          log_error: () => {},
          log_debug: () => {},
        }
        const { executeInSandbox } = await import("~/modules/apps/sandbox/executor")
        const { getSandboxPool } = await import("~/modules/apps/sandbox/pool")
        await executeInSandbox({
          pool: getSandboxPool(),
          bundleSource: bundle,
          exportName,
          params,
          bridge,
          timeoutMs: 60_000,
        } as any)
      },
      { pool: "jobs" },
    )
  }

  async function conversationOf(accountId: string): Promise<any> {
    const [row] = await withSystemDb("t-int-6-conv", async (tx) =>
      extractRows<any>(
        await tx.execute(
          drizzleSql`SELECT * FROM ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.conversations WHERE account_id = ${accountId}::uuid`,
        ),
      ),
    )
    return row
  }

  function fixture(i: number, threadId: string) {
    return {
      externalMessageId: `<t6-${crypto.randomUUID()}@example.test>`,
      externalProviderId: `p${i}`,
      externalThreadId: threadId,
      from: { email: "alice@example.test" },
      to: [{ email: "bob@example.test" }],
      cc: [],
      bcc: [],
      subject: `Subject ${i}`,
      textBody: `Body ${i}`,
      htmlBody: `<p>Body ${i}</p>`,
      snippet: `Snippet number ${i}`,
      headers: { "message-id": `<t6-${i}@example.test>` },
      inReplyTo: null,
      references: [],
      labels: ["INBOX"],
      isRead: false,
      isStarred: false,
      sentAt: new Date(Date.UTC(2026, 1, 2, 9, i)).toISOString(),
      direction: "inbound",
    }
  }

  // The account row recomputeConversationState reads: it decides whether a
  // plaintext snippet may be written back, so every caller has to carry it.
  function sealedAccount(accountId: string) {
    return {
      id: accountId,
      owner_type: "user",
      owner_id: userId,
      encryption_state: "ready",
    }
  }

  async function seededConversation(): Promise<{ accountId: string; conv: any }> {
    const accountId = await makeAccount()
    const threadId = `<t6-thread-${crypto.randomUUID()}@example.test>`
    await run("__test_processMessages", {
      messages: [fixture(1, threadId)],
      account: sealedAccount(accountId),
    })
    const conv = await conversationOf(accountId)
    // Non-vacuity: the fixture really did produce a sealed conversation, so a
    // "still sealed afterwards" assertion cannot pass on an empty row.
    expect(conv, "the fixture must have created a conversation").toBeDefined()
    expect(conv.enc_version).toBe(1)
    expect(conv.snippet_ciphertext?.length ?? 0).toBeGreaterThan(0)
    expect(conv.snippet).toBeNull()
    return { accountId, conv }
  }

  async function openSnippet(conv: any): Promise<string> {
    const contentKey = await unsealContentKey({
      privateKey: keys.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
      userId,
      keyId: KEY_ID,
      wrapped: new Uint8Array(conv.content_key_wrapped),
      epkSpki: new Uint8Array(conv.content_key_epk),
    })
    const opened = await openField({
      contentKey,
      // The AAD stays the MESSAGE context: the conversation snippet is a
      // pointer, and `snippet_source_message_id` records which message.
      context: mailboxAad.messageSnippet(conv.snippet_source_message_id),
      blob: new Uint8Array(conv.snippet_ciphertext),
    })
    return new TextDecoder().decode(opened)
  }

  it("a recompute after archiving leaves the sealed snippet byte identical", async () => {
    const { accountId, conv } = await seededConversation()
    const before = Buffer.from(conv.snippet_ciphertext).toString("base64")
    expect(await openSnippet(conv)).toBe("Snippet number 1")

    await withSystemDb("t-int-6-archive", (tx) =>
      tx.execute(
        drizzleSql`UPDATE ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.conversations SET status = 'archived' WHERE id = ${conv.id}::uuid`,
      ),
    )
    await run("__test_recompute", { conversationId: conv.id, account: sealedAccount(accountId) })

    const after = await conversationOf(accountId)
    expect(after.snippet).toBeNull()
    expect(Buffer.from(after.snippet_ciphertext).toString("base64")).toBe(before)
    expect(after.snippet_source_message_id).toBe(conv.snippet_source_message_id)
    expect(await openSnippet(after)).toBe("Snippet number 1")
  }, 120_000)

  it("a recompute after relabelling leaves the sealed snippet byte identical", async () => {
    const { accountId, conv } = await seededConversation()
    const before = Buffer.from(conv.snippet_ciphertext).toString("base64")
    await withSystemDb("t-int-6-relabel", (tx) =>
      tx.execute(
        drizzleSql`UPDATE ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.messages SET labels = '["INBOX","IMPORTANT"]'::jsonb WHERE account_id = ${accountId}::uuid`,
      ),
    )
    await run("__test_recompute", { conversationId: conv.id, account: sealedAccount(accountId) })
    const after = await conversationOf(accountId)
    expect(after.labels).toContain("IMPORTANT")
    expect(after.snippet).toBeNull()
    expect(Buffer.from(after.snippet_ciphertext).toString("base64")).toBe(before)
    expect(await openSnippet(after)).toBe("Snippet number 1")
  }, 120_000)

  it("a recompute after the newest message is deleted repoints at the remaining one", async () => {
    // The case that actually falsifies the pointer rule. Without it the
    // conversation keeps the ciphertext and the source id of a message that no
    // longer exists, and the client asks for an AAD it can never satisfy.
    const accountId = await makeAccount()
    const threadId = `<t6-thread-${crypto.randomUUID()}@example.test>`
    const account = sealedAccount(accountId)
    await run("__test_processMessages", { messages: [fixture(1, threadId)], account })
    await run("__test_processMessages", { messages: [fixture(2, threadId)], account })

    const withTwo = await conversationOf(accountId)
    expect(withTwo.message_count).toBe(2)
    expect(await openSnippet(withTwo)).toBe("Snippet number 2")

    await withSystemDb("t-int-6-drop-newest", (tx) =>
      tx.execute(
        drizzleSql`DELETE FROM ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.messages
                    WHERE id = ${withTwo.snippet_source_message_id}::uuid`,
      ),
    )
    await run("__test_recompute", { conversationId: withTwo.id, account: sealedAccount(accountId) })

    const after = await conversationOf(accountId)
    expect(after.snippet).toBeNull()
    expect(after.snippet_source_message_id).not.toBe(withTwo.snippet_source_message_id)
    expect(await openSnippet(after)).toBe("Snippet number 1")
  }, 120_000)

  it("the zero message branch NULLs both representations together", async () => {
    const { accountId, conv } = await seededConversation()
    await withSystemDb("t-int-6-delete", (tx) =>
      tx.execute(
        drizzleSql`DELETE FROM ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.messages WHERE account_id = ${accountId}::uuid`,
      ),
    )
    await run("__test_recompute", { conversationId: conv.id, account: sealedAccount(accountId) })
    const after = await conversationOf(accountId)
    expect(after.message_count).toBe(0)
    expect(after.snippet).toBeNull()
    expect(after.snippet_ciphertext).toBeNull()
    expect(after.snippet_source_message_id).toBeNull()
  }, 120_000)
})
