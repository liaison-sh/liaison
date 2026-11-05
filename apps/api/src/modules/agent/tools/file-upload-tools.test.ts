// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * files_upload_url / files_upload_confirm against a real Postgres and the real
 * object store: an MCP client stages a LOCAL file, PUTs the bytes through the
 * same relay route curl would hit, confirms, and attaches the resulting kernel
 * file id onto a thread exactly like any other file. Also pins who may confirm
 * and see the file, and the size and type refusals.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { sql as drizzleSql } from "drizzle-orm"
import { extractRows, type RlsClient } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import { withPrivilegedDb } from "~/db/privileged"
import { withRlsContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBytes } from "~/lib/storage/get-object-bytes"
import {
  handleFilesUploadConfirm,
  handleFilesUploadUrl,
  INLINE_UPLOAD_MAX_BYTES,
} from "~/modules/agent/tools/file-tools"
import { attachFilesToParent } from "~/modules/files/attach"
import { fileUploadRelay } from "~/modules/files/routes"
import { acquireTestLock, releaseTestLockKeepRows } from "~/tests/route-test-setup"

let orgId: string
let aliceId: string
let bobId: string
let threadId: string

const SCOPES = ["kernel:files:read", "kernel:threads:read", "kernel:threads:write"]

function asUser<T>(userId: string, fn: (db: RlsClient) => Promise<T>): Promise<T> {
  return withRlsContext(
    { actorType: "user", userId, orgId, scopes: SCOPES, dimensionGrants: {} },
    fn,
  )
}

function ctxFor(userId: string, rls: RlsClient) {
  return { orgId, userId, db: rls, scopes: SCOPES }
}

/** The relay token is the last path segment of a relay upload URL. */
function relayPath(uploadUrl: string): string {
  const u = new URL(uploadUrl)
  expect(u.pathname.startsWith("/api/file-relay/")).toBe(true)
  return u.pathname.slice("/api/file-relay".length)
}

async function fileRow(fileId: string) {
  const [row] = extractRows<{
    entity_type: string
    disposition: string
    uploaded_by: string
    storage_key: string
    size_bytes: number
  }>(
    await db.execute(drizzleSql`
      SELECT entity_type, disposition, uploaded_by::text AS uploaded_by, storage_key, size_bytes
      FROM kernel.files WHERE id = ${fileId}::uuid
    `),
  )
  return row
}

beforeAll(async () => {
  await acquireTestLock()
  const stamp = Date.now()
  const [org] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.organizations (id, name, slug)
      VALUES (gen_random_uuid(), 'AgentUploadOrg', ${`agent-upload-${stamp}`}) RETURNING id
    `),
  )
  orgId = org!.id
  const mkUser = async (name: string) => {
    const [u] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
        VALUES (gen_random_uuid(), ${orgId}::uuid, ${`${name}-${stamp}@x.test`}, ${name}, 'active', 'h', 1, 1)
        RETURNING id
      `),
    )
    return u!.id
  }
  aliceId = await mkUser("alice")
  bobId = await mkUser("bob")
  const [t] = extractRows<{ id: string }>(
    await db.execute(drizzleSql`
      INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (gen_random_uuid(), ${orgId}::uuid, ${`upl-${stamp}`}, 'thread', ${aliceId}::uuid)
      RETURNING id
    `),
  )
  threadId = t!.id
  await db.execute(drizzleSql`
    INSERT INTO kernel.thread_participants (thread_id, user_id, org_id, role)
    VALUES (${threadId}::uuid, ${aliceId}::uuid, ${orgId}::uuid, 'owner')
  `)
  // The kernel.files SELECT policy is rebuilt from the registered parents at
  // boot; rebuild it so the RLS reads below see what production sees.
  await rebuildFilesSelectPolicy()
})

afterAll(async () => {
  if (orgId) {
    await db.execute(drizzleSql`DELETE FROM kernel.files WHERE org_id = ${orgId}::uuid`)
    await db.execute(
      drizzleSql`DELETE FROM kernel.file_upload_sessions WHERE org_id = ${orgId}::uuid`,
    )
  }
  await releaseTestLockKeepRows()
})

