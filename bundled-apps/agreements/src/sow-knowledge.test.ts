// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { sealRetry, sealVersion } from "./seal"
import { signedWorld } from "./seal.testutil"
import { onAgreementSigned } from "./sow-knowledge"

const LEAD = "11111111-0000-4000-8000-000000000001"
const READER = "22222222-0000-4000-8000-000000000002"
const OWNER = "33333333-0000-4000-8000-000000000003"
const ROLE = "44444444-0000-4000-8000-000000000004"

type Call = { name: string; params: Record<string, unknown> }

async function world(opts: { restricted?: boolean; knowledgeDown?: boolean } = {}) {
  const w = await signedWorld()
  const calls: Call[] = []
  let n = 0
  const down = { on: opts.knowledgeDown ?? false }
  w.ctx.executeTool = async (name, params) => {
    calls.push({ name, params })
    if (down.on) return { status: "error", error: { code: "UNAVAILABLE", message: "down" } }
    n += 1
    return { status: "completed", result: { id: `doc-${n}` } }
  }
  await w.db.update("agreements", w.agreementId, {
    org_access: opts.restricted ? "none" : "viewer",
    created_by_user_id: OWNER,
  })
  await w.db.update("agreement_versions", w.versionId, {
    source_text: "1. Scope\nA website.\n8. Price\n8.2 Rate: 700 EUR per day.",
  })
  for (const user_id of [LEAD, READER])
    await w.db.insert("agreement_shares", { agreement_id: w.agreementId, user_id, role: "viewer" })
  await w.db.insert("agreements_settings", { sow_reader_role_id: ROLE })
  return { ...w, calls, down }
}

describe("signed text as Knowledge", () => {
  it("sealing a signed version writes one closed Knowledge copy whose first line names agreement, version and fingerprint", async () => {
    const w = await world()
    await sealVersion(w.ctx, w.versionId)
    const creates = w.calls.filter((c) => c.name === "knowledge:create")
    expect(creates.length).toBe(1)
    const p = creates[0]?.params as Record<string, unknown>
    expect(p.orgAccess).toBe("none")
    expect(String(p.body).split("\n")[0]).toBe(
      `Agreement AG-2026-001, version 1, document fingerprint sha256 ${"e".repeat(64)}.`,
    )
    expect(String(p.body)).toContain("8.2 Rate: 700 EUR per day.")
    expect(p.idempotencyKey).toBe(`agreements:sow:${w.versionId}`)
    const v = (await w.db.findOne("agreement_versions", w.versionId)) as Record<string, unknown>
    expect(v.knowledge_document_id).toBe("doc-1")
    // A second pass (a retry, a replayed decision) writes nothing more.
    await sealVersion(w.ctx, w.versionId)
    await onAgreementSigned(w.ctx, { versionId: w.versionId })
    expect(w.calls.filter((c) => c.name === "knowledge:create").length).toBe(1)
  })

  it("an open agreement's copy is shared with its list, its creator and the reader role", async () => {
    const w = await world()
    await sealVersion(w.ctx, w.versionId)
    const p = w.calls[0]?.params as Record<string, unknown>
    expect(p.shareWithUsers).toEqual(
      [LEAD, READER, OWNER].sort().map((userId) => ({ userId, role: "viewer" })),
    )
    expect(p.shareWithRoles).toEqual([{ roleId: ROLE, access: "viewer" }])
    expect(p.ownerUserId).toBe(OWNER)
  })

  it("a restricted agreement's copy is shared with exactly its list, without its creator or the reader role", async () => {
    const w = await world({ restricted: true })
    await sealVersion(w.ctx, w.versionId)
    const p = w.calls[0]?.params as Record<string, unknown>
    expect(p.shareWithUsers).toEqual(
      [LEAD, READER].sort().map((userId) => ({ userId, role: "viewer" })),
    )
    expect(p.shareWithRoles).toBeUndefined()
    // Written in the name of someone on the list, never the creator who is off it.
    expect(p.ownerUserId).toBe([LEAD, READER].sort()[0])
  })

  it("a copy Knowledge could not take is written by the seal retry, once", async () => {
    const w = await world({ knowledgeDown: true })
    await sealVersion(w.ctx, w.versionId)
    const v = (await w.db.findOne("agreement_versions", w.versionId)) as Record<string, unknown>
    expect(v.knowledge_document_id ?? null).toBeNull()
    w.down.on = false
    await sealRetry(w.ctx)
    await sealRetry(w.ctx)
    const after = (await w.db.findOne("agreement_versions", w.versionId)) as Record<string, unknown>
    expect(after.knowledge_document_id).toBe("doc-1")
    expect(w.calls.filter((c) => c.name === "knowledge:create").length).toBe(2)
  })

  it("a superseding signed version archives the copy of the version before it", async () => {
    const w = await world()
    await sealVersion(w.ctx, w.versionId)
    const { id: v2 } = await w.db.insert("agreement_versions", {
      agreement_id: w.agreementId,
      number: 2,
      status: "signed",
      sha256: "d".repeat(64),
      source_text: "1. Scope\nA website and a shop.",
    })
    const out = await onAgreementSigned(w.ctx, { versionId: v2 })
    expect(out).toEqual({ status: "created", document_id: "doc-2", archived: ["doc-1"] })
    expect(w.calls.at(-1)).toEqual({ name: "knowledge:archive", params: { id: "doc-1" } })
  })
})
