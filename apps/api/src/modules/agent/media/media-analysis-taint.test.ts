// SPDX-License-Identifier: FSL-1.1-ALv2
//
// analyze_media taints the turn only when the analysed file came from outside the org (an inbound
// attachment, an integration import, a copy of either), never for a file a member uploaded.
// Driven through executeTool on cached analyses, so no model is called.
import { afterAll, beforeAll, describe, expect, it, spyOn } from "bun:test"
import { sql } from "~/db"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import * as eventBusModule from "~/infra/events/event-bus"
import { hashContext } from "~/modules/agent/media/media-analysis-shared"
import { analyzedFileIsExternal } from "~/modules/agent/media/media-analysis-tool"
import { toolRegistry } from "~/modules/apps/app-registries"
import { executeTool } from "~/modules/apps/execute-tool"

const broadcastSpy = spyOn(eventBusModule, "broadcastEphemeral").mockImplementation(async () => {})

const ORG_ID = "00000000-0000-4000-8000-0000007ed001"
const USER_ID = "00000000-0000-4000-8000-0000007ed002"
const THREAD = "00000000-0000-4000-8000-0000007ed003"
const MEMBER_SESSION = "00000000-0000-4000-8000-0000007ed010"
const DRIVE_SESSION = "00000000-0000-4000-8000-0000007ed011"
const MEMBER_FILE = "00000000-0000-4000-8000-0000007ed020"
const DRIVE_FILE = "00000000-0000-4000-8000-0000007ed021"
const NO_UPLOADER_FILE = "00000000-0000-4000-8000-0000007ed022"
const COPY_OF_DRIVE = "00000000-0000-4000-8000-0000007ed023"
const COPY_OF_MEMBER = "00000000-0000-4000-8000-0000007ed024"
const BROKEN_COPY = "00000000-0000-4000-8000-0000007ed025"
const GONE = "00000000-0000-4000-8000-0000007ed0ff"

const actor = {
  actorType: "user" as const,
  userId: USER_ID,
  orgId: ORG_ID,
  scopes: ["*"],
  dimensionGrants: {},
}

async function file(
  id: string,
  session: string,
  uploadedBy: string | null,
  copiedFrom: string | null = null,
) {
  await sql`INSERT INTO kernel.files (id, org_id, app, entity_type, entity_id, filename, mime_type,
      size_bytes, storage_key, uploaded_by, copied_from_id, analysis_status, analysis_summary,
      analysis_model, analysis_at, analysis_context_hash)
    VALUES (${id}, ${ORG_ID}, 'kernel', 'file_upload_session', ${session}, 'scan.png', 'image/png',
      10, ${`test/${id}`}, ${uploadedBy}, ${copiedFrom}, 'done', 'A photo of a broken pad.',
      'm', now(), ${hashContext(undefined)})
    ON CONFLICT DO NOTHING`
}

async function analyzeAndReadMark(fileId: string): Promise<boolean> {
  await sql`UPDATE kernel.threads SET tainted = false WHERE id = ${THREAD}`
  const out = await executeTool<{ summary?: string; cached?: boolean }>({
    toolName: "kernel:analyze_media",
    orgId: ORG_ID,
    actor,
    params: { fileId },
    threadId: THREAD,
    origin: "in-app-agent",
    stepBundleId: null,
  })
  expect(out.data?.cached).toBe(true)
  const [row] = await sql`SELECT tainted FROM kernel.threads WHERE id = ${THREAD}`
  return row.tainted === true
}

describe("analyze_media taints only for a file from outside the org", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug, settings)
      VALUES (${ORG_ID}, 'MediaTaint', 'media-taint', '{}') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.users (id, org_id, email, name, password_hash, status)
      VALUES (${USER_ID}, ${ORG_ID}, 'mt@test.com', 'MT', 'x', 'active') ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.threads (id, org_id, handle, type, created_by)
      VALUES (${THREAD}, ${ORG_ID}, 'media-taint', 'agent_chat', ${USER_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.thread_participants (thread_id, user_id, org_id)
      VALUES (${THREAD}, ${USER_ID}, ${ORG_ID}) ON CONFLICT DO NOTHING`
    await sql`INSERT INTO kernel.file_upload_sessions (id, org_id, created_by, target_app, target_entity_type)
      VALUES (${MEMBER_SESSION}, ${ORG_ID}, ${USER_ID}, 'kernel', 'agent_upload'),
             (${DRIVE_SESSION}, ${ORG_ID}, ${USER_ID}, 'google-drive', 'import')
      ON CONFLICT DO NOTHING`
    await file(MEMBER_FILE, MEMBER_SESSION, USER_ID)
    await file(DRIVE_FILE, DRIVE_SESSION, USER_ID)
    await file(NO_UPLOADER_FILE, MEMBER_SESSION, null)
    await file(COPY_OF_DRIVE, MEMBER_SESSION, USER_ID, DRIVE_FILE)
    await file(COPY_OF_MEMBER, MEMBER_SESSION, USER_ID, MEMBER_FILE)
    await file(BROKEN_COPY, MEMBER_SESSION, USER_ID, GONE)
    // The real file read policy (kernel parents: the upload session is owner-visible).
    await rebuildFilesSelectPolicy()
    const { registerKernelAgentTools } = await import("~/modules/agent/tools/kernel-tools")
    await registerKernelAgentTools(ORG_ID)
  })

  afterAll(async () => {
    toolRegistry.deleteByPrefix([ORG_ID])
    await sql`DELETE FROM kernel.files WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.file_upload_sessions WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.thread_participants WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.threads WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.users WHERE org_id = ${ORG_ID}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG_ID}`
    broadcastSpy.mockRestore()
  })

  it("a file a member uploaded, and a copy of it, leave the turn unmarked", async () => {
    expect(await analyzeAndReadMark(MEMBER_FILE)).toBe(false)
    expect(await analyzeAndReadMark(COPY_OF_MEMBER)).toBe(false)
  })

  it("an integration import, a file with no member uploader, and a copy of an import mark the turn", async () => {
    expect(await analyzeAndReadMark(DRIVE_FILE)).toBe(true)
    expect(await analyzeAndReadMark(NO_UPLOADER_FILE)).toBe(true)
    expect(await analyzeAndReadMark(COPY_OF_DRIVE)).toBe(true)
  })

  it("fails closed: an unknown file and a copy whose source is gone count as outside", async () => {
    expect(await analyzedFileIsExternal({ fileId: GONE }, { orgId: ORG_ID })).toBe(true)
    expect(await analyzedFileIsExternal({ fileId: BROKEN_COPY }, { orgId: ORG_ID })).toBe(true)
    expect(await analyzedFileIsExternal({ fileId: MEMBER_FILE }, { orgId: ORG_ID })).toBe(false)
  })
})
