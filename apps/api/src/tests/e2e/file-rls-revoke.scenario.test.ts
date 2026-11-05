// SPDX-License-Identifier: FSL-1.1-ALv2
// [Phase 10 BE-3] File RLS revocation
// ---------------------------------------------------------------------------
// Spec refs: S6, S7, §3.2.3, V8.
//
// Verifies that:
//   - Upload → confirm → download via /api/files/* works end-to-end through
//     the real object store with real bytes (no mocks).
//   - The thumbnail BullMQ job populates `thumbnail_key` within the budget,
//     and the WebP is served through the relay (`/inline?variant=thumb`);
//     relayed delivery hands out no presigned `thumbnailUrl`.
//   - File visibility tracks parent visibility — when userB loses access to
//     the parent ticket (via dimension revoke), GET download-url returns 404.
//   - Restoring access makes the file visible again on the next request
//     (visibility is computed per-request, no cache to invalidate).
//   - Storage quota and file-size limits are enforced at presign/confirm.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomBytes } from "node:crypto"
import type { TestWorld, WorkerEnv } from "@liaison/test-helpers"
import { api, createUserWithScopes, login } from "@liaison/test-helpers"
import { ks, seedTicket } from "./helpers/tickets-seed"
import { setupScenario, teardownScenario } from "./setup"

const FIVE_MB = 5 * 1024 * 1024

async function uploadFileViaApi(
  env: WorkerEnv,
  token: string,
  params: {
    app: string
    entityType: string
    entityId: string
    filename: string
    mimeType: string
    bytes: Buffer
  },
): Promise<{ id: string; storageKey: string }> {
  const presign = await api(env.serverUrl, "/api/files/upload-url", {
    token,
    body: {
      app: params.app,
      entityType: params.entityType,
      entityId: params.entityId,
      filename: params.filename,
      mimeType: params.mimeType,
      sizeBytes: params.bytes.byteLength,
    },
  })
  if (presign.status !== 200) {
    throw new Error(`upload-url failed: ${presign.status} ${JSON.stringify(presign.body)}`)
  }
  const { uploadUrl, fileToken, storageKey } = presign.body.data as {
    uploadUrl: string
    fileToken: string
    storageKey: string
  }

  // Real PUT to the object store. Do not set Content-Length explicitly — Bun's fetch
  // handles it (Amendment 1: the web client also omits Content-Length).
  // Content-Type IS sent so the stored object's content-type matches what
  // `/api/files/confirm` declared (HeadObject content-type check).
  const put = await fetch(uploadUrl, {
    method: "PUT",
    headers: { "Content-Type": params.mimeType },
    body: params.bytes,
  })
  if (!put.ok) {
    throw new Error(`Object store PUT failed: ${put.status} ${await put.text()}`)
  }

  const confirm = await api(env.serverUrl, "/api/files/confirm", {
    token,
    body: { fileToken },
  })
  if (confirm.status !== 200) {
    throw new Error(`confirm failed: ${confirm.status} ${JSON.stringify(confirm.body)}`)
  }
  return { id: (confirm.body.data as { id: string }).id, storageKey }
}

// Generate a real (small but valid) PNG of the requested byte length by
// padding random bytes after a 1×1 transparent PNG header. The thumbnail
// job uses sharp which does require a valid PNG header for decoding.
function makePngBytes(totalBytes: number): Buffer {
  // 1×1 transparent PNG (67 bytes).
  const tiny = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYGD4DwABBAEAfbLI3wAAAABJRU5ErkJggg==",
    "base64",
  )
  if (totalBytes <= tiny.byteLength) return tiny
  const pad = randomBytes(totalBytes - tiny.byteLength)
  return Buffer.concat([tiny, pad])
}

async function pollUntil(
  fn: () => Promise<boolean>,
  budgetMs: number,
  tickMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + budgetMs
  let last: unknown
  while (Date.now() < deadline) {
    try {
      if (await fn()) return
    } catch (err) {
      last = err
    }
    await Bun.sleep(tickMs)
  }
  throw new Error(`pollUntil(${label}) timed out after ${budgetMs}ms; last error: ${String(last)}`)
}

