// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Real-DB unit test for the knowledge provisioner (Task 12).
 *
 * - collections: idempotent by NAME (correction #13 — there is no slug column on
 *   KnowledgeCollectionInput). Create → row exists; re-run same name → no dup.
 * - documents: explicit (orgId, collection, title) pre-check via findOrgDocByTitle
 *   scoped to the resolved collection. Create from contentFile → doc in the
 *   collection with the file body; re-run same (collection,title) → skip, count==1.
 * - documents edge: missing contentFile on disk → clean exit-2, no partial doc.
 * - documents edge: path-traversal contentFile (absolute escape) → rejected, no doc.
 * - sources: a source referencing a pending/absent connection → reported pending,
 *   NOT created (headless synced-source register requires a live active connection
 *   + an external network precheck → scoped to pending; see sourcesDecision).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import crypto from "node:crypto"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { knowledgeRel } from "~/apps/knowledge/schema-refs"
import { ConfigError } from "~/cli/config/parse"
import type { ProvisioningConfig } from "~/cli/config/schema"
import { knowledgeProvisioner } from "~/cli/provisioners/knowledge"
import { buildProvisionContext, type ProvisionContext } from "~/cli/provisioners/types"
import { extractRows } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) {
    try {
      rmSync(d, { recursive: true, force: true })
    } catch {
      // best-effort cleanup
    }
  }
})

function freshTmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), "cli-kb-"))
  tmpDirs.push(d)
  return d
}

async function freshOrgWithAdmin(
  configDir: string,
): Promise<{ ctx: ProvisionContext; orgId: string }> {
  const { orgId } = await ensureOrg({
    slug: `cli-kb-${crypto.randomUUID().slice(0, 12)}`,
    name: "KbTestOrg",
  })
  const { userId } = await ensureUser({
    orgId,
    email: `admin-${crypto.randomUUID().slice(0, 8)}@fabrikam.example`,
    name: "Owner",
    password: "pw-kb-1!",
    role: "admin",
  })
  const ctx = buildProvisionContext({ log: () => {}, validateByok: false, configDir })
  ctx.orgId = orgId
  ctx.actor.userId = userId
  ctx.actor.scopes = ["*"]
  return { ctx, orgId }
}

interface KbSection {
  collections: number
  documents: number
  sources: number
}

async function countCollectionsByName(orgId: string, name: string): Promise<number> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id FROM ${knowledgeRel("collections")}
      WHERE org_id = ${orgId}::uuid AND name = ${name} AND archived_at IS NULL
    `),
  )
  return extractRows(rows).length
}

async function findCollectionId(orgId: string, name: string): Promise<string | undefined> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT id FROM ${knowledgeRel("collections")}
      WHERE org_id = ${orgId}::uuid AND name = ${name} AND archived_at IS NULL LIMIT 1
    `),
  )
  return extractRows<{ id: string }>(rows)[0]?.id
}

async function docsInCollectionWithTitle(
  orgId: string,
  collectionId: string,
  title: string,
): Promise<Array<{ id: string; body: string }>> {
  const rows = await withPrivilegedDb(orgId, "t", (tx) =>
    tx.execute(drizzleSql`
      SELECT d.id, d.body FROM ${knowledgeRel("documents")} d
      JOIN ${knowledgeRel("collection_memberships")} m
        ON m.target_id = d.id AND m.org_id = d.org_id AND m.target_type = 'document'
      WHERE d.org_id = ${orgId}::uuid AND m.collection_id = ${collectionId}::uuid
        AND btrim(d.title) = ${title.trim()} AND d.archived_at IS NULL
    `),
  )
  return extractRows<{ id: string; body: string }>(rows)
}

