// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who can open a data-subject export once it is written. The request goes the
// real way: an agent turn parks the gated tool, a person approves it, the tool
// runs as the requester, and the requester downloads the bundle through the
// normal files routes with their own token. Exactly the requester reads it:
// another member, an org admin without the export authority, and the person a
// member export is about (when someone else asked) all get the same 404 as a
// file that does not exist.

import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { and, desc, eq, gt, like } from "drizzle-orm"
import { withSystemDb } from "~/db/privileged"
import type { UserContext } from "~/db/rls"
import { files } from "~/db/schema/kernel"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { decideApproval } from "~/modules/approvals/decide"
import { executeTool } from "~/modules/apps/execute-tool"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { seedContext } from "~/seed/context"
import { actorFor } from "~/seed/factories/people/actors"
import * as minimal from "~/seed/tiers/minimal"
import { buildTestApp } from "~/tests/helpers/build-app"
import { createTestOrg } from "~/tests/helpers/org"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const TOOL = "kernel:data_subject_export"
const tag = crypto.randomUUID().slice(0, 8)

let orgId: string
let alice: UserContext
let bob: UserContext
let officer: UserContext
let admin: UserContext
let app: Awaited<ReturnType<typeof buildTestApp>>
const tokens = new Map<string, string>()

/** The requester's agent asks for the export; the parked request is approved; the file it wrote. */
async function exportThroughApproval(
  requester: UserContext,
  params: Record<string, unknown>,
): Promise<string> {
  const startedAt = new Date(Date.now() - 1000)
  const threadId = await minimal.thread(orgId, requester.userId, { title: `export ${tag}` })
  const parked = await executeTool({
    toolName: TOOL,
    orgId,
    actor: requester,
    params,
    threadId,
    origin: "in-app-agent",
  })
  const requestId = parked.blocked?.approvalRequestId
  if (typeof requestId !== "string") {
    throw new Error(`the export did not park for approval: ${JSON.stringify(parked)}`)
  }
  const decided = await decideApproval({ orgId, requestId, actor: admin, decision: "approve" })
  expect(decided.status).toBe("approved")
  const [row] = await withSystemDb("test-export-file", (db) =>
    db
      .select({ id: files.id })
      .from(files)
      .where(
        and(
          eq(files.orgId, orgId),
          like(files.filename, "gdpr-export-%"),
          gt(files.createdAt, startedAt),
        ),
      )
      .orderBy(desc(files.createdAt))
      .limit(1),
  )
  if (!row) throw new Error("the approved export wrote no file")
  return row.id
}

async function get(as: UserContext, path: string): Promise<{ status: number; body: unknown }> {
  const token = tokens.get(as.userId)
  if (!token) throw new Error(`no token for ${as.userId}`)
  const res = await app.request(path, { headers: { authorization: `Bearer ${token}` } })
  return { status: res.status, body: await res.json().catch(() => null) }
}

/** Download and metadata answers for `fileId`, as `as` sees them. */
async function access(as: UserContext, fileId: string) {
  return {
    download: await get(as, `/api/files/${fileId}/download-url`),
    metadata: await get(as, `/api/files/${fileId}/metadata`),
  }
}

/** What a file id that does not exist answers: the shape every refusal must match. */
async function missing(as: UserContext) {
  return access(as, crypto.randomUUID())
}

beforeAll(async () => {
  await acquireTestLock()
  orgId = (await createTestOrg()).id
  await ensureAppsForOrg(orgId)
  // The files SELECT policy as a booting process builds it from this release's catalog.
  await rebuildFilesSelectPolicy()
  const ctx = seedContext({ orgId, now: new Date() })
  const a = await minimal.person(orgId, { name: `Alice ${tag}` })
  const b = await minimal.person(orgId, { name: `Bob ${tag}` })
  const o = await minimal.person(orgId, { name: `Officer ${tag}` })
  await minimal.grantScope(o.id, "kernel:data_subject:export")
  const ad = await minimal.orgAdmin(orgId)
  alice = await actorFor(ctx, a.id)
  bob = await actorFor(ctx, b.id)
  officer = await actorFor(ctx, o.id)
  admin = await actorFor(ctx, ad.id)
  for (const p of [alice, bob, officer, admin]) tokens.set(p.userId, await minimal.token(p.userId))
  app = await buildTestApp()
}, 120_000)

afterAll(releaseTestLock)

describe("data subject export bundle access", () => {
  it("a member's own export, once approved, is readable by that member through the files routes", async () => {
    const fileId = await exportThroughApproval(alice, { userId: "me" })
    const mine = await access(alice, fileId)
    expect(mine.download.status).toBe(200)
    expect(mine.metadata.status).toBe(200)
    expect(mine.metadata.body).toMatchObject({ data: { id: fileId } })
  })

  it("another member and an admin without the export authority get the same 404 as a missing file", async () => {
    const fileId = await exportThroughApproval(alice, { userId: "me" })
    expect(admin.scopes).not.toContain("kernel:data_subject:export")
    for (const other of [bob, admin]) {
      const seen = await access(other, fileId)
      expect(seen.download.status).toBe(404)
      expect(seen.metadata.status).toBe(404)
      expect(seen).toEqual(await missing(other))
    }
  })

  it("a contact export is readable by its requester only", async () => {
    const contactId = await minimal.contact(orgId, `subject-${tag}@customer.example`)
    const fileId = await exportThroughApproval(officer, { contactId })
    expect((await access(officer, fileId)).download.status).toBe(200)
    for (const other of [alice, bob, admin]) {
      expect(await access(other, fileId)).toEqual(await missing(other))
    }
  })

  it("a member export someone else requested is not readable by the member it is about", async () => {
    const fileId = await exportThroughApproval(officer, { userId: bob.userId })
    expect((await access(officer, fileId)).download.status).toBe(200)
    expect(await access(bob, fileId)).toEqual(await missing(bob))
  })
})