describe("File RLS revocation + quota + size limits", () => {
  let env: WorkerEnv
  let world: TestWorld
  let admin: { token: string; password: string; email: string }
  let userB: { id: string; email: string; password: string; token: string; roleId: string }
  let ticket: { id: string; handle: string }
  let fileId: string
  const password = "ABCdef12!"

  beforeAll(async () => {
    const result = await setupScenario({ seed: 703, org: { name: "File RLS Org" } })
    env = result.env
    world = result.world

    // Admin needs the full tickets read/write scope set. The bootstrap admin
    // role has wildcard scopes (kernel admin), so the admin token already
    // has tickets:tickets:read/write — we just record the credentials here.
    admin = {
      token: world.admin.token,
      email: world.admin.email,
      password: "SecurePass1!",
    }

    const bCreated = await createUserWithScopes(
      env.serverUrl,
      env.db.sql,
      world.admin.token,
      world.org.id,
      {
        name: "Bob Beta",
        scopes: ["tickets:tickets:read", "tickets:tickets:write"],
        // Canonical dimension key for the tickets app: the RLS function
        // `app_tickets.can_read_ticket` reads `tickets:team` from
        // current_dimensions, while search-side filtering reads `team`
        // (the indexed column name). Both must be set when a user needs
        // both RLS visibility and search visibility.
        dimensions: { "tickets:team": ["support-us"], "tickets:sensitivity": ["*"] },
        schemaPrefix: env.schemaPrefix,
        password,
      },
    )
    const roleRows = await env.db.sql.unsafe(
      `SELECT r.id FROM ${ks(env)}.roles r
        JOIN ${ks(env)}.user_roles ur ON ur.role_id = r.id
       WHERE ur.user_id = $1`,
      [bCreated.id],
    )
    userB = {
      id: bCreated.id,
      email: bCreated.email,
      password,
      token: bCreated.token,
      roleId: roleRows[0]!.id as string,
    }

    const seeded = await seedTicket(env, {
      orgId: world.org.id,
      subject: "File RLS test ticket — usb hardware report",
      team: "support-us",
    })
    ticket = { id: seeded.id, handle: seeded.handle }
  }, 180_000)

  afterAll(async () => {
    await teardownScenario(env, world)
  }, 30_000)

  it("admin uploads a 5 MB PNG to the ticket — both admin and userB can download", async () => {
    const png = makePngBytes(FIVE_MB)
    const uploaded = await uploadFileViaApi(env, admin.token, {
      app: "tickets",
      entityType: "ticket",
      entityId: ticket.id,
      filename: "report.png",
      mimeType: "image/png",
      bytes: png,
    })
    fileId = uploaded.id

    const adminDl = await api(env.serverUrl, `/api/files/${fileId}/download-url`, {
      token: admin.token,
    })
    expect(adminDl.status).toBe(200)
    expect(adminDl.body.data.downloadUrl).toBeTruthy()

    const bobDl = await api(env.serverUrl, `/api/files/${fileId}/download-url`, {
      token: userB.token,
    })
    expect(bobDl.status).toBe(200)
    expect(bobDl.body.data.downloadUrl).toBeTruthy()

    // Fetch the actual bytes from the object store via the presigned URL — proves the
    // confirm path stored the object and the URL signs correctly.
    const storeRes = await fetch(adminDl.body.data.downloadUrl)
    expect(storeRes.status).toBe(200)
    const fetched = await storeRes.arrayBuffer()
    expect(fetched.byteLength).toBe(FIVE_MB)
  }, 60_000)

  it("thumbnail job populates thumbnail_key within 15 s", async () => {
    await pollUntil(
      async () => {
        const rows = await env.db.sql.unsafe(
          `SELECT thumbnail_key FROM ${ks(env)}.files WHERE id = $1`,
          [fileId],
        )
        return rows[0]?.thumbnail_key != null
      },
      15_000,
      300,
      "thumbnail_key non-null",
    )

    // The e2e server relays object-store reads (OBJECT_STORAGE_BROWSER_DIRECT is
    // off by default): download-url hands out a relay capability URL and no
    // presigned thumbnail URL, and the thumbnail is served by the authenticated
    // inline route's `variant=thumb` (modules/files/routes.ts).
    const dl = await api(env.serverUrl, `/api/files/${fileId}/download-url`, {
      token: admin.token,
    })
    expect(dl.status).toBe(200)
    expect(dl.body.data.delivery).toBe("relay")

    // Fetch the actual thumbnail bytes and assert it's a WebP (RIFF header
    // "RIFF....WEBP"). Size sanity: < 200 KB for a 1×1 source.
    const thumbRes = await fetch(`${env.serverUrl}/api/files/${fileId}/inline?variant=thumb`, {
      headers: { Authorization: `Bearer ${admin.token}` },
    })
    expect(thumbRes.status).toBe(200)
    expect(thumbRes.headers.get("content-type") ?? "").toContain("image/webp")
    const buf = Buffer.from(await thumbRes.arrayBuffer())
    expect(buf.byteLength).toBeLessThan(200_000)
    expect(buf.subarray(0, 4).toString("ascii")).toBe("RIFF")
    expect(buf.subarray(8, 12).toString("ascii")).toBe("WEBP")
  }, 30_000)

  it("revoking userB's team dimension → file download 404; restoring → 200 again", async () => {
    // Drop userB's team grant and re-login so the JWT picks up the change.
    await env.db.sql.unsafe(
      `DELETE FROM ${ks(env)}.role_dimension_grants
        WHERE role_id = $1 AND dimension_key = 'tickets:team'`,
      [userB.roleId],
    )
    let renewed = await login(env.serverUrl, userB.email, userB.password)
    userB.token = renewed.accessToken

    const denied = await api(env.serverUrl, `/api/files/${fileId}/download-url`, {
      token: userB.token,
    })
    expect(denied.status).toBe(404)
    expect(denied.body.error?.code).toBe("PARENT_NOT_FOUND")

    // Restore the grant and re-login. Visibility should flip back without
    // any server-side invalidation (RLS resolves grants per request).
    await env.db.sql.unsafe(
      `INSERT INTO ${ks(env)}.role_dimension_grants (role_id, dimension_key, dimension_values)
       VALUES ($1, $2, $3::text::jsonb)`,
      [userB.roleId, "tickets:team", JSON.stringify(["support-us"])],
    )
    renewed = await login(env.serverUrl, userB.email, userB.password)
    userB.token = renewed.accessToken

    const restored = await api(env.serverUrl, `/api/files/${fileId}/download-url`, {
      token: userB.token,
    })
    expect(restored.status).toBe(200)
    expect(restored.body.data.downloadUrl).toBeTruthy()
  }, 30_000)

  it("storage-quota path returns 409 STORAGE_QUOTA_EXCEEDED when org quota is exceeded", async () => {
    // Set the storage cap (caps.storageGb, whole GB) to 1 GB and a file size limit
    // above it: the already-uploaded 5 MB file plus a 1 GB upload exceed the cap,
    // so the presign is refused on the quota, not the size.
    await env.db.sql.unsafe(
      `UPDATE ${ks(env)}.organizations
          SET caps = jsonb_set(caps, '{storageGb}', to_jsonb(1), true),
              settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{fileSizeLimitMb}', to_jsonb(2048), true)
        WHERE id = $1`,
      [world.org.id],
    )

    const denied = await api(env.serverUrl, "/api/files/upload-url", {
      token: admin.token,
      body: {
        app: "tickets",
        entityType: "ticket",
        entityId: ticket.id,
        filename: "second.png",
        mimeType: "image/png",
        sizeBytes: 1024 * 1024 * 1024,
      },
    })
    expect(denied.status).toBe(409)
    expect(denied.body.error?.code).toBe("STORAGE_QUOTA_EXCEEDED")

    // Restore quota for the size-limit case.
    await env.db.sql.unsafe(
      `UPDATE ${ks(env)}.organizations
          SET caps = caps - 'storageGb'
        WHERE id = $1`,
      [world.org.id],
    )
  }, 30_000)

  it("file-size limit returns 413 FILE_TOO_LARGE when above org fileSizeLimitMb", async () => {
    await env.db.sql.unsafe(
      `UPDATE ${ks(env)}.organizations
          SET settings = jsonb_set(COALESCE(settings, '{}'::jsonb), '{fileSizeLimitMb}', to_jsonb(1), true)
        WHERE id = $1`,
      [world.org.id],
    )

    const denied = await api(env.serverUrl, "/api/files/upload-url", {
      token: admin.token,
      body: {
        app: "tickets",
        entityType: "ticket",
        entityId: ticket.id,
        filename: "too-big.png",
        mimeType: "image/png",
        sizeBytes: 2 * 1024 * 1024,
      },
    })
    expect(denied.status).toBe(413)
    expect(denied.body.error?.code).toBe("FILE_TOO_LARGE")
  }, 30_000)
})
