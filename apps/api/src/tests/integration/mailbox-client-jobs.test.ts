// SPDX-License-Identifier: FSL-1.1-ALv2
//
// T-INT-5: the client job queue, end to end against real rows.
//
// The queue is the headless-work replacement. A server-side trigger may look at
// the ENVELOPE of a message and nothing else, so the row it writes carries ids,
// correspondents, labels and filenames, never a subject and never a body. The
// browser claims that row when the user is next online and unlocked, decrypts
// locally, runs a normal SERVER-SIDE agent turn, and posts back a result that is
// sealed to the user's own key. The server therefore never holds plaintext on
// either side of the queue.
//
// The bridge here is the REAL one, and the trigger is evaluated by the REAL
// sandboxed mail handler bundle: a stub bridge would prove nothing about the
// only property that matters, which is what lands in the table.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mailboxAad } from "@liaison/mailbox-crypto/src/aad"
import { openField, unsealContentKey } from "@liaison/mailbox-crypto/src/client"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type RlsClient } from "~/db"
import { withPrivilegedDb, withSystemDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { schemaRef } from "~/db/schema-ref"
import type { AppDescriptor } from "~/modules/apps/runtime"
import { registerApps } from "~/modules/apps/runtime"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"
import { sealForUser } from "~/modules/mailbox-crypto/seal-service"
import * as jobs from "~/modules/mailbox-jobs/service"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"

const MAIL_SCHEMA = schemaRef("app_mail")
const KEY_ID = 51

/** The subject and body text the fixture seals. Nothing in the queue row may
 *  contain either of them, in any encoding. */
const FIXTURE_SUBJECT = "Zarquon quarterly forecast"
const FIXTURE_BODY = "The pangolin numbers are attached and they are bad."
const FIXTURE_SNIPPET = "The pangolin numbers are attached"

describe("T-INT-5: the mailbox client job queue", () => {
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
    await withSystemDb("t-int-5-enroll", (tx) =>
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
async function __test_processMessages(params, ctx) { await processMessages(params.messages, params.account, ctx) }`
  }, 120_000)

  afterAll(async () => {
    await releaseAppSchemaJsLock("app_mail")
  })

  function rls<T>(fn: (tx: RlsClient) => Promise<T>): Promise<T> {
    return withRlsContext(
      { actorType: "user", userId, orgId, scopes: ["mail:*"], dimensionGrants: {}, roles: [] },
      fn,
    )
  }

  async function makeAccount(rules: unknown[]): Promise<{ id: string; row: any }> {
    const id = crypto.randomUUID()
    await withSystemDb("t-int-5-account", (tx) =>
      tx.execute(drizzleSql`
        INSERT INTO ${drizzleSql.raw(`"${MAIL_SCHEMA}"`)}.accounts
          (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
           sync_status, encryption_state)
        VALUES (${id}::uuid, ${orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
                ${userId}::uuid, 'gmail', ${`${id}@jobs.test`}, 'active', 'ready')`),
    )
    return {
      id,
      row: {
        id,
        owner_type: "user",
        owner_id: userId,
        encryption_state: "ready",
        envelope_trigger_rules: rules,
      },
    }
  }

  async function ingest(account: any, message: Record<string, unknown>): Promise<void> {
    await withPrivilegedDb(orgId, "t-int-5-run", async (tx) => {
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
        exportName: "__test_processMessages",
        params: { messages: [message], account },
        bridge,
        timeoutMs: 60_000,
      } as any)
    })
  }

  function fixture(overrides: Record<string, unknown> = {}) {
    return {
      externalMessageId: `<t5-${crypto.randomUUID()}@example.test>`,
      externalProviderId: "p1",
      externalThreadId: `<t5-thread-${crypto.randomUUID()}@example.test>`,
      from: { email: "alice@example.test", name: "Alice" },
      to: [{ email: "bob@example.test" }],
      cc: [],
      bcc: [],
      subject: FIXTURE_SUBJECT,
      textBody: FIXTURE_BODY,
      htmlBody: `<p>${FIXTURE_BODY}</p>`,
      snippet: FIXTURE_SNIPPET,
      headers: { "message-id": "<t5-1@example.test>" },
      inReplyTo: null,
      references: [],
      labels: ["INBOX", "Finance"],
      isRead: false,
      isStarred: false,
      sentAt: new Date(Date.UTC(2026, 7, 20, 9, 0)).toISOString(),
      direction: "inbound",
      attachments: [],
      ...overrides,
    }
  }

  async function jobRows(): Promise<any[]> {
    return withSystemDb("t-int-5-jobs", async (tx) =>
      extractRows<any>(
        await tx.execute(drizzleSql`
          SELECT * FROM kernel.mailbox_client_jobs
          WHERE user_id = ${userId}::uuid ORDER BY created_at`),
      ),
    )
  }

  async function clearJobs(): Promise<void> {
    await withSystemDb("t-int-5-clear", (tx) =>
      tx.execute(
        drizzleSql`DELETE FROM kernel.mailbox_client_jobs WHERE user_id = ${userId}::uuid`,
      ),
    )
  }

  const summariseRule = {
    id: "finance-attachments",
    kind: "summarise",
    when: { fromDomain: ["example.test"], anyLabel: ["Finance"] },
  }

  it("an envelope trigger enqueues exactly one job, and its payload holds no body or subject", async () => {
    await clearJobs()
    const account = await makeAccount([summariseRule])
    await ingest(account.row, fixture())

    const rows = await jobRows()
    // Non-vacuity: the trigger really fired, on a real ingest, into a real row.
    expect(rows.length).toBe(1)
    const row = rows[0]
    expect(row.kind).toBe("summarise")
    expect(row.status).toBe("pending")
    expect(row.attempts).toBe(0)
    expect(row.expires_at).not.toBeNull()

    const payload = row.payload as Record<string, unknown>
    expect(Object.keys(payload).length).toBeGreaterThan(0)
    expect(Array.isArray(payload.messageIds)).toBe(true)
    expect((payload.messageIds as string[]).length).toBe(1)
    expect(payload.ruleId).toBe("finance-attachments")
    expect(payload.fromEmail).toBe("alice@example.test")
    expect(payload.labels).toEqual(["INBOX", "Finance"])

    // The assertion the whole phase exists for: the row's text carries no
    // fragment of what the message said.
    const asText = JSON.stringify(payload)
    expect(asText).not.toContain(FIXTURE_SUBJECT)
    expect(asText).not.toContain(FIXTURE_BODY)
    expect(asText).not.toContain(FIXTURE_SNIPPET)
    expect(asText.toLowerCase()).not.toContain("pangolin")
    expect(asText.toLowerCase()).not.toContain("zarquon")
  }, 120_000)

  it("a rule that does not match the envelope enqueues nothing", async () => {
    await clearJobs()
    const account = await makeAccount([
      { id: "other", kind: "summarise", when: { fromDomain: ["nobody.test"] } },
    ])
    await ingest(account.row, fixture())
    expect((await jobRows()).length).toBe(0)
  }, 120_000)

  it("a rule keyed on body text is refused: the trigger surface is envelope only", async () => {
    await clearJobs()
    const account = await makeAccount([
      // A "body contains" condition is not part of the rule language at all, so
      // the rule is invalid and is dropped rather than silently matching
      // everything. That is what makes the queue's promise checkable.
      { id: "body-rule", kind: "summarise", when: { bodyContains: ["pangolin"] } },
    ])
    await ingest(account.row, fixture())
    expect((await jobRows()).length).toBe(0)
  }, 120_000)

  it("two sessions claiming the same job concurrently: exactly one wins", async () => {
    await clearJobs()
    const account = await makeAccount([summariseRule])
    await ingest(account.row, fixture())
    const [row] = await jobRows()

    const results = await Promise.allSettled([
      rls((tx) => jobs.claimJob(tx, userId, orgId, row.id, "session-a")),
      rls((tx) => jobs.claimJob(tx, userId, orgId, row.id, "session-b")),
    ])
    const won = results.filter((r) => r.status === "fulfilled")
    const lost = results.filter((r) => r.status === "rejected")
    expect(won.length).toBe(1)
    expect(lost.length).toBe(1)

    const after = (await jobRows())[0]
    expect(after.status).toBe("claimed")
    expect(["session-a", "session-b"]).toContain(after.claimed_by_session)
    expect(after.attempts).toBe(1)
    expect(new Date(after.lease_expires_at).getTime()).toBeGreaterThan(Date.now())
  }, 120_000)

  it("a claimed job is completed with a result sealed to the user's own key", async () => {
    await clearJobs()
    const account = await makeAccount([summariseRule])
    await ingest(account.row, fixture())
    const [row] = await jobRows()
    await rls((tx) => jobs.claimJob(tx, userId, orgId, row.id, "session-a"))

    // What the browser does after its SERVER-SIDE turn returns: seal the result
    // to the mailbox owner's own key and post the ciphertext back.
    //
    // In production that seal is the D7 index-key path, whose key the client
    // re-derives from its Account Key and the shard id, so NO key material ever
    // reaches the server. This test holds an identity private key rather than an
    // Account Key, so it seals through the ECDH identity path and keeps the
    // wrapped content key in local memory, never handing it to the server. The
    // server stores one opaque blob either way, which is exactly the point: it
    // has no way to open what it is holding.
    const summary = "Three attachments, one overdue invoice."
    const sealed = await sealForUser(userId, orgId, [
      {
        context: { kind: "index", entityId: row.id, shardId: `client-job:${row.id}` },
        plaintext: summary,
      },
    ])

    await rls((tx) =>
      jobs.completeJob(tx, userId, orgId, row.id, {
        sessionId: "session-a",
        status: "done",
        resultCiphertext: Buffer.from(sealed.items[0]!.ciphertext).toString("base64"),
      }),
    )

    const done = (await jobRows())[0]
    expect(done.status).toBe("done")
    expect(done.completed_at).not.toBeNull()
    expect(done.result_ciphertext?.length ?? 0).toBeGreaterThan(0)

    const contentKey = await unsealContentKey({
      privateKey: keys.privateKey,
      recipientEcdhSpki: new Uint8Array(await crypto.subtle.exportKey("spki", keys.publicKey)),
      userId,
      keyId: KEY_ID,
      wrapped: new Uint8Array(sealed.contentKeyWrapped) as Uint8Array<ArrayBuffer>,
      epkSpki: new Uint8Array(sealed.contentKeyEpk) as Uint8Array<ArrayBuffer>,
    })
    const opened = await openField({
      contentKey,
      context: mailboxAad.index(userId, `client-job:${row.id}`),
      blob: new Uint8Array(done.result_ciphertext),
    })
    expect(new TextDecoder().decode(opened)).toBe(summary)
  }, 120_000)

  it("a dropped lease returns the job to pending, and the fourth attempt finds it failed", async () => {
    await clearJobs()
    const account = await makeAccount([summariseRule])
    await ingest(account.row, fixture())
    const [row] = await jobRows()

    async function expireLease() {
      await withSystemDb("t-int-5-expire", (tx) =>
        tx.execute(drizzleSql`
          UPDATE kernel.mailbox_client_jobs SET lease_expires_at = now() - interval '1 minute'
          WHERE id = ${row.id}::uuid`),
      )
    }

    await rls((tx) => jobs.claimJob(tx, userId, orgId, row.id, "s1"))
    await expireLease()
    // The tab died. The sweep hands the job back rather than stranding it.
    await rls((tx) => jobs.listJobs(tx, userId, orgId))
    let current = (await jobRows())[0]
    expect(current.status).toBe("pending")
    expect(current.attempts).toBe(1)
    expect(current.claimed_by_session).toBeNull()

    await rls((tx) => jobs.claimJob(tx, userId, orgId, row.id, "s2"))
    await expireLease()
    await rls((tx) => jobs.listJobs(tx, userId, orgId))
    current = (await jobRows())[0]
    expect(current.status).toBe("pending")
    expect(current.attempts).toBe(2)

    await rls((tx) => jobs.claimJob(tx, userId, orgId, row.id, "s3"))
    await expireLease()
    await rls((tx) => jobs.listJobs(tx, userId, orgId))
    current = (await jobRows())[0]
    // Three attempts spent: the job stops retrying and becomes visible instead.
    expect(current.attempts).toBe(3)
    expect(current.status).toBe("failed")

    await expect(rls((tx) => jobs.claimJob(tx, userId, orgId, row.id, "s4"))).rejects.toThrow()
    expect((await jobRows())[0].status).toBe("failed")
  }, 120_000)

  it("a job past its expiry becomes expired, stays visible and is never claimable", async () => {
    await clearJobs()
    const account = await makeAccount([summariseRule])
    await ingest(account.row, fixture())
    const [row] = await jobRows()
    await withSystemDb("t-int-5-age", (tx) =>
      tx.execute(drizzleSql`
        UPDATE kernel.mailbox_client_jobs SET expires_at = now() - interval '1 second'
        WHERE id = ${row.id}::uuid`),
    )

    const listed = await rls((tx) => jobs.listJobs(tx, userId, orgId))
    const view = listed.find((job) => job.id === row.id)
    // Surfaced, not dropped: an expired job the user never saw is a silent
    // failure, which is the one outcome this queue may not have.
    expect(view?.status).toBe("expired")
    await expect(rls((tx) => jobs.claimJob(tx, userId, orgId, row.id, "s1"))).rejects.toThrow()
  }, 120_000)
})
