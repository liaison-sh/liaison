// SPDX-License-Identifier: FSL-1.1-ALv2
//
// 0196: synced documents of a confidential or restricted source, written
// org-wide ('editor') before the reconciler derived org_access from the
// source's sensitivity, become 'none'. Their search ACL is recomputed (owner
// and creator) and a `share` event is queued so the search index re-reads
// them. Internal and personal sources, and documents created in Knowledge,
// are untouched. The file is replayed against seeded rows; a second run
// changes nothing and queues nothing.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { randomUUID } from "node:crypto"
import { readFileSync } from "node:fs"
import { sql } from "~/db"

const FILE = new URL("./0196_synced_confidential_org_access.sql", import.meta.url).pathname
const ORG = randomUUID()
const CREATOR = randomUUID()
const COLLECTION = randomUUID()
const SRC = {
  confidential: randomUUID(),
  restricted: randomUUID(),
  internal: randomUUID(),
  personal: randomUUID(),
}
const DOC = {
  confidential: randomUUID(),
  confidentialArchived: randomUUID(),
  confidentialViewer: randomUUID(),
  restricted: randomUUID(),
  internal: randomUUID(),
  personal: randomUUID(),
  native: randomUUID(),
}

async function insertSource(
  id: string,
  sensitivity: string | null,
  owner: string | null,
): Promise<void> {
  await sql`INSERT INTO app_knowledge.synced_sources
      (id, org_id, app_name, folder_ref, display_name, root_collection_id, owner_user_id,
       default_sensitivity, created_by)
    VALUES (${id}, ${ORG}, 'google-drive', ${`ref-${id.slice(0, 8)}`}, 'Mig0196 source',
            ${COLLECTION}, ${owner}, ${sensitivity}, ${CREATOR})`
}

async function insertDoc(opts: {
  id: string
  sourceId: string | null
  scope?: "organization" | "personal"
  sensitivity: string | null
  orgAccess: string
  archived?: boolean
}): Promise<void> {
  // A synced row carries its source identity too (knowledge_documents_synced_pair_check).
  let identityId: string | null = null
  if (opts.sourceId) {
    identityId = randomUUID()
    await sql`INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id)
      VALUES (${identityId}, ${ORG}, 'google-drive', ${`file-${opts.id}`})`
  }
  await sql`INSERT INTO app_knowledge.documents
      (id, org_id, title, body, document_scope, owner_user_id, sensitivity, created_by,
       synced_source_id, source_identity_id, org_access, revision, required_scopes, archived_at,
       participant_ids)
    VALUES (${opts.id}, ${ORG}, 'Mig0196 doc', 'body', ${opts.scope ?? "organization"},
            ${CREATOR}, ${opts.sensitivity}, ${CREATOR}, ${opts.sourceId}, ${identityId},
            ${opts.orgAccess}, 0, '{}'::text[], ${opts.archived ? new Date().toISOString() : null}::timestamptz,
            ${opts.scope === "personal" ? "{}" : null}::jsonb)`
}

async function access(): Promise<Record<string, { orgAccess: string; aclUserIds: string[] }>> {
  const rows = await sql<{ id: string; org_access: string; acl_user_ids: string[] }[]>`
    SELECT id::text AS id, org_access, acl_user_ids FROM app_knowledge.documents
     WHERE org_id = ${ORG}`
  return Object.fromEntries(
    rows.map((r) => [r.id, { orgAccess: r.org_access, aclUserIds: r.acl_user_ids }]),
  )
}

async function shareEvents(): Promise<string[]> {
  const rows = await sql<{ entity_id: string }[]>`
    SELECT payload->>'entityId' AS entity_id FROM kernel.pending_events
     WHERE org_id = ${ORG} AND payload->>'app' = 'knowledge'
       AND payload->>'entity' = 'document' AND payload->>'action' = 'share'
     ORDER BY entity_id`
  return rows.map((r) => r.entity_id)
}