describe("files_upload_url + PUT + files_upload_confirm", () => {
  it("stages a local file, stores the PUT bytes, and the file id attaches to a thread", async () => {
    const bytes = new TextEncoder().encode("a local screenshot, honestly")
    const staged = await asUser(aliceId, (rls) =>
      handleFilesUploadUrl(
        { filename: "shot.png", mimeType: "image/png", sizeBytes: bytes.byteLength },
        ctxFor(aliceId, rls),
      ),
    )
    if (!("fileToken" in staged))
      throw new Error(`expected a PUT URL, got ${JSON.stringify(staged)}`)
    expect(staged.method).toBe("PUT")
    expect(staged.headers).toEqual({ "Content-Type": "image/png" })
    expect(staged.nextStep).toContain("kernel__files_upload_confirm")

    const put = await fileUploadRelay.request(relayPath(staged.uploadUrl), {
      method: "PUT",
      headers: { "Content-Type": "image/png" },
      body: bytes,
    })
    expect(put.status).toBe(200)

    const confirmed = await asUser(aliceId, (rls) =>
      handleFilesUploadConfirm({ fileToken: staged.fileToken }, ctxFor(aliceId, rls)),
    )
    if (!("fileId" in confirmed)) throw new Error(`confirm failed: ${JSON.stringify(confirmed)}`)
    expect(confirmed.sizeBytes).toBe(bytes.byteLength)
    expect(confirmed.nextStep).toContain("attachments")

    const row = await fileRow(confirmed.fileId)
    expect(row?.entity_type).toBe("file_upload_session")
    expect(row?.disposition).toBe("attachment")
    expect(row?.uploaded_by).toBe(aliceId)
    const stored = await getObjectBytes(row!.storage_key, { maxBytes: 1024 })
    expect(new TextDecoder().decode(stored.bytes)).toBe("a local screenshot, honestly")

    // Retrying the confirm is idempotent: same id, no second row.
    const again = await asUser(aliceId, (rls) =>
      handleFilesUploadConfirm({ fileToken: staged.fileToken }, ctxFor(aliceId, rls)),
    )
    expect(again).toMatchObject({ fileId: confirmed.fileId })

    // The id is an ordinary kernel file id: a send surface copies it onto its parent.
    const attached = await asUser(aliceId, (rls) =>
      attachFilesToParent(
        {
          sourceFileIds: [confirmed.fileId],
          target: { app: "kernel", entityType: "thread", entityId: threadId },
        },
        {
          rlsTx: rls,
          privileged: (reason, fn) => withPrivilegedDb(orgId, reason, fn),
          orgId,
          userId: aliceId,
          scopes: SCOPES,
        },
      ),
    )
    expect(attached).toHaveLength(1)
    expect(attached[0]!.filename).toBe("shot.png")
  })

  it("only the uploader can confirm or see the staged file", async () => {
    const bytes = new TextEncoder().encode("alice only")
    const staged = await asUser(aliceId, (rls) =>
      handleFilesUploadUrl(
        { filename: "private.txt", mimeType: "text/plain", sizeBytes: bytes.byteLength },
        ctxFor(aliceId, rls),
      ),
    )
    if (!("fileToken" in staged)) throw new Error(JSON.stringify(staged))
    await fileUploadRelay.request(relayPath(staged.uploadUrl), {
      method: "PUT",
      headers: { "Content-Type": "text/plain" },
      body: bytes,
    })

    const bobConfirm = await asUser(bobId, (rls) =>
      handleFilesUploadConfirm({ fileToken: staged.fileToken }, ctxFor(bobId, rls)),
    )
    expect(bobConfirm).toEqual({
      error: { code: "FORBIDDEN", message: "This file token was issued to a different user." },
    })

    const confirmed = await asUser(aliceId, (rls) =>
      handleFilesUploadConfirm({ fileToken: staged.fileToken }, ctxFor(aliceId, rls)),
    )
    if (!("fileId" in confirmed)) throw new Error(JSON.stringify(confirmed))
    const bobSees = await asUser(bobId, async (rls) =>
      extractRows<{ id: string }>(
        await rls.execute(
          drizzleSql`SELECT id FROM kernel.files WHERE id = ${confirmed.fileId}::uuid`,
        ),
      ),
    )
    expect(bobSees).toHaveLength(0)
  })

  it("refuses a confirm when the PUT body does not match the declared size", async () => {
    const staged = await asUser(aliceId, (rls) =>
      handleFilesUploadUrl(
        { filename: "short.bin", mimeType: "application/octet-stream", sizeBytes: 100 },
        ctxFor(aliceId, rls),
      ),
    )
    if (!("fileToken" in staged)) throw new Error(JSON.stringify(staged))
    await fileUploadRelay.request(relayPath(staged.uploadUrl), {
      method: "PUT",
      headers: { "Content-Type": "application/octet-stream" },
      body: new Uint8Array(10),
    })
    const confirmed = await asUser(aliceId, (rls) =>
      handleFilesUploadConfirm({ fileToken: staged.fileToken }, ctxFor(aliceId, rls)),
    )
    expect(confirmed).toMatchObject({ error: { code: "FILE_VERIFY_FAILED" } })
  })
})

