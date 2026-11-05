// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A config field that names an uploaded file (`contentFileId`) reads it under
// the applying person's own access and org: another person's private upload
// and another org's file are refused, whatever id is pasted. Inline content is
// stored exactly as written (a `${VAR}` is never interpolated).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { sql as drizzleSql } from "drizzle-orm"
import { createKnowledgeCollection } from "~/apps/knowledge/collections"
import { knowledgeActorFromContext } from "~/apps/knowledge/service"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { knowledgeDimensionGrants } from "~/cli/provisioners/knowledge"
import { extractRows } from "~/db"
import { withSystemDb } from "~/db/privileged"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { putObject } from "~/infra/storage/object-storage"
import {
  applySections,
  buildActorProvisionContext,
  planSections,
} from "~/modules/provisioning/config-sections"
import * as minimal from "~/seed/tiers/minimal"
import { bootstrapAdminCtx } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(async () => {
  await acquireTestLock()
  // The files SELECT policy is built at boot from the registered file parents;
  // a fresh test database still carries the migration's placeholder.
  await rebuildFilesSelectPolicy()
})
afterAll(releaseTestLock)

/** A text file in `userId`'s own upload session: readable by them alone. */
async function privateUpload(orgId: string, userId: string, text: string): Promise<string> {
  const fileId = crypto.randomUUID()
  const key = `${orgId}/kernel/file_upload_session/${fileId}/doc.md`
  await putObject({ key, body: Buffer.from(text, "utf8"), contentType: "text/markdown" })
  await withSystemDb("test-private-upload", async (db) => {
    const [session] = extractRows<{ id: string }>(
      await db.execute(drizzleSql`
        INSERT INTO kernel.file_upload_sessions (org_id, created_by, target_app, target_entity_type)
        VALUES (${orgId}::uuid, ${userId}::uuid, 'kernel', 'agent_upload')
        RETURNING id::text AS id`),
    )
    if (!session) throw new Error("no session")
    await db.execute(drizzleSql`
      INSERT INTO kernel.files
        (id, org_id, app, entity_type, entity_id, filename, mime_type, size_bytes, storage_key, uploaded_by)
      VALUES (${fileId}::uuid, ${orgId}::uuid, 'kernel', 'file_upload_session', ${session.id},
              'doc.md', 'text/markdown', ${Buffer.byteLength(text)}, ${key}, ${userId}::uuid)`)
  })
  return fileId
}

async function docBody(orgId: string, title: string): Promise<string | null> {
  const rows = await withSystemDb("test-doc-body", (db) =>
    db.execute(drizzleSql`
      SELECT body FROM app_knowledge.documents WHERE org_id = ${orgId}::uuid AND title = ${title}`),
  )
  return extractRows<{ body: string }>(rows)[0]?.body ?? null
}

function uploadedDoc(title: string, contentFileId: string): ProvisioningConfig {
  return {
    org: { slug: "x", name: "X" },
    knowledge: {
      collections: [{ name: "Policies" }],
      documents: [{ title, collection: "Policies", contentFileId }],
    },
  }
}

// biome-ignore lint/suspicious/noTemplateCurlyInString: a literal ${VAR} config reference, never a JS template.
const ENV_REF = "${HOME}"

describe("uploaded files and inline content on the tool path", () => {
  test("a person's own upload is read and stored; an inline env reference is kept verbatim", async () => {
    const admin = await bootstrapAdminCtx()
    const ctx = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: {
        userId: admin.userId,
        scopes: admin.actor.scopes,
        dimensionGrants: admin.actor.dimensionGrants,
      },
    })
    const fileId = await privateUpload(admin.orgId, admin.userId, "# Returns\nWithin 30 days.")
    await applySections(
      ctx,
      {
        org: { slug: "x", name: "X" },
        knowledge: {
          collections: [{ name: "Policies" }],
          documents: [
            { title: "Returns", collection: "Policies", contentFileId: fileId },
            { title: "Env", collection: "Policies", content: `Token ${ENV_REF} stays.` },
          ],
        },
      },
      ["knowledge"],
    )
    expect(await docBody(admin.orgId, "Returns")).toContain("Within 30 days.")
    expect(await docBody(admin.orgId, "Env")).toBe(`Token ${ENV_REF} stays.`)
  })

  test("another person's private upload in the same org is refused", async () => {
    const admin = await bootstrapAdminCtx()
    const other = await minimal.person(admin.orgId, { role: "admin" })
    const fileId = await privateUpload(admin.orgId, other.id, "private notes")
    const ctx = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: {
        userId: admin.userId,
        scopes: admin.actor.scopes,
        dimensionGrants: admin.actor.dimensionGrants,
      },
    })
    await expect(applySections(ctx, uploadedDoc("Stolen", fileId), ["knowledge"])).rejects.toThrow(
      /not found, or you cannot read it/,
    )
    expect(await docBody(admin.orgId, "Stolen")).toBeNull()
  })

  test("another org's file is refused", async () => {
    const admin = await bootstrapAdminCtx()
    const other = await minimal.secondOrg()
    const fileId = await privateUpload(other.orgId, other.adminUserId, "other org")
    const ctx = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: {
        userId: admin.userId,
        scopes: admin.actor.scopes,
        dimensionGrants: admin.actor.dimensionGrants,
      },
    })
    await expect(applySections(ctx, uploadedDoc("Foreign", fileId), ["knowledge"])).rejects.toThrow(
      /not found, or you cannot read it/,
    )
    expect(await docBody(admin.orgId, "Foreign")).toBeNull()
  })
})

