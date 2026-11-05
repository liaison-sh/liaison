// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `raw_headers` that is not a JSON object, across the three purge queries that
// enumerate its keys.
//
// `jsonb_object_keys` RAISES on a scalar, a string or an array
// ("cannot call jsonb_object_keys on a scalar"), and the purge called it
// unguarded. Real ingest always writes an object, so this is robustness rather
// than a live prod defect, but the place it raised was step 7b, which is inside
// the destructive run: an abort there leaves a mailbox half purged, at the one
// moment in this feature where a half-finished state is hardest to reason
// about.
//
// The rule this file pins, and it is a rule about content, not only about not
// crashing: a `raw_headers` that is not an object is NOT an allowlisted header
// map, so it counts as carrying content outside the allowlist, it is gated on
// like any other unsealed header content, and the reduction replaces it. A
// guard that merely skipped such a row would leave the purge reporting a clean
// mailbox with the value still sitting there.

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { mailAppManifest } from "~/apps/mail/manifest-descriptor"
import { extractRows, type PrivilegedDb } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { schemaRef } from "~/db/schema-ref"
import { type AppDescriptor, registerApps } from "~/modules/apps/runtime"
import {
  assertFullySealed,
  countRemainingPlaintext,
  MailboxAckError,
  reduceRawHeadersBatch,
} from "~/modules/mailbox-crypto/purge"
import * as minimal from "~/seed/tiers/minimal"
import { acquireAppSchemaJsLock, releaseAppSchemaJsLock } from "~/tests/helpers/app-schema-lock"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const MAIL = drizzleSql.raw(`"${schemaRef("app_mail")}"`)

let user: minimal.Person
let accountId: string
let conversationId: string

/** Every shape `raw_headers` can hold that is not an object. */
const NON_OBJECT_HEADERS = ['"a bare string"', "[1, 2, 3]", "42", "true", "null"]

async function seedMessage(rawHeaders: string, sealHeaders: boolean): Promise<string> {
  const id = crypto.randomUUID()
  const ciphertext = Buffer.from("ciphertext")
  await withSystemDb("purge-raw-headers-seed", (tx) =>
    tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.messages
        (id, org_id, conversation_id, account_id, owner_type, owner_id, external_message_id,
         from_address, to_addresses, direction, raw_headers, raw_headers_ciphertext,
         content_key_wrapped, content_key_epk, enc_key_id, enc_version, created_at)
      VALUES (${id}::uuid, ${user.orgId}::uuid, ${conversationId}::uuid, ${accountId}::uuid,
              'user', ${user.id}::uuid, ${`<hdr-${id}@purge.test>`},
              ${JSON.stringify({ email: "sender@purge.test" })}::jsonb,
              ${JSON.stringify([{ email: "me@purge.test" }])}::jsonb, 'inbound',
              ${drizzleSql.raw(`'${rawHeaders}'::jsonb`)},
              ${sealHeaders ? ciphertext : null},
              ${ciphertext}, ${ciphertext}, 1, 1, now())`),
  )
  return id
}

async function readHeaders(id: string): Promise<unknown> {
  return extractRows<{ raw_headers: unknown }>(
    await withSystemDb("purge-raw-headers-read", (tx) =>
      tx.execute(drizzleSql`SELECT raw_headers FROM ${MAIL}.messages WHERE id = ${id}::uuid`),
    ),
  )[0]?.raw_headers
}

beforeAll(async () => {
  await acquireTestLock()
  await acquireAppSchemaJsLock("app_mail")
  user = await minimal.person((await createTestOrg()).id)
  await registerApps([mailAppManifest as unknown as AppDescriptor], user.orgId)
  accountId = crypto.randomUUID()
  conversationId = crypto.randomUUID()
  await withSystemDb("purge-raw-headers-seed-account", async (tx) => {
    await tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.accounts
        (id, org_id, connected_account_id, owner_type, owner_id, provider, email_address,
         sync_status, encryption_state)
      VALUES (${accountId}::uuid, ${user.orgId}::uuid, ${crypto.randomUUID()}::uuid, 'user',
              ${user.id}::uuid, 'gmail', ${`${accountId}@purge.test`}, 'active', 'ready')`)
    await tx.execute(drizzleSql`
      INSERT INTO ${MAIL}.conversations
        (id, org_id, account_id, owner_type, owner_id, external_thread_id, status, labels,
         is_read, is_starred, message_count, from_email)
      VALUES (${conversationId}::uuid, ${user.orgId}::uuid, ${accountId}::uuid, 'user',
              ${user.id}::uuid, ${`thread-${conversationId}`}, 'open', '[]'::jsonb,
              false, false, 0, 'sender@purge.test')`)
  })
}, 120_000)

