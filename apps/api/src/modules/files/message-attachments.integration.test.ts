// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A deleted message's attachments are gone, and unreadable even where a row
 * survived (messages deleted before deletion took their files along).
 *
 * Real Postgres: the files SELECT policy and the parent-visibility check are
 * what is under test, not the service code that happens to call them.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import postgres from "postgres"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { attachFilesToParent } from "~/modules/files/attach"
import { enqueueObjectDeleteForEvent } from "~/modules/files/delete-object-job"
import { purgeDeletedMessageAttachments } from "~/modules/files/message-attachments"
import {
  assertParentVisible,
  confirmUpload,
  FileServiceError,
  getDownloadUrl,
  isRelayedFileServable,
  lockLiveParent,
  resolveParent,
  signFileToken,
} from "~/modules/files/service"
import { deleteMessage } from "~/modules/threads/message"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId: string
let aliceId: string
let threadId: string

const SCOPES = ["kernel:threads:read", "kernel:threads:write"]

async function insertMessage(): Promise<string> {
  const [m] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, content, required_scopes)
      VALUES (${orgId}::uuid, ${threadId}::uuid, ${aliceId}::uuid, 'user', 'with file', '{}'::text[])
      RETURNING id
    `),
  )
  return m!.id
}

async function insertAttachment(messageId: string, name: string): Promise<string> {
  const [f] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.files
        (org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by, disposition)
      VALUES (${orgId}::uuid, 'kernel', 'message', ${messageId}, ${name}, 'image/png', 12,
              ${`orgs/${orgId}/kernel/message/${messageId}/${name}`}, ${aliceId}::uuid, 'attachment')
      RETURNING id
    `),
  )
  return f!.id
}

async function softDelete(messageId: string): Promise<void> {
  await db.execute(
    drizzleSql`UPDATE kernel.messages SET deleted_at = now() WHERE id = ${messageId}::uuid`,
  )
}

async function fileRowCount(messageId: string): Promise<number> {
  const [r] = extractRows<{ n: number }>(
    await db.execute(
      drizzleSql`SELECT count(*)::int AS n FROM kernel.files WHERE entity_id = ${messageId}`,
    ),
  )
  return r!.n
}

function asAlice<T>(fn: Parameters<typeof withRlsContext<T>>[1]): Promise<T> {
  return withRlsContext(
    { actorType: "user", userId: aliceId, orgId, scopes: SCOPES, dimensionGrants: {} },
    fn,
  )
}

beforeAll(async () => {
  await acquireTestLock()
  await rebuildFilesSelectPolicy()
  const stamp = Date.now()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'MsgFilesOrg', ${`msg-files-${stamp}`}) RETURNING id
    `),
  )
  orgId = org!.id
  const [a] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`alice-mf-${stamp}@x.test`}, 'Alice', 'active', 'h', 1, 1)
      RETURNING id
    `),
  )
  aliceId = a!.id
  const [t] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`thr-mf-${stamp}`}, 'thread', ${aliceId}::uuid)
      RETURNING id
    `),
  )
  threadId = t!.id
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${threadId}::uuid, ${aliceId}::uuid, ${orgId}::uuid, 'owner')
  `)
})

afterAll(async () => {
  await releaseTestLock()
})

describe("a deleted message's attachment is unreadable even if its row survived", () => {
  it("the files SELECT policy hides it, the parent check refuses it, the relay recheck refuses it", async () => {
    const messageId = await insertMessage()
    const fileId = await insertAttachment(messageId, "live.png")
    const key = `orgs/${orgId}/kernel/message/${messageId}/live.png`

    // Alive: readable through RLS and by the relay recheck.
    const live = await asAlice((rls) =>
      getDownloadUrl(fileId, { rlsTx: rls, delivery: "direct", presignGet: async () => "u" }),
    )
    expect(live.id).toBe(fileId)
    expect(await isRelayedFileServable({ orgId, fileId, storageKey: key })).toBe(true)

    await softDelete(messageId)

    await expect(
      asAlice((rls) =>
        getDownloadUrl(fileId, { rlsTx: rls, delivery: "direct", presignGet: async () => "u" }),
      ),
    ).rejects.toBeInstanceOf(FileServiceError)
    expect(await isRelayedFileServable({ orgId, fileId, storageKey: key })).toBe(false)
    const parent = resolveParent(orgId, "kernel", "message")!
    await expect(
      asAlice((rls) => assertParentVisible(rls, parent, messageId)),
    ).rejects.toBeInstanceOf(FileServiceError)
  })
})