beforeAll(async () => {
  await sql`INSERT INTO kernel.organizations (id, name, slug)
    VALUES (${ORG}, 'Mig0196', ${`mig0196-${ORG.slice(0, 8)}`})`
  await sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version)
    VALUES (${CREATOR}, ${ORG}, ${`creator-${ORG.slice(0, 8)}@mig0196.test`}, 'Creator', 'active', 'h', 1, 1)`
  await sql`INSERT INTO app_knowledge.collections (id, org_id, name, owner_user_id)
    VALUES (${COLLECTION}, ${ORG}, 'Mig0196 root', ${CREATOR})`
  await insertSource(SRC.confidential, "confidential", null)
  await insertSource(SRC.restricted, "restricted", null)
  await insertSource(SRC.internal, "internal", null)
  await insertSource(SRC.personal, null, CREATOR)
  // What the reconciler wrote before: every synced row at the default 'editor',
  // and a search ACL never computed.
  await insertDoc({
    id: DOC.confidential,
    sourceId: SRC.confidential,
    sensitivity: "confidential",
    orgAccess: "editor",
  })
  await insertDoc({
    id: DOC.confidentialArchived,
    sourceId: SRC.confidential,
    sensitivity: "confidential",
    orgAccess: "editor",
    archived: true,
  })
  await insertDoc({
    id: DOC.confidentialViewer,
    sourceId: SRC.confidential,
    sensitivity: "confidential",
    orgAccess: "viewer",
  })
  await insertDoc({
    id: DOC.restricted,
    sourceId: SRC.restricted,
    sensitivity: "restricted",
    orgAccess: "editor",
  })
  await insertDoc({
    id: DOC.internal,
    sourceId: SRC.internal,
    sensitivity: "internal",
    orgAccess: "editor",
  })
  await insertDoc({
    id: DOC.personal,
    sourceId: SRC.personal,
    scope: "personal",
    sensitivity: null,
    orgAccess: "editor",
  })
  // Created in Knowledge, deliberately opened org-wide by its owner.
  await insertDoc({
    id: DOC.native,
    sourceId: null,
    sensitivity: "confidential",
    orgAccess: "viewer",
  })
})

afterAll(async () => {
  await sql`DELETE FROM kernel.pending_events WHERE org_id = ${ORG}`
  await sql`DELETE FROM app_knowledge.documents WHERE org_id = ${ORG}`
  await sql`DELETE FROM app_knowledge.synced_sources WHERE org_id = ${ORG}`
  await sql`DELETE FROM app_knowledge.source_identities WHERE org_id = ${ORG}`
  await sql`DELETE FROM app_knowledge.collections WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.users WHERE org_id = ${ORG}`
  await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
})

describe("0196 synced confidential documents lose org-wide access", () => {
  it("closes confidential and restricted synced rows, recomputes their ACL and queues a share event", async () => {
    await sql.unsafe(readFileSync(FILE, "utf8"))
    const after = await access()
    for (const id of [
      DOC.confidential,
      DOC.confidentialArchived,
      DOC.confidentialViewer,
      DOC.restricted,
    ]) {
      expect(after[id]?.orgAccess).toBe("none")
      expect(after[id]?.aclUserIds).toContain(CREATOR)
    }
    expect(after[DOC.internal]?.orgAccess).toBe("editor")
    expect(after[DOC.personal]?.orgAccess).toBe("editor")
    expect(after[DOC.native]?.orgAccess).toBe("viewer")
    const [orgWide] = await sql<{ org_wide: boolean }[]>`
      SELECT org_wide FROM app_knowledge.documents WHERE id = ${DOC.confidential}`
    expect(orgWide?.org_wide).toBe(false)
    expect(await shareEvents()).toEqual(
      [DOC.confidential, DOC.confidentialArchived, DOC.confidentialViewer, DOC.restricted].sort(),
    )
  })

  it("a replay changes nothing and queues nothing", async () => {
    const before = await access()
    await sql.unsafe(readFileSync(FILE, "utf8"))
    expect(await access()).toEqual(before)
    expect(await shareEvents()).toHaveLength(4)
  })
})
