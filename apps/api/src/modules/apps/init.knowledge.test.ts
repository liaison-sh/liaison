// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "bun:test"
import { sql } from "~/db/connection"
import {
  entityRegistry,
  manifestFileParentRegistry,
  resetAppRegistries,
} from "~/modules/apps/app-registries"
import { getDefaultApps, initAppsForOrg } from "~/modules/apps/init"

const ORG = "11111111-1111-1111-1111-111111111111"

describe("Knowledge app registration", () => {
  beforeAll(async () => {
    await sql`INSERT INTO kernel.organizations (id, name, slug)
      VALUES (${ORG}, 'Knowledge Registration Test', 'knowledge-registration-test')
      ON CONFLICT (id) DO NOTHING`
  })

  beforeEach(() => resetAppRegistries())

  afterAll(async () => {
    resetAppRegistries()
    // The app_knowledge schema is migration-managed (see 0000_initial.sql) — never
    // DROP it here, because other test files share the schema and the migration
    // won't auto-re-run inside the same `bun test` process. Cleaning up org-scoped
    // rows is sufficient.
    await sql`DELETE FROM kernel.apps WHERE org_id = ${ORG}`
    await sql`DELETE FROM kernel.organizations WHERE id = ${ORG}`
  })

  it("registers Knowledge by default with searchable local docs and file parent rules", async () => {
    const apps = await getDefaultApps()
    expect(apps.map((a) => a.name)).toContain("knowledge")

    await initAppsForOrg(ORG, apps)

    const localDoc = entityRegistry.get([ORG, "knowledge", "document"])
    expect(localDoc?.searchable).toBe(true)
    expect(localDoc?.readScope).toBe("knowledge:documents:read")
    expect(localDoc?.permissionFields?.participantIdsField).toBe("participant_ids")
    // team/sensitivity dimensionFields were REMOVED from the search filter (0008
    // search convergence) — org-doc read authorization on search now mirrors the
    // Drive-style sharing ACL via the generic aclFields primitive, not the old
    // team/sensitivity dimension model.
    expect(localDoc?.permissionFields?.dimensionFields).toBeUndefined()
    expect(localDoc?.permissionFields?.aclFields).toEqual({
      orgWideField: "org_wide",
      userIdsField: "acl_user_ids",
      roleIdsField: "acl_role_ids",
    })

    const sourceLink = entityRegistry.get([ORG, "knowledge", "source_link"])
    expect(sourceLink?.searchable).toBe(true)
    expect(sourceLink?.mentionable).toBe(true)
    // Per spec §210, source links are governed by `knowledge:documents:read`;
    // no separate :source-links scope namespace is invented.
    expect(sourceLink?.readScope).toBe("knowledge:documents:read")

    const parent = manifestFileParentRegistry.get([ORG, "knowledge", "document"])
    expect(parent).toEqual({
      tableName: "documents",
      schemaRef: "app_knowledge",
      joinOn: "id",
      readScope: "knowledge:attachments:download",
      writeScope: "knowledge:documents:update",
    })
  })
})

describe("Knowledge migration parity", () => {
  it("squashes Knowledge tables, indexes, RLS policies, and grants into 0000_initial", async () => {
    const migration = await Bun.file(
      new URL("../../db/migrations/0000_initial.sql", import.meta.url),
    ).text()

    expect(migration).toContain("CREATE SCHEMA IF NOT EXISTS app_knowledge")
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS app_knowledge.documents")
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS app_knowledge.source_identities")
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS app_knowledge.source_links")
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS app_knowledge.collections")
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS app_knowledge.collection_memberships")
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS app_knowledge.tags")
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS app_knowledge.taggings")
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS app_knowledge.content_cache_entries")
    expect(migration).toContain("CREATE TABLE IF NOT EXISTS app_knowledge.source_policies")
    expect(migration).toContain("uniq_knowledge_source_identities_source_external")
    expect(migration).toContain("uniq_knowledge_source_links_active_identity")
    expect(migration).toContain("uniq_knowledge_collection_memberships_target")
    expect(migration).toContain("uniq_knowledge_tags_normalized")
    expect(migration).toContain("CREATE POLICY knowledge_documents_select")
    expect(migration).toContain("document_scope = 'personal'")
    expect(migration).toContain(
      "owner_user_id = nullif(current_setting('app.current_user_id', true), '')::uuid",
    )
    expect(migration).toContain("app_knowledge.can_read_knowledge_dimensions(team, sensitivity)")
    expect(migration).toContain("archived_at IS NULL")
    expect(migration).toContain(
      "GRANT SELECT, INSERT, UPDATE, DELETE, REFERENCES ON ALL TABLES IN SCHEMA app_knowledge",
    )
  })
})