/** Every plan node that reads `relation`, flattened. */
function nodesOn(plan: unknown, relation: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = []
  const walk = (node: unknown): void => {
    if (!node || typeof node !== "object") return
    const n = node as Record<string, unknown>
    if (n["Relation Name"] === relation) out.push(n)
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) for (const c of v) walk(c)
      else if (v && typeof v === "object") walk(v)
    }
  }
  walk(plan)
  return out
}

/** Filler messages that give kernel.messages a production shape for the planner. */
const PLAN_FILLER = 2000

/**
 * Seeds this org's thread with filler messages and refreshes the table's
 * statistics, so the plan below is the one a real table gets: many messages
 * per org, the key unique. Without it the plan follows whatever statistics an
 * earlier run left: a table vacuumed while empty keeps a row estimate of zero
 * on its indexes, every index then looks like one row, and the org index ties
 * with the key. ANALYZE runs as a superuser: Postgres skips a non-owner's
 * ANALYZE with only a warning, so the estimate is checked after it.
 */
async function giveMessagesProductionStatistics(): Promise<void> {
  await db.execute(drizzleSql`
    INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, content, required_scopes)
    SELECT ${orgId}::uuid, ${threadId}::uuid, ${aliceId}::uuid, 'user', 'plan filler ' || g, '{}'::text[]
    FROM generate_series(1, ${PLAN_FILLER}) g
  `)
  const dsn =
    process.env.DATABASE_URL ?? "postgres://liaison_app:liaison_app@localhost:5432/liaison_test"
  const owner = postgres(dsn.replace("liaison_app:liaison_app", "liaison:liaison"), {
    max: 1,
    onnotice: () => {},
  })
  try {
    await owner`ANALYZE kernel.messages`
    const [stats] = await owner<{ heap: number; key: number; org: number }[]>`
      SELECT (SELECT reltuples FROM pg_class WHERE oid = 'kernel.messages'::regclass) AS heap,
             (SELECT reltuples FROM pg_class WHERE oid = 'kernel.messages_pkey'::regclass) AS key,
             (SELECT reltuples FROM pg_class WHERE oid = 'kernel.messages_org_idx'::regclass) AS org`
    expect(Number(stats!.heap)).toBeGreaterThanOrEqual(PLAN_FILLER)
    expect(Number(stats!.key)).toBeGreaterThanOrEqual(PLAN_FILLER)
    expect(Number(stats!.org)).toBeGreaterThanOrEqual(PLAN_FILLER)
  } finally {
    await owner.end()
  }
}