afterAll(async () => {
  await releaseAppSchemaJsLock("app_mail")
  if (user) {
    await withSystemDb("purge-raw-headers-cleanup", async (tx) => {
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE org_id = ${user.orgId}::uuid`)
      await tx.execute(
        drizzleSql`DELETE FROM ${MAIL}.conversations WHERE org_id = ${user.orgId}::uuid`,
      )
      await tx.execute(drizzleSql`DELETE FROM ${MAIL}.accounts WHERE org_id = ${user.orgId}::uuid`)
    })
  }
  await releaseTestLock()
})

async function clearMessages(): Promise<void> {
  await withSystemDb("purge-raw-headers-clear", (tx) =>
    tx.execute(drizzleSql`DELETE FROM ${MAIL}.messages WHERE account_id = ${accountId}::uuid`),
  )
}

describe("the purge over a raw_headers that is not an object", () => {
  test("counting what is left does not raise on any non-object shape", async () => {
    await clearMessages()
    for (const shape of NON_OBJECT_HEADERS) await seedMessage(shape, true)

    const remaining = await withSystemDb("purge-raw-headers-count", (tx) =>
      countRemainingPlaintext(tx as unknown as Pick<PrivilegedDb, "execute">, [accountId]),
    )
    // Non-vacuity, and the content rule: JSON `null` carries nothing, the other
    // four carry something the allowlist cannot vouch for and must be counted.
    // A guard that just skipped them would report a clean mailbox.
    expect(remaining.messagesWithNonAllowlistedHeaders).toBe(NON_OBJECT_HEADERS.length - 1)
  })

  test("the pre-purge gate does not raise, and still refuses unsealed header content", async () => {
    await clearMessages()
    const sealed = await seedMessage('"a bare string"', true)
    expect(sealed).toBeTruthy()
    // Sealed: nothing to refuse.
    await withSystemDb("purge-raw-headers-gate-ok", (tx) =>
      assertFullySealed(tx as unknown as Pick<PrivilegedDb, "execute">, [accountId]),
    )

    // The same value with NO header ciphertext behind it is exactly the case
    // the gate exists for: reducing it would destroy content nothing sealed.
    await seedMessage("[1, 2, 3]", false)
    const error = await withSystemDb("purge-raw-headers-gate-refuse", (tx) =>
      assertFullySealed(tx as unknown as Pick<PrivilegedDb, "execute">, [accountId]).then(
        () => null,
        (e: unknown) => e,
      ),
    )
    expect(error).toBeInstanceOf(MailboxAckError)
  })

  test("the destructive header reduction replaces a non-object rather than aborting", async () => {
    await clearMessages()
    const ids: string[] = []
    for (const shape of NON_OBJECT_HEADERS) ids.push(await seedMessage(shape, true))
    // One ordinary row, so the reduction's normal behaviour is proved in the
    // same run: allowlisted keys survive, the rest go.
    const ordinary = await seedMessage(
      JSON.stringify({ "message-id": "<a@b>", subject: "secret", "x-spam": "1" }).replace(
        /'/g,
        "''",
      ),
      true,
    )

    const reduced = await withSystemDb("purge-raw-headers-reduce", (tx) =>
      reduceRawHeadersBatch(tx as unknown as Pick<PrivilegedDb, "execute">, [accountId], 200),
    )
    // The four non-null non-object rows plus the ordinary one. JSON `null`
    // carries nothing and is not rewritten.
    expect(reduced).toBe(NON_OBJECT_HEADERS.length)

    for (const id of ids.slice(0, 4)) expect(await readHeaders(id)).toEqual({})
    expect(await readHeaders(ordinary)).toEqual({ "message-id": "<a@b>" })

    // Idempotent: a second pass finds nothing to do, which is what makes the
    // batching loop terminate.
    const again = await withSystemDb("purge-raw-headers-reduce-again", (tx) =>
      reduceRawHeadersBatch(tx as unknown as Pick<PrivilegedDb, "execute">, [accountId], 200),
    )
    expect(again).toBe(0)
  })
})
