// SPDX-License-Identifier: FSL-1.1-ALv2
// Import upload routes over HTTP (/api/imports/uploads): the config answer,
// a strict body, create → send → complete into a file the uploader can import,
// resume state, the import cap refusal with its code, and another member never
// reaching someone else's upload. The service's own behaviours (parts, the
// reaper, the quota) are in uploads.test.ts.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { app } from "~/app"
import { sql } from "~/db"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import * as minimal from "~/seed/tiers/minimal"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

let orgId = ""
let aliceToken = ""
let bobToken = ""
let aliceId = ""

async function call(token: string, method: string, path: string, body?: unknown) {
  const res = await app.request(`/api/imports/uploads${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const json = (await res.json().catch(() => ({}))) as {
    data?: Record<string, unknown>
    error?: { code?: string; message?: string }
  }
  return { status: res.status, json }
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await ensureOrg({ slug: `imp-up-${crypto.randomUUID().slice(0, 8)}`, name: "Uploads" }))
    .orgId
  const mk = async (name: string) =>
    (
      await ensureUser({
        orgId,
        email: `${name}-${crypto.randomUUID().slice(0, 6)}@fabrikam.example`,
        name,
        password: "pw-upload-1!",
        role: "admin",
      })
    ).userId
  aliceId = await mk("alice")
  const bobId = await mk("bob")
  aliceToken = await minimal.token(aliceId)
  bobToken = await minimal.token(bobId)
}, 120_000)

afterAll(releaseTestLock)

describe("import upload routes", () => {
  it("GET /config names the delivery mode and the limits", async () => {
    const r = await call(aliceToken, "GET", "/config")
    expect(r.status).toBe(200)
    expect(["multipart", "relay"]).toContain(String(r.json.data?.mode))
    expect(r.json.data?.importFileSizeLimitMb).toBe(5120)
    expect(typeof r.json.data?.fileSizeLimitMb).toBe("number")
  })

  it("refuses a body that is not a file description", async () => {
    const r = await call(aliceToken, "POST", "", {
      filename: "x.csv",
      mimeType: "text/csv",
      size: -1,
    })
    expect(r.status).toBe(400)
  })

  it("refuses a file over the import cap with its code", async () => {
    const r = await call(aliceToken, "POST", "", {
      filename: "huge.zip",
      mimeType: "application/zip",
      size: 6 * 1024 * 1024 * 1024,
    })
    expect(r.status).toBeGreaterThanOrEqual(400)
    expect(r.json.error?.code).toBeTruthy()
    expect(r.json.error?.message).toContain("importFileSizeLimitMb")
  })

  it("create, send, complete: a file row the uploader owns; another member never sees the upload", async () => {
    const body = new TextEncoder().encode("id,name\n1,Ada\n")
    const created = await call(aliceToken, "POST", "", {
      filename: "people.csv",
      mimeType: "text/csv",
      size: body.byteLength,
    })
    expect(created.status).toBe(200)
    const up = created.json.data as {
      id: string
      mode: string
      parts?: Array<{ partNumber: number; url: string }>
      uploadUrl?: string
    }
    expect(up.id).toMatch(/^[0-9a-f-]{36}$/)

    // Another member: not found, every route.
    expect((await call(bobToken, "GET", `/${up.id}`)).status).toBe(404)
    expect((await call(bobToken, "POST", `/${up.id}/complete`)).status).toBe(404)
    expect((await call(bobToken, "POST", `/${up.id}/abort`)).status).toBe(404)

    if (up.mode === "multipart") {
      const state = await call(aliceToken, "GET", `/${up.id}`)
      expect(state.json.data?.missing).toEqual([1])
      const res = await fetch(up.parts![0]!.url, { method: "PUT", body })
      expect(res.status).toBe(200)
    } else {
      const res = await app.request(up.uploadUrl!, {
        method: "PUT",
        headers: { Authorization: `Bearer ${aliceToken}`, "Content-Type": "text/csv" },
        body,
      })
      expect(res.status).toBeLessThan(300)
    }
    const done = await call(aliceToken, "POST", `/${up.id}/complete`)
    expect(done.status).toBe(200)
    const fileId = done.json.data?.fileId as string
    expect(fileId).toMatch(/^[0-9a-f-]{36}$/)
    const [row] = await sql`SELECT uploaded_by, size_bytes FROM kernel.files WHERE id = ${fileId}`
    expect(row?.uploaded_by).toBe(aliceId)
    expect(Number(row?.size_bytes)).toBe(body.byteLength)
  }, 60_000)

  it("abort closes an open upload", async () => {
    const created = await call(aliceToken, "POST", "", {
      filename: "x.csv",
      mimeType: "text/csv",
      size: 10,
    })
    const id = (created.json.data as { id: string }).id
    const aborted = await call(aliceToken, "POST", `/${id}/abort`)
    expect(aborted.status).toBe(200)
    expect(aborted.json.data?.status).toBe("aborted")
    expect((await call(aliceToken, "POST", `/${id}/complete`)).status).toBeGreaterThanOrEqual(400)
  })
})