describe("the parent check on a message reaches it through the key index", () => {
  afterAll(async () => {
    await db.execute(drizzleSql`
      DELETE FROM kernel.messages WHERE org_id = ${orgId}::uuid AND content LIKE 'plan filler %'
    `)
  })

  it("assertParentVisible on kernel.messages plans an index lookup, never a scan of the table under its policy", async () => {
    await giveMessagesProductionStatistics()
    const messageId = await insertMessage()
    const parent = resolveParent(orgId, "kernel", "message")!
    const plan = await asAlice(async (rls) => {
      // Record the visibility query the check runs, and plan it in the same
      // RLS transaction: with sequential scans priced out, a predicate the key
      // index can answer plans an index scan; a predicate it cannot (the key
      // cast to text) still has to scan every message through the policy.
      let parentQuery: Parameters<typeof rls.execute>[0] | null = null
      const recording = {
        execute: ((q: Parameters<typeof rls.execute>[0]) => {
          // The visibility query is the check's last statement.
          parentQuery = q
          return rls.execute(q)
        }) as typeof rls.execute,
      } as typeof rls
      await assertParentVisible(recording, parent, messageId)
      expect(parentQuery).not.toBeNull()
      await rls.execute(drizzleSql`SET LOCAL enable_seqscan = off`)
      const [row] = extractRows<{ "QUERY PLAN": unknown }>(
        await rls.execute(drizzleSql`EXPLAIN (FORMAT JSON) ${parentQuery!}`),
      )
      return row!["QUERY PLAN"]
    })
    // The message is found by its key: the scan of kernel.messages carries the
    // id as its index condition. Any other shape (a sequential scan, or an
    // index walked in full with the id as a filter) runs the messages policy
    // on every row the caller can reach before the id is even compared.
    const scans = nodesOn(plan, "messages")
    expect(scans.length).toBeGreaterThan(0)
    for (const scan of scans) {
      expect(String(scan["Index Cond"] ?? "")).toMatch(/\(id = /)
    }
  })

  it("a malformed message id is refused as not found, not a database error", async () => {
    const parent = resolveParent(orgId, "kernel", "message")!
    const err = await asAlice((rls) => assertParentVisible(rls, parent, "not-a-uuid")).catch(
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(FileServiceError)
    expect((err as FileServiceError).code).toBe("PARENT_NOT_FOUND")
  })
})

/** Committed outbox events deleting files of this message (payload keys). */
async function fileDeleteEvents(messageId: string): Promise<Array<{ storageKey: string }>> {
  return extractRows<{ storageKey: string }>(
    await db.execute(drizzleSql`
      SELECT payload->'data'->>'storageKey' AS "storageKey" FROM kernel.pending_events
       WHERE org_id = ${orgId}::uuid
         AND payload->>'entity' = 'file' AND payload->>'action' = 'delete'
         AND payload->'data'->>'entityId' = ${messageId}
    `),
  )
}

async function messageDeletedAt(messageId: string): Promise<unknown> {
  const [r] = extractRows<{ deleted_at: unknown }>(
    await db.execute(
      drizzleSql`SELECT deleted_at FROM kernel.messages WHERE id = ${messageId}::uuid`,
    ),
  )
  return r?.deleted_at ?? null
}

describe("deleting a message deletes its attachments", () => {
  it("deleteMessage removes the rows and commits one file-delete event per row with its keys", async () => {
    const messageId = await insertMessage()
    await insertAttachment(messageId, "a.png")
    await insertAttachment(messageId, "b.png")
    const other = await insertMessage()
    await insertAttachment(other, "keep.png")

    const deleted = await asAlice((rls) =>
      deleteMessage(rls, { orgId, userId: aliceId, threadId, messageId }),
    )
    expect(deleted?.id).toBe(messageId)
    expect(await fileRowCount(messageId)).toBe(0)
    // Another message's file is untouched.
    expect(await fileRowCount(other)).toBe(1)
    // The object deletions ride on these committed events (consumer below).
    expect((await fileDeleteEvents(messageId)).map((e) => e.storageKey).sort()).toEqual([
      `orgs/${orgId}/kernel/message/${messageId}/a.png`,
      `orgs/${orgId}/kernel/message/${messageId}/b.png`,
    ])
  })

  it("a delete whose transaction fails after the attachment step leaves message, files and outbox untouched", async () => {
    const messageId = await insertMessage()
    await insertAttachment(messageId, "keep1.png")

    await expect(
      asAlice(async (rls) => {
        await deleteMessage(rls, { orgId, userId: aliceId, threadId, messageId })
        throw new Error("commit fails")
      }),
    ).rejects.toThrow("commit fails")

    expect(await messageDeletedAt(messageId)).toBeNull()
    expect(await fileRowCount(messageId)).toBe(1)
    // Nothing was queued, so no object deletion can ever run for it.
    expect(await fileDeleteEvents(messageId)).toHaveLength(0)
  })

  it("a confirm for a message deleted meanwhile is refused and its uploaded object discarded", async () => {
    const messageId = await insertMessage()
    await softDelete(messageId)
    const storageKey = `orgs/${orgId}/kernel/message/${messageId}/late.png`
    const token = await signFileToken({
      orgId,
      userId: aliceId,
      app: "kernel",
      entityType: "message",
      entityId: messageId,
      storageKey,
      filename: "late.png",
      mimeType: "image/png",
      sizeBytes: 12,
    })
    const discarded: string[] = []
    await expect(
      confirmUpload(token, {
        privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
        headObject: (async () => ({
          contentLength: 12,
          contentType: "image/png",
          contentEncoding: null,
        })) as any,
        deleteObject: (async (key: string) => {
          discarded.push(key)
        }) as any,
      }),
    ).rejects.toBeInstanceOf(FileServiceError)
    // The object goes now, not at the orphan sweep, and no row was written.
    expect(discarded).toEqual([storageKey])
    expect(await fileRowCount(messageId)).toBe(0)
  })

  it("an attach serialises with a delete in flight: it waits, then is refused", async () => {
    const messageId = await insertMessage()
    let releaseDelete: () => void = () => {}
    const held = new Promise<void>((r) => {
      releaseDelete = r
    })
    let deleteDone = false
    let deleteHolds: () => void = () => {}
    const holding = new Promise<void>((r) => {
      deleteHolds = r
    })
    // The delete updates the message row and holds it until released. The
    // attach starts only once the delete holds the row (a fixed sleep raced a
    // slow delete under a loaded run, and the attach then ran first).
    const deleting = asAlice(async (rls) => {
      await deleteMessage(rls, { orgId, userId: aliceId, threadId, messageId })
      deleteHolds()
      await held
    }).then(() => {
      deleteDone = true
    })
    await Promise.race([holding, deleting])

    let attachSettled = false
    const attaching = asAlice((rls) =>
      lockLiveParent(rls, orgId, { app: "kernel", entityType: "message", entityId: messageId }),
    ).finally(() => {
      attachSettled = true
    })
    // Blocked on the delete's row lock, not racing past it: wait until the
    // database shows a backend waiting on a lock (or the attach settles).
    for (let i = 0; i < 100 && !attachSettled; i++) {
      const [w] = extractRows<{ n: number }>(
        await db.execute(drizzleSql`
          SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l
           WHERE NOT l.granted
             AND l.pid IN (SELECT pid FROM pg_stat_activity WHERE datname = current_database())
        `),
      )
      if (w!.n > 0) break
      await new Promise((r) => setTimeout(r, 50))
    }
    expect(attachSettled).toBe(false)

    releaseDelete()
    await deleting
    expect(deleteDone).toBe(true)
    await expect(attaching).rejects.toBeInstanceOf(FileServiceError)
  })

  it("attaching onto a message created in the same, still open, transaction works (the lock sees it)", async () => {
    const source = await insertMessage()
    const sourceFile = await insertAttachment(source, "src.png")
    const copied = await asAlice(async (rls) => {
      const [m] = extractRows<{ id: string }>(
        await rls.execute(drizzleSql`
          INSERT INTO kernel.messages (org_id, thread_id, author_id, author_type, content, required_scopes)
          VALUES (${orgId}::uuid, ${threadId}::uuid, ${aliceId}::uuid, 'user', 'fresh', '{}'::text[])
          RETURNING id
        `),
      )
      return attachFilesToParent(
        {
          sourceFileIds: [sourceFile],
          target: { app: "kernel", entityType: "message", entityId: m!.id },
        },
        {
          rlsTx: rls,
          privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
          orgId,
          userId: aliceId,
          scopes: SCOPES,
          copyObject: async () => {},
        },
      )
    })
    expect(copied).toHaveLength(1)
  })

  it("the files-delete-object consumer enqueues exactly the committed event's keys, deduped by file id", async () => {
    const calls: unknown[][] = []
    const enqueue = (async (...args: unknown[]) => {
      calls.push(args)
      return "job"
    }) as never
    await enqueueObjectDeleteForEvent(
      {
        app: "kernel",
        entity: "file",
        action: "delete",
        orgId,
        data: { id: "f1", storageKey: "k1", thumbnailKey: "k1.thumb.webp" },
      },
      enqueue,
    )
    await enqueueObjectDeleteForEvent(
      {
        app: "kernel",
        entity: "file",
        action: "create",
        orgId,
        data: { id: "f2", storageKey: "k2" },
      },
      enqueue,
    )
    expect(calls).toEqual([
      [
        "kernel",
        "files-delete-object",
        { orgId, storageKey: "k1", thumbnailKey: "k1.thumb.webp" },
        { jobId: "files-delete-object:f1" },
      ],
    ])
  })
})

describe("purgeDeletedMessageAttachments (the cleanup for messages deleted before the fix)", () => {
  it("dry run counts, execute removes only deleted messages' files, a rerun is a no-op", async () => {
    // Clear what earlier tests may have left in this org.
    await purgeDeletedMessageAttachments({ orgId, dryRun: false })

    const gone1 = await insertMessage()
    const gone2 = await insertMessage()
    const alive = await insertMessage()
    await insertAttachment(gone1, "x.png")
    await insertAttachment(gone1, "y.png")
    await insertAttachment(gone2, "z.png")
    await insertAttachment(alive, "keep.png")
    await softDelete(gone1)
    await softDelete(gone2)

    const dry = await purgeDeletedMessageAttachments({ orgId, dryRun: true })
    expect(dry).toEqual({ orgId, files: 3, messages: 2 })
    expect(await fileRowCount(gone1)).toBe(2)

    const run = await purgeDeletedMessageAttachments(
      { orgId, dryRun: false },
      { privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn) },
    )
    expect(run).toEqual({ orgId, files: 3, messages: 2 })
    expect(await fileRowCount(gone1)).toBe(0)
    expect(await fileRowCount(gone2)).toBe(0)
    expect(await fileRowCount(alive)).toBe(1)
    expect((await fileDeleteEvents(gone1)).map((e) => e.storageKey).sort()).toEqual([
      `orgs/${orgId}/kernel/message/${gone1}/x.png`,
      `orgs/${orgId}/kernel/message/${gone1}/y.png`,
    ])

    const again = await purgeDeletedMessageAttachments({ orgId, dryRun: false })
    expect(again.files).toBe(0)
  })
})
