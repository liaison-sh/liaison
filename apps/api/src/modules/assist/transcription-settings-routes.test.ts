// SPDX-License-Identifier: FSL-1.1-ALv2
//
// GET/PATCH /api/settings/ai/transcription (S7): admin only, lists what the org
// can transcribe with, refuses a model it cannot run (422 model_unavailable).
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { app } from "~/app"
import { sql } from "~/db"
import { env } from "~/lib/env"
import { signAccessToken } from "~/modules/auth/jwt"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const ORG_ID = "00000000-0000-4000-8000-0000000f4001"
const ADMIN_ID = "00000000-0000-4000-8000-0000000f4002"
const MEMBER_ID = "00000000-0000-4000-8000-0000000f4003"
const QWEN = "openrouter/qwen/qwen3-asr-1.7b"

let adminToken: string
let memberToken: string
const saved: Record<string, string | undefined> = {}

async function call(method: string, body?: unknown, token = adminToken) {
  const res = await app.request("/api/settings/ai/transcription", {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  return { status: res.status, json: (await res.json()) as any }
}

describe("transcription settings API", () => {
  beforeAll(async () => {
    await acquireTestLock()
    for (const k of ["OPENROUTER_API_KEY", "GOOGLE_API_KEY"]) saved[k] = process.env[k]
    process.env.OPENROUTER_API_KEY = "or-test-placeholder"
    await sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (${ORG_ID}, 'TranscriptionOrg', 'transcription-org') ON CONFLICT (id) DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${ADMIN_ID}, ${ORG_ID}, 'tr-admin@test.com', 'Admin') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name) VALUES (${MEMBER_ID}, ${ORG_ID}, 'tr-member@test.com', 'Member') ON CONFLICT DO NOTHING`
    const token = (userId: string, scopes: string[]) =>
      signAccessToken(
        {
          userId,
          orgId: ORG_ID,
          name: "Transcription",
          authVersion: 1,
          permissionVersion: 1,
          scopes,
          dimensionGrants: {},
        },
        env.JWT_SECRET,
      )
    adminToken = await token(ADMIN_ID, ["*"])
    memberToken = await token(MEMBER_ID, ["kernel:threads:read"])
  })

  afterAll(async () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    await releaseTestLock()
  })

  it("is admin only (403 for a member, on GET and PATCH)", async () => {
    expect((await call("GET", undefined, memberToken)).status).toBe(403)
    expect((await call("PATCH", { modelKey: QWEN }, memberToken)).status).toBe(403)
  })

  it("lists the OpenRouter candidates with the default preselected", async () => {
    const { status, json } = await call("GET")
    expect(status).toBe(200)
    expect(json.data.current).toBeNull()
    expect(json.data.default).toBe(QWEN)
    expect(json.data.available.map((m: { key: string }) => m.key)).toContain(QWEN)
  })

  it("sets and clears the org's choice", async () => {
    const set = await call("PATCH", { modelKey: QWEN })
    expect(set.status).toBe(200)
    expect(set.json.data.current).toBe(QWEN)
    const [row] =
      await sql`SELECT settings->'ai'->'transcription'->>'modelKey' AS k FROM kernel.organizations WHERE id = ${ORG_ID}`
    expect(row.k).toBe(QWEN)
    const cleared = await call("PATCH", { modelKey: null })
    expect(cleared.json.data.current).toBeNull()
  })

  it("refuses a model the org cannot run (422 model_unavailable)", async () => {
    // Gemini is offered only when OpenRouter is not usable.
    const res = await call("PATCH", { modelKey: "gemini-flash-lite-latest" })
    expect(res.status).toBe(422)
    expect(res.json.error.code).toBe("model_unavailable")
    const unknown = await call("PATCH", { modelKey: "openrouter/acme/not-a-model" })
    expect(unknown.status).toBe(422)
  })
})