describe("files_upload_url with contentBase64", () => {
  it("stores and confirms a small file in one call; an SVG is kept as a download", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'
    const res = await asUser(aliceId, (rls) =>
      handleFilesUploadUrl(
        {
          filename: "logo.svg",
          mimeType: "image/svg+xml",
          contentBase64: Buffer.from(svg).toString("base64"),
        },
        ctxFor(aliceId, rls),
      ),
    )
    if (!("fileId" in res)) throw new Error(JSON.stringify(res))
    expect(res.sizeBytes).toBe(svg.length)
    const row = await fileRow(res.fileId)
    expect(row?.disposition).toBe("attachment")
    expect(row?.entity_type).toBe("file_upload_session")
    const stored = await getObjectBytes(row!.storage_key, { maxBytes: 1024 })
    expect(new TextDecoder().decode(stored.bytes)).toBe(svg)
  })

  it("refuses inline content over the cap and points at the PUT flow", async () => {
    const big = Buffer.alloc(INLINE_UPLOAD_MAX_BYTES + 1).toString("base64")
    const res = await asUser(aliceId, (rls) =>
      handleFilesUploadUrl(
        { filename: "big.bin", mimeType: "application/octet-stream", contentBase64: big },
        ctxFor(aliceId, rls),
      ),
    )
    expect(res).toMatchObject({ error: { code: "INLINE_TOO_LARGE" } })
  })
})

describe("files_upload_url refusals", () => {
  it("refuses an executable type before anything is stored", async () => {
    const res = await asUser(aliceId, (rls) =>
      handleFilesUploadUrl(
        { filename: "setup.exe", mimeType: "application/octet-stream", sizeBytes: 10 },
        ctxFor(aliceId, rls),
      ),
    )
    expect(res).toMatchObject({ error: { code: "UNSAFE_FILE_TYPE" } })
  })

  it("applies the org file size limit of a browser upload", async () => {
    const res = await asUser(aliceId, (rls) =>
      handleFilesUploadUrl(
        { filename: "huge.zip", mimeType: "application/zip", sizeBytes: 50 * 1024 * 1024 * 1024 },
        ctxFor(aliceId, rls),
      ),
    )
    expect(res).toMatchObject({ error: { code: "FILE_TOO_LARGE" } })
  })

  it("requires sizeBytes when no inline content is given", async () => {
    const res = await asUser(aliceId, (rls) =>
      handleFilesUploadUrl(
        { filename: "a.pdf", mimeType: "application/pdf" },
        ctxFor(aliceId, rls),
      ),
    )
    expect(res).toMatchObject({ error: { code: "SIZE_REQUIRED" } })
  })
})