describe("knowledge provisioner (Task 12)", () => {
  test("collections: create by name, re-run no dup", async () => {
    const dir = freshTmpDir()
    const { ctx, orgId } = await freshOrgWithAdmin(dir)
    const name = `Runbooks-${crypto.randomUUID().slice(0, 8)}`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: { collections: [{ name, slug: "runbooks" }] },
    }

    const r1 = await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    const s1 = r1.section as KbSection
    expect(s1.collections).toBe(1)
    expect(await countCollectionsByName(orgId, name)).toBe(1)

    // Re-run → idempotent by NAME (no dup).
    await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    expect(await countCollectionsByName(orgId, name)).toBe(1)
  })

  test("documents: create from contentFile, re-run skip (by collection+title)", async () => {
    const dir = freshTmpDir()
    const { ctx, orgId } = await freshOrgWithAdmin(dir)
    const colName = `Docs-${crypto.randomUUID().slice(0, 8)}`
    const title = `How to deploy ${crypto.randomUUID().slice(0, 6)}`
    const body = "# Deploy\n\nRun `liaison config apply`.\n"
    writeFileSync(join(dir, "deploy.md"), body)

    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: {
        collections: [{ name: colName }],
        documents: [{ title, collection: colName, contentFile: "deploy.md" }],
      },
    }

    const r1 = await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    const s1 = r1.section as KbSection
    expect(s1.documents).toBe(1)

    const colId = await findCollectionId(orgId, colName)
    expect(colId).toBeDefined()
    if (!colId) throw new Error("collection not found")
    const docs1 = await docsInCollectionWithTitle(orgId, colId, title)
    expect(docs1.length).toBe(1)
    expect(docs1[0]?.body).toBe(body)

    // Re-run → skip (count stays 1).
    await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    const docs2 = await docsInCollectionWithTitle(orgId, colId, title)
    expect(docs2.length).toBe(1)
  })

  test("documents edge: missing contentFile → clean exit-2, no partial doc", async () => {
    const dir = freshTmpDir()
    const { ctx, orgId } = await freshOrgWithAdmin(dir)
    const colName = `Missing-${crypto.randomUUID().slice(0, 8)}`
    const title = `Ghost doc ${crypto.randomUUID().slice(0, 6)}`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: {
        collections: [{ name: colName }],
        documents: [{ title, collection: colName, contentFile: "does-not-exist.md" }],
      },
    }

    let thrown: unknown
    try {
      await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ConfigError)
    expect((thrown as ConfigError).exitCode).toBe(2)

    // No partial doc landed.
    const colId = await findCollectionId(orgId, colName)
    if (colId) {
      const docs = await docsInCollectionWithTitle(orgId, colId, title)
      expect(docs.length).toBe(0)
    }
  })

  test("documents edge: path-traversal contentFile (absolute escape) → rejected", async () => {
    const dir = freshTmpDir()
    const { ctx } = await freshOrgWithAdmin(dir)
    const colName = `Traversal-${crypto.randomUUID().slice(0, 8)}`
    // An absolute path that escapes the config dir must be rejected.
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: {
        collections: [{ name: colName }],
        documents: [{ title: "etc passwd", collection: colName, contentFile: "/etc/passwd" }],
      },
    }
    let thrown: unknown
    try {
      await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ConfigError)
    expect((thrown as ConfigError).exitCode).toBe(2)
  })

  test("documents edge: relative ../ traversal escaping config dir → rejected", async () => {
    const dir = freshTmpDir()
    const { ctx } = await freshOrgWithAdmin(dir)
    const colName = `Traversal2-${crypto.randomUUID().slice(0, 8)}`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: {
        collections: [{ name: colName }],
        documents: [{ title: "escape", collection: colName, contentFile: "../../../etc/passwd" }],
      },
    }
    let thrown: unknown
    try {
      await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(ConfigError)
    expect((thrown as ConfigError).exitCode).toBe(2)
  })

  test("sources: referencing a pending/absent connection → reported pending, not created", async () => {
    const dir = freshTmpDir()
    const { ctx, orgId } = await freshOrgWithAdmin(dir)
    const colName = `Wiki-${crypto.randomUUID().slice(0, 8)}`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: {
        collections: [{ name: colName }],
        // gitlab connection is NOT active for this fresh org → must report pending.
        sources: [{ type: "gitlab", app: "gitlab", path: "group/repo" }],
      },
    }

    const r = await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    const section = r.section as KbSection
    expect(section.sources).toBe(0)

    const pending = r.pending ?? []
    expect(pending.find((p) => p.app === "gitlab")).toBeDefined()

    // No synced_sources row was created.
    const rows = await withPrivilegedDb(orgId, "t", (tx) =>
      tx.execute(drizzleSql`
        SELECT id FROM ${knowledgeRel("synced_sources")} WHERE org_id = ${orgId}::uuid
      `),
    )
    expect(extractRows(rows).length).toBe(0)
  })

  test("documents from a dir: one per file, titles from front matter/heading/name, re-run no dup", async () => {
    const dir = freshTmpDir()
    const { ctx, orgId } = await freshOrgWithAdmin(dir)
    const colName = `Website-${crypto.randomUUID().slice(0, 8)}`
    const tag = crypto.randomUUID().slice(0, 6)
    mkdirSync(join(dir, "knowledge/website/docs"), { recursive: true })
    mkdirSync(join(dir, "knowledge/website/node_modules/x"), { recursive: true })
    writeFileSync(
      join(dir, "knowledge/website/pricing.md"),
      `---\ntitle: Pricing ${tag}\nsource: https://acme.example/pricing\n---\n\nPlans start at 10 EUR.\n`,
    )
    writeFileSync(join(dir, "knowledge/website/docs/install.md"), `# Install ${tag}\n\nRun it.\n`)
    writeFileSync(join(dir, `knowledge/website/notes-${tag}.txt`), "Plain notes.\n")
    writeFileSync(join(dir, "knowledge/website/empty.md"), "   \n")
    writeFileSync(join(dir, "knowledge/website/node_modules/x/readme.md"), "# Vendored\n")
    writeFileSync(join(dir, "knowledge/website/.env.md"), "SECRET=1\n")
    writeFileSync(join(dir, "knowledge/website/logo.svg"), "<svg/>")

    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: {
        collections: [{ name: colName }],
        documents: [{ dir: "knowledge/website", collection: colName }],
      },
    }

    const r1 = await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    const s1 = r1.section as KbSection & { skipped?: Array<{ path: string }> }
    expect(s1.documents).toBe(3)
    expect(s1.skipped?.map((x) => x.path)).toEqual(["knowledge/website/empty.md"])

    const colId = await findCollectionId(orgId, colName)
    if (!colId) throw new Error("collection not found")
    const pricing = await docsInCollectionWithTitle(orgId, colId, `Pricing ${tag}`)
    expect(pricing.length).toBe(1)
    expect(pricing[0]?.body).toBe(
      "Source: https://acme.example/pricing\n\nPlans start at 10 EUR.\n",
    )
    expect((await docsInCollectionWithTitle(orgId, colId, `Install ${tag}`)).length).toBe(1)
    expect((await docsInCollectionWithTitle(orgId, colId, `notes-${tag}`)).length).toBe(1)
    expect((await docsInCollectionWithTitle(orgId, colId, "Vendored")).length).toBe(0)

    // Re-run over the same tree: nothing new.
    const r2 = await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    expect(r2.changed ?? []).toEqual([])
    expect((await docsInCollectionWithTitle(orgId, colId, `Pricing ${tag}`)).length).toBe(1)
  })

  test("documents from a dir: a dir outside the config directory is rejected", async () => {
    const dir = freshTmpDir()
    const { ctx } = await freshOrgWithAdmin(dir)
    const colName = `Escape-${crypto.randomUUID().slice(0, 8)}`
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: {
        collections: [{ name: colName }],
        documents: [{ dir: "../", collection: colName }],
      },
    }
    await expect(knowledgeProvisioner.apply(ctx, { actions: [] }, config)).rejects.toBeInstanceOf(
      ConfigError,
    )
  })

  test("documents: the same title in two collections is two documents, and a re-run adds neither again", async () => {
    const dir = freshTmpDir()
    const { ctx, orgId } = await freshOrgWithAdmin(dir)
    const tag = crypto.randomUUID().slice(0, 6)
    const a = `Site-${tag}`
    const b = `Docs-${tag}`
    const title = `Acme ${tag}`
    writeFileSync(join(dir, "site.md"), "# Site\n")
    writeFileSync(join(dir, "readme.md"), "# Readme\n")
    const config: ProvisioningConfig = {
      org: { slug: "x", name: "X" },
      knowledge: {
        collections: [{ name: a }, { name: b }],
        documents: [
          { title, collection: a, contentFile: "site.md" },
          { title, collection: b, contentFile: "readme.md" },
        ],
      },
    }
    await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    const rerun = await knowledgeProvisioner.apply(ctx, { actions: [] }, config)
    expect(rerun.changed ?? []).toEqual([])
    const colA = await findCollectionId(orgId, a)
    const colB = await findCollectionId(orgId, b)
    if (!colA || !colB) throw new Error("collections not found")
    expect(await docsInCollectionWithTitle(orgId, colA, title)).toHaveLength(1)
    expect(await docsInCollectionWithTitle(orgId, colB, title)).toHaveLength(1)
  })
})
