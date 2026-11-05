// SPDX-License-Identifier: FSL-1.1-ALv2
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from "bun:test"
import { sql } from "drizzle-orm"
import { extractRows } from "~/db"
import { __privileged_db__ as db } from "~/db/connection"
import * as searchClientModule from "~/infra/search/client"
import { entityRegistry } from "~/modules/apps/app-registries"
import { mentionSearch } from "~/modules/search/service"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const meiliSearch = mock(async () => ({ hits: [], estimatedTotalHits: 0 }))
const spies: Array<{ mockRestore: () => void }> = []

describe("Knowledge mention fallback", () => {
  let orgId: string
  let ownerId: string
  let otherId: string
  let titleSuffix: string

  // File-level lock: this test writes to kernel.{organizations,users} +
  // app_knowledge.{documents,source_identities,source_links}. Without the
  // lock, acquireTestLock's `TRUNCATE kernel.organizations CASCADE` from a
  // concurrently-starting test file pulls knowledge tables into the
  // AccessExclusive lock graph (CASCADE follows the org_id FK), deadlocking
  // against this file's in-flight INSERTs. The advisory lock serialises
  // file-scope setup so the CASCADE never races concurrent knowledge writes.
  beforeAll(acquireTestLock)
  afterAll(releaseTestLock)

  beforeEach(async () => {
    meiliSearch.mockClear()
    spies.push(
      spyOn(searchClientModule, "effectiveIndexName").mockReturnValue("test_liaison_search"),
    )
    spies.push(
      spyOn(searchClientModule, "getMeili").mockReturnValue({
        index: () => ({ search: meiliSearch }),
      } as any),
    )

    const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`
    titleSuffix = suffix
    const [org] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.organizations (id, name, slug) VALUES (gen_random_uuid(), 'KnowledgeMention', ${`knowledge-mention-${suffix}`}) RETURNING id`,
      ),
    )
    orgId = org.id
    const [owner] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version) VALUES (gen_random_uuid(), ${orgId}::uuid, ${`owner-${suffix}@x.test`}, 'Owner', 'active', 'h', 1, 1) RETURNING id`,
      ),
    )
    ownerId = owner.id
    const [other] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO kernel.users (id, org_id, email, name, status, password_hash, auth_version, permission_version) VALUES (gen_random_uuid(), ${orgId}::uuid, ${`other-${suffix}@x.test`}, 'Other', 'active', 'h', 1, 1) RETURNING id`,
      ),
    )
    otherId = other.id

    entityRegistry.set([orgId, "knowledge", "document"], {
      searchable: true,
      mentionable: true,
      tableName: "documents",
      labelField: "title",
      handlePrefix: "#",
      readScope: "knowledge:documents:read",
      indexFields: { title: "title", body: "body", labelSecondary: "summary" },
      permissionFields: {
        readScope: "knowledge:documents:read",
        participantIdsField: "participant_ids",
        dimensionFields: ["team", "sensitivity"],
      },
    })
    entityRegistry.set([orgId, "knowledge", "source_link"], {
      searchable: true,
      mentionable: true,
      tableName: "source_links",
      labelField: "title",
      handlePrefix: "#",
      readScope: "knowledge:source-links:read",
      indexFields: { title: "title", labelSecondary: "summary" },
      permissionFields: { readScope: "knowledge:source-links:read", dimensionFields: [] },
    })
  })

  afterEach(() => {
    for (const spy of spies) spy.mockRestore()
    spies.length = 0
    if (orgId) {
      entityRegistry.delete([orgId, "knowledge", "document"])
      entityRegistry.delete([orgId, "knowledge", "source_link"])
    }
  })

  it("returns authorized Knowledge document and linked-source labels only", async () => {
    const [doc] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO app_knowledge.documents (id, org_id, title, body, document_scope, owner_user_id, participant_ids, created_by, revision, required_scopes) VALUES (gen_random_uuid(), ${orgId}::uuid, ${`Private launch note ${titleSuffix}`}, 'body', 'personal', ${ownerId}::uuid, ${JSON.stringify([ownerId])}::jsonb, ${ownerId}::uuid, 1, '{}'::text[]) RETURNING id`,
      ),
    )
    const [identity] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO app_knowledge.source_identities (id, org_id, source, external_id, url) VALUES (gen_random_uuid(), ${orgId}::uuid, 'google-drive', 'g1', 'https://drive/g1') RETURNING id`,
      ),
    )
    const [link] = extractRows<{ id: string }>(
      await db.execute(
        sql`INSERT INTO app_knowledge.source_links (id, org_id, source_identity_id, source, external_id, title, summary, url, owner_user_id) VALUES (gen_random_uuid(), ${orgId}::uuid, ${identity.id}::uuid, 'google-drive', 'g1', ${`Drive launch note ${titleSuffix}`}, 'metadata only', 'https://drive/g1', ${ownerId}::uuid) RETURNING id`,
      ),
    )

    const ownerHits = await mentionSearch({
      orgId,
      userId: ownerId,
      scopes: ["knowledge:documents:read", "knowledge:source-links:read"],
      dimensionGrants: {},
      q: titleSuffix,
      type: "entity",
      limit: 10,
    })
    const ownerHitIds = ownerHits.map((hit) => hit.id)
    expect(ownerHitIds).toContain(doc.id)
    expect(ownerHitIds).toContain(link.id)

    const otherHits = await mentionSearch({
      orgId,
      userId: otherId,
      scopes: ["knowledge:documents:read"],
      dimensionGrants: {},
      q: titleSuffix,
      type: "entity",
      limit: 10,
    })
    expect(otherHits).toEqual([])
  })
})