describe("the requester and the approver see the same plan", () => {
  test("a file the requester cannot read is refused at proposal; the plan names the file", async () => {
    const admin = await bootstrapAdminCtx()
    const member = await minimal.person(admin.orgId)
    const fileId = await privateUpload(admin.orgId, admin.userId, "admin's private notes")
    const cfg = uploadedDoc("Borrowed", fileId)
    const asRequester = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: { userId: member.id, scopes: ["*"], dimensionGrants: { "*": ["*"] } },
    })
    await expect(planSections(asRequester, cfg, ["knowledge"])).rejects.toThrow(
      /not found, or you cannot read it/,
    )
    const asOwner = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: {
        userId: admin.userId,
        scopes: admin.actor.scopes,
        dimensionGrants: admin.actor.dimensionGrants,
      },
    })
    const [plan] = await planSections(asOwner, cfg, ["knowledge"])
    expect(plan?.plan.actions.join("\n")).toContain("doc.md")
  })

  test("knowledge collections plan the same for a requester who cannot see one", async () => {
    const admin = await bootstrapAdminCtx()
    const member = await minimal.person(admin.orgId)
    const ownerCtx = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: {
        userId: admin.userId,
        scopes: admin.actor.scopes,
        dimensionGrants: admin.actor.dimensionGrants,
      },
    })
    await ownerCtx.rls((rls) =>
      createKnowledgeCollection(
        rls,
        { name: "Private Shelf", ownerUserId: admin.userId },
        knowledgeActorFromContext({
          orgId: admin.orgId,
          userId: admin.userId,
          scopes: admin.actor.scopes,
          dimensionGrants: knowledgeDimensionGrants(admin.actor.dimensionGrants),
        }),
      ),
    )
    const cfg: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: { collections: [{ name: "Private Shelf" }] },
    }
    const memberCtx = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: { userId: member.id, scopes: ["knowledge:collections:manage"], dimensionGrants: {} },
    })
    const asMember = await planSections(memberCtx, cfg, ["knowledge"])
    const asOwner = await planSections(ownerCtx, cfg, ["knowledge"])
    expect(asMember[0]?.plan.actions).toEqual(asOwner[0]?.plan.actions ?? [])
    expect(asOwner[0]?.plan.actions).toEqual(["collection 'Private Shelf' unchanged"])
  })

  test("applying a collection the approver cannot see creates no duplicate", async () => {
    const admin = await bootstrapAdminCtx()
    const member = await minimal.person(admin.orgId)
    const ownerCtx = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: {
        userId: admin.userId,
        scopes: admin.actor.scopes,
        dimensionGrants: admin.actor.dimensionGrants,
      },
    })
    await ownerCtx.rls((rls) =>
      createKnowledgeCollection(
        rls,
        { name: "Hidden Shelf", ownerUserId: admin.userId },
        knowledgeActorFromContext({
          orgId: admin.orgId,
          userId: admin.userId,
          scopes: admin.actor.scopes,
          dimensionGrants: knowledgeDimensionGrants(admin.actor.dimensionGrants),
        }),
      ),
    )
    const memberCtx = buildActorProvisionContext({
      orgId: admin.orgId,
      actor: { userId: member.id, scopes: ["knowledge:collections:manage"], dimensionGrants: {} },
    })
    await applySections(
      memberCtx,
      { org: { slug: "x", name: "X" }, knowledge: { collections: [{ name: "Hidden Shelf" }] } },
      ["knowledge"],
    )
    const rows = await withSystemDb("t", (db) =>
      db.execute(drizzleSql`
        SELECT id FROM app_knowledge.collections
        WHERE org_id = ${admin.orgId}::uuid AND name = 'Hidden Shelf'`),
    )
    expect(extractRows(rows)).toHaveLength(1)
  })
})
