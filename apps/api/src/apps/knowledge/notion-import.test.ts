// SPDX-License-Identifier: FSL-1.1-ALv2
// A Notion export written into Knowledge (K7 T7.3), end to end: the built-in
// transform's records through the real runner into the knowledge kinds, on a real
// database. Folders with their folder pages, pages, page links resolved after every
// page exists, files copied onto their pages, a database as a table of 200 rows with
// its row pages inside; who sees it ("Only me" private per person, shared per
// organisation); every item not carried named; a second run creating nothing;
// undo removing all of it but a page someone edited.
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { sql as drizzleSql } from "drizzle-orm"
import { KnowledgeImportTestAccess } from "~/apps/knowledge/import-kind"
import {
  archiveKnowledgeDocument,
  knowledgeActorFromContext,
  updateKnowledgeDocument,
} from "~/apps/knowledge/service"
import { extractRows, sql } from "~/db"
import { withPrivilegedDb } from "~/db/privileged"
import { type UserContext, withRlsContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { getObjectBuffer } from "~/infra/storage/object-storage"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { builtinSourceLabel } from "~/modules/imports/builtin/registry"
import { buildZip, type FixtureEntry } from "~/modules/imports/parsers/__test-helpers__/zip-writer"
import { runImport } from "~/modules/imports/runner"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const A = "a0000000000000000000000000000001" // Harbor Handbook: a page with children
const B = "b0000000000000000000000000000002" // Onboarding: files, links, losses
const C = "c0000000000000000000000000000003" // Policies: links back to the handbook
const D = "d0000000000000000000000000000004" // Projects: a database
const E = "e0000000000000000000000000000005" // Launch: a row page of Projects
const F = "f0000000000000000000000000000006" // Field Notes: older export
const G = "a1000000000000000000000000000007" // Visit: inside Field Notes
const H = "b1000000000000000000000000000008" // Inventory: 205 rows

const KINDS = ["knowledge.collection", "knowledge.document"]
const FIXTURES = join(import.meta.dir, "../../modules/imports/builtin/__fixtures__/notion")
const MEMBER_SCOPES = [
  "knowledge:documents:read",
  "knowledge:documents:create",
  "knowledge:documents:update",
  "knowledge:collections:manage",
  "knowledge:links:create",
  "knowledge:attachments:download",
  "knowledge:attachments:upload",
  "kernel:imports:run",
  "kernel:imports:undo",
]
type Access = "private" | "view" | "edit"

let orgId = ""
let dir = ""
const tag = () => crypto.randomUUID().slice(0, 8)

async function person(role: "admin" | "member"): Promise<UserContext> {
  const userId = (
    await ensureUser({
      orgId,
      email: `${role}-${tag()}@harborfinch.example`,
      name: role,
      password: "pw-notion-1!",
      role,
    })
  ).userId
  return {
    actorType: "user",
    userId,
    orgId,
    scopes: role === "admin" ? ["*"] : MEMBER_SCOPES,
    dimensionGrants:
      role === "admin" ? { "*": ["*"] } : { sensitivity: ["public", "internal"], team: [] },
  }
}

/** Every fixture file of one generation, at the zip's root. */
function fixtureEntries(generation: "current" | "older"): FixtureEntry[] {
  const root = join(FIXTURES, generation)
  const out: FixtureEntry[] = []
  const walk = (d: string) => {
    for (const name of readdirSync(d)) {
      const p = join(d, name)
      if (statSync(p).isDirectory()) walk(p)
      else out.push({ name: relative(root, p), data: readFileSync(p) })
    }
  }
  walk(root)
  return out
}

function inventory(): FixtureEntry {
  const rows = Array.from({ length: 205 }, (_, i) => `Item ${i + 1},${i % 7}`)
  return {
    name: `Harbor Handbook ${A}/Inventory ${H}.csv`,
    data: `Name,Count\n${rows.join("\n")}\n`,
  }
}

/** The fixture export (both generations), every Notion id given this suffix so that
 *  one test's shared import does not meet another's. */
function exportOf(suffix = ""): FixtureEntry[] {
  const swap = (s: string) =>
    suffix ? s.replace(/[0-9a-f]{32}/g, (hex) => hex.slice(0, 32 - suffix.length) + suffix) : s
  return [...fixtureEntries("current"), ...fixtureEntries("older"), inventory()].map((e) => {
    const text = /\.(md|csv)$/.test(e.name)
    return {
      name: swap(e.name),
      data: text ? swap(Buffer.from(e.data ?? "").toString("utf8")) : e.data,
    }
  })
}

const ids = (suffix: string) => {
  const s = (hex: string) => (suffix ? hex.slice(0, 32 - suffix.length) + suffix : hex)
  return { A: s(A), B: s(B), C: s(C), D: s(D), E: s(E), F: s(F), G: s(G), H: s(H) }
}

function zipFile(entries: FixtureEntry[]): string {
  const path = join(dir, `${crypto.randomUUID()}.zip`)
  writeFileSync(path, buildZip(entries))
  return path
}

const labelOf = (actor: UserContext, access: Access) =>
  builtinSourceLabel("notion-export", { access }, actor.userId)

function notion(
  actor: UserContext,
  zip: string,
  access: Access = "private",
  extra: { dryRun?: boolean; afterBatch?: (i: number, runId: string) => Promise<void> } = {},
) {
  return runImport({
    orgId,
    actor,
    kinds: KINDS,
    source: {
      type: "transform",
      transform: { builtin: "notion-export", params: { access } },
      input: { type: "paths", paths: [zip] },
    },
    sourceLabel: labelOf(actor, access),
    mode: "cli",
    ...(extra.dryRun ? { dryRun: true } : {}),
    ...(extra.afterBatch ? { hooks: { afterBatch: extra.afterBatch } } : {}),
  })
}

interface DocRow {
  id: string
  title: string
  body: string
  revision: number
  org_access: string
  document_scope: string
  owner_user_id: string
  updated_at: string
}

async function docOf(label: string, hex: string): Promise<DocRow | undefined> {
  const [row] = await sql`
    SELECT id::text AS id, title, body, revision, org_access, document_scope,
           owner_user_id::text AS owner_user_id, updated_at
      FROM app_knowledge.documents WHERE org_id = ${orgId} AND external_ref = ${`${label}:${hex}`}`
  return row as DocRow | undefined
}

async function folderOf(label: string, hex: string) {
  const [row] = await sql`
    SELECT id::text AS id, name, owner_user_id::text AS owner_user_id,
           parent_collection_id::text AS parent, index_document_id::text AS index_document_id
      FROM app_knowledge.collections WHERE org_id = ${orgId} AND external_ref = ${`${label}:${hex}`}`
  return row as
    | {
        id: string
        name: string
        owner_user_id: string | null
        parent: string | null
        index_document_id: string | null
      }
    | undefined
}

async function foldersOfDoc(docId: string): Promise<string[]> {
  const rows = await sql`
    SELECT collection_id::text AS id FROM app_knowledge.collection_memberships
     WHERE org_id = ${orgId} AND target_type = 'document' AND target_id = ${docId}`
  return rows.map((r) => r.id as string)
}

async function countOf(label: string) {
  const like = `${label}:%`
  const [d] =
    await sql`SELECT count(*)::int AS n FROM app_knowledge.documents WHERE org_id = ${orgId} AND external_ref LIKE ${like}`
  const [c] =
    await sql`SELECT count(*)::int AS n FROM app_knowledge.collections WHERE org_id = ${orgId} AND external_ref LIKE ${like}`
  return { docs: d!.n as number, folders: c!.n as number }
}

/** What a person sees under their own row security. */
async function seenBy(
  actor: UserContext,
  docIds: string[],
  folderIds: string[],
  fileIds: string[],
) {
  return withRlsContext(actor, async (tx) => {
    const n = async (q: ReturnType<typeof drizzleSql>) =>
      extractRows<{ n: number }>(await tx.execute(q))[0]!.n
    return {
      docs: await n(drizzleSql`SELECT count(*)::int AS n FROM app_knowledge.documents
                                WHERE id = ANY(${`{${docIds.join(",")}}`}::uuid[])`),
      folders: await n(drizzleSql`SELECT count(*)::int AS n FROM app_knowledge.collections
                                   WHERE id = ANY(${`{${folderIds.join(",")}}`}::uuid[])`),
      files: await n(drizzleSql`SELECT count(*)::int AS n FROM kernel.files
                                 WHERE id = ANY(${`{${fileIds.join(",")}}`}::uuid[])`),
    }
  })
}

async function filesOf(docId: string) {
  return (await sql`
    SELECT id::text AS id, filename, mime_type, storage_key FROM kernel.files
     WHERE org_id = ${orgId} AND app = 'knowledge' AND entity_type = 'document' AND entity_id = ${docId}
     ORDER BY filename`) as unknown as Array<{
    id: string
    filename: string
    mime_type: string
    storage_key: string
  }>
}

const lossesOf = (report: Record<string, unknown>) =>
  ((report.losses ?? []) as Array<{ what: string; where: string }>).map(
    (l) => `${l.where}: ${l.what}`,
  )

beforeAll(async () => {
  await acquireTestLock()
  dir = mkdtempSync(join(tmpdir(), "notion-import-test-"))
  orgId = (await ensureOrg({ slug: `notion-${tag()}`, name: "Harbor & Finch" })).orgId
  await ensureAppsForOrg(orgId)
  await rebuildFilesSelectPolicy()
}, 300_000)

afterAll(async () => {
  KnowledgeImportTestAccess.setCopyObject(null)
  rmSync(dir, { recursive: true, force: true })
  await shutdownTransformPool()
  await releaseTestLock()
})

describe("Notion export into Knowledge", () => {
  it("writes folders with folder pages, pages, a table, files and resolved links (both generations)", async () => {
    const amina = await person("member")
    const run = await notion(amina, zipFile(exportOf()))
    expect(run.status).toBe("done")
    expect(run.errors).toEqual([])
    expect(run.counts["knowledge.document"]).toEqual({ created: 8, skipped: 0, failed: 0 })
    const label = labelOf(amina, "private")

    // Every page is a private organisation page of its person (C7).
    for (const hex of [A, B, C, D, E, F, G, H]) {
      const d = (await docOf(label, hex))!
      expect([d.document_scope, d.org_access, d.owner_user_id]).toEqual([
        "organization",
        "none",
        amina.userId,
      ])
      expect(d.body).not.toContain("notion-ref:")
      expect(d.body).not.toContain("import-file:")
    }

    // A page with children is a folder whose page it is, filed in that folder.
    const handbook = (await folderOf(label, A))!
    const handbookPage = (await docOf(label, A))!
    expect(handbook.name).toBe("Harbor Handbook")
    expect(handbook.owner_user_id).toBe(amina.userId)
    expect(handbook.index_document_id).toBe(handbookPage.id)
    expect(await foldersOfDoc(handbookPage.id)).toEqual([handbook.id])
    const policies = (await docOf(label, C))!
    expect(await foldersOfDoc(policies.id)).toEqual([handbook.id])
    // Older export: the folder without an id still holds its child.
    const field = (await folderOf(label, F))!
    expect(field.index_document_id).toBe((await docOf(label, F))!.id)
    expect(await foldersOfDoc((await docOf(label, G))!.id)).toEqual([field.id])

    // Links between exported pages are page tokens, recorded as links.
    expect(handbookPage.body).toContain(`[](knowledge:document:${policies.id})`)
    expect(policies.body).toContain(`[](knowledge:document:${handbookPage.id})`)
    expect(policies.revision).toBe(2)
    const [link] = await sql`
      SELECT 1 AS ok FROM app_knowledge.document_links
       WHERE source_document_id = ${policies.id} AND target_document_id = ${handbookPage.id}`
    expect(link).toBeDefined()

    // A database: its page holds the table, its row pages are inside its folder.
    const projects = (await folderOf(label, D))!
    const projectsPage = (await docOf(label, D))!
    const launch = (await docOf(label, E))!
    expect(projects.index_document_id).toBe(projectsPage.id)
    expect(projectsPage.body).toContain("| Name | Status | Owner page |")
    expect(projectsPage.body).toContain(`[](knowledge:document:${launch.id})`)
    expect(await foldersOfDoc(launch.id)).toEqual([projects.id])
    // A page whose folder holds only its files is a page, not a folder.
    expect(await folderOf(label, E)).toBeUndefined()
    expect(await folderOf(label, B)).toBeUndefined()
    const inventoryPage = (await docOf(label, H))!
    expect(inventoryPage.body.split("\n").filter((l) => l.startsWith("| Item ")).length).toBe(200)

    // Files of the export are Liaison files of their page, named by a file token.
    const onboarding = (await docOf(label, B))!
    const files = await filesOf(onboarding.id)
    expect(files.map((f) => f.filename).sort()).toEqual(["contract.pdf", "team.png"])
    for (const f of files) expect(onboarding.body).toContain(`![](liaison-file:${f.id})`)
    expect(files.find((f) => f.filename === "team.png")!.mime_type).toBe("image/png")

    // History starts with the import, holding the final text.
    const versions = await sql`
      SELECT kind, body FROM app_knowledge.document_versions WHERE document_id = ${policies.id}`
    expect(versions.map((v) => v.kind)).toEqual(["import"])
    expect(versions[0]!.body).toBe(policies.body)

    // Nothing not carried is silent: each is named with its page.
    const losses = lossesOf(run.report)
    expect(losses).toContain("Onboarding: web image (https://images.example.com/skyline.png)")
    expect(losses).toContain("Onboarding: link to a page not in the export (old wiki page)")
    expect(losses.some((l) => l.startsWith("Onboarding: file missing from the export"))).toBe(true)
    expect(losses).toContain("Inventory: 5 rows past the first 200 are not in the table")
  }, 120_000)

  it("a second run creates nothing and names every item already imported", async () => {
    const amina = await person("member")
    const zip = zipFile(exportOf())
    await notion(amina, zip)
    const again = await notion(amina, zip)
    expect(again.counts["knowledge.document"]).toEqual({ created: 0, skipped: 8, failed: 0 })
    expect(again.counts["knowledge.collection"]!.created).toBe(0)
    const losses = lossesOf(again.report)
    for (const title of ["Harbor Handbook", "Onboarding", "Policies", "Visit"]) {
      expect(losses).toContain(`${title}: already imported`)
    }
  }, 120_000)

  it("the preview names what would not come across and, after a run, what is already there", async () => {
    const amina = await person("member")
    const zip = zipFile(exportOf())
    const preview = await notion(amina, zip, "private", { dryRun: true })
    expect(preview.counts["knowledge.document"]).toEqual({ created: 8, skipped: 0, failed: 0 })
    expect(lossesOf(preview.report)).toContain(
      "Onboarding: web image (https://images.example.com/skyline.png)",
    )
    expect(await countOf(labelOf(amina, "private"))).toEqual({ docs: 0, folders: 0 })
    await notion(amina, zip)
    const later = await notion(amina, zip, "private", { dryRun: true })
    expect(later.counts["knowledge.document"]).toEqual({ created: 0, skipped: 8, failed: 0 })
    expect(lossesOf(later.report)).toContain("Policies: already imported")
  }, 120_000)

  it("Only me: another member sees nothing, imports the same zip and gets their own", async () => {
    const amina = await person("member")
    const lucas = await person("member")
    const zip = zipFile(exportOf())
    await notion(amina, zip)
    const aLabel = labelOf(amina, "private")
    const aDocs = await Promise.all([A, B, C, D, E, F, G, H].map((h) => docOf(aLabel, h)))
    const aFolders = await Promise.all([A, D, F].map((h) => folderOf(aLabel, h)))
    const aFiles = await filesOf(aDocs[1]!.id)
    const docIds = aDocs.map((d) => d!.id)
    const folderIds = aFolders.map((f) => f!.id)
    const fileIds = aFiles.map((f) => f.id)
    expect(await seenBy(amina, docIds, folderIds, fileIds)).toEqual({
      docs: 8,
      folders: 3,
      files: 2,
    })
    expect(await seenBy(lucas, docIds, folderIds, fileIds)).toEqual({
      docs: 0,
      folders: 0,
      files: 0,
    })

    const run = await notion(lucas, zip)
    expect(run.counts["knowledge.document"]).toEqual({ created: 8, skipped: 0, failed: 0 })
    expect(lossesOf(run.report).filter((l) => l.includes("already imported"))).toEqual([])
    const lLabel = labelOf(lucas, "private")
    const lPolicies = (await docOf(lLabel, C))!
    const lHandbook = (await docOf(lLabel, A))!
    expect(lPolicies.owner_user_id).toBe(lucas.userId)
    expect(lPolicies.body).toContain(`[](knowledge:document:${lHandbook.id})`)
    // Amina's rows are untouched.
    const after = await Promise.all([A, B, C, D, E, F, G, H].map((h) => docOf(aLabel, h)))
    expect(after.map((d) => [d!.body, d!.revision, String(d!.updated_at)])).toEqual(
      aDocs.map((d) => [d!.body, d!.revision, String(d!.updated_at)]),
    )
  }, 180_000)

  it("private then shared by the same person: both sets exist, the shared one for everyone", async () => {
    const amina = await person("member")
    const lucas = await person("member")
    const suffix = tag()
      .replace(/[^0-9a-f]/g, "0")
      .slice(0, 6)
    const zip = zipFile(exportOf(suffix))
    const n = ids(suffix)
    await notion(amina, zip, "private")
    const shared = await notion(amina, zip, "view")
    expect(shared.counts["knowledge.document"]).toEqual({ created: 8, skipped: 0, failed: 0 })
    const priv = (await docOf(labelOf(amina, "private"), n.C))!
    const pub = (await docOf(labelOf(amina, "view"), n.C))!
    expect(priv.id).not.toBe(pub.id)
    expect([priv.org_access, pub.org_access]).toEqual(["none", "viewer"])
    expect((await folderOf(labelOf(amina, "view"), n.A))!.owner_user_id).toBeNull()
    const seen = await seenBy(lucas, [priv.id, pub.id], [], [])
    expect(seen.docs).toBe(1)
  }, 180_000)

  it("shared then shared by another person: nothing created, every item named already imported", async () => {
    const amina = await person("member")
    const lucas = await person("member")
    const suffix = tag()
      .replace(/[^0-9a-f]/g, "1")
      .slice(0, 6)
    const zip = zipFile(exportOf(suffix))
    await notion(amina, zip, "edit")
    const second = await notion(lucas, zip, "edit")
    expect(second.counts["knowledge.document"]).toEqual({ created: 0, skipped: 8, failed: 0 })
    expect(second.counts["knowledge.collection"]!.created).toBe(0)
    const losses = lossesOf(second.report)
    expect(losses.filter((l) => l.endsWith(": already imported")).length).toBeGreaterThanOrEqual(8)
  }, 180_000)

  it("a shared page since closed to a person is named and never linked to in their import", async () => {
    const amina = await person("member")
    const lucas = await person("member")
    const x = `d2${tag().replace(/[^0-9a-f]/g, "5")}${"0".repeat(22)}`.slice(0, 32)
    const y = `d3${tag().replace(/[^0-9a-f]/g, "6")}${"0".repeat(22)}`.slice(0, 32)
    const secret = { name: `Salaries ${x}.md`, data: "# Salaries\n\nNumbers." }
    await notion(amina, zipFile([secret]), "edit")
    const label = labelOf(amina, "edit")
    const closed = (await docOf(label, x))!
    await withPrivilegedDb(orgId, "test-close", (tx) =>
      tx.execute(
        drizzleSql`UPDATE app_knowledge.documents SET org_access = 'none' WHERE id = ${closed.id}::uuid`,
      ),
    )
    const run = await notion(
      lucas,
      zipFile([
        secret,
        { name: `Budget ${y}.md`, data: `# Budget\n\nSee [salaries](Salaries%20${x}.md).` },
      ]),
      "edit",
    )
    expect(run.counts["knowledge.document"]).toEqual({ created: 1, skipped: 1, failed: 0 })
    const losses = lossesOf(run.report)
    expect(losses).toContain("Salaries: already imported, you cannot open it")
    expect(losses).toContain("Budget: link to a page not in the export (salaries)")
    const budget = (await docOf(label, y))!
    expect(budget.body).not.toContain(closed.id)
    expect(budget.body).toContain("See salaries.")
  }, 120_000)

  it("a page in Trash is named; once purged, a new run creates it again", async () => {
    const amina = await person("member")
    const zip = zipFile(exportOf())
    await notion(amina, zip)
    const label = labelOf(amina, "private")
    const policies = (await docOf(label, C))!
    const actor = knowledgeActorFromContext({ ...amina, scopes: ["*"] })
    await withRlsContext({ ...amina, scopes: ["*"] }, (tx) =>
      archiveKnowledgeDocument(tx, policies.id, actor),
    )
    const trashed = await notion(amina, zip)
    expect(trashed.counts["knowledge.document"]!.created).toBe(0)
    expect(lossesOf(trashed.report)).toContain("Policies: in Trash")
    await withPrivilegedDb(orgId, "test-purge", (tx) =>
      tx.execute(drizzleSql`DELETE FROM app_knowledge.documents WHERE id = ${policies.id}::uuid`),
    )
    const again = await notion(amina, zip)
    expect(again.counts["knowledge.document"]).toEqual({ created: 1, skipped: 7, failed: 0 })
    const fresh = (await docOf(label, C))!
    expect(fresh.id).not.toBe(policies.id)
    expect(fresh.body).toContain(`[](knowledge:document:${(await docOf(label, A))!.id})`)
  }, 180_000)

  it("links to pages imported by an earlier run resolve", async () => {
    const amina = await person("member")
    const x = `c2${tag().replace(/[^0-9a-f]/g, "2")}${"0".repeat(22)}`.slice(0, 32)
    const y = `c3${tag().replace(/[^0-9a-f]/g, "3")}${"0".repeat(22)}`.slice(0, 32)
    await notion(amina, zipFile([{ name: `Glossary ${x}.md`, data: "# Glossary\n\nWords." }]))
    const run = await notion(
      amina,
      zipFile([
        { name: `Guide ${y}.md`, data: `# Guide\n\nSee the [glossary](Glossary%20${x}.md).` },
      ]),
    )
    expect(run.counts["knowledge.document"]!.created).toBe(1)
    const label = labelOf(amina, "private")
    expect((await docOf(label, y))!.body).toContain(
      `[](knowledge:document:${(await docOf(label, x))!.id})`,
    )
  }, 120_000)

  it("a file that cannot be copied is named and its page kept with the other files", async () => {
    const amina = await person("member")
    const hex = `ab${tag().replace(/[^0-9a-f]/g, "4")}${"0".repeat(22)}`.slice(0, 32)
    const png = Buffer.from("89504e470d0a1a0a0000000d4948445200000001000000010806000000", "hex")
    const entries: FixtureEntry[] = [
      {
        name: `Album ${hex}.md`,
        data: `# Album\n\n${[1, 2, 3, 4, 5].map((i) => `![p${i}](Album%20${hex}/p${i}.png)`).join("\n\n")}`,
      },
      ...[1, 2, 3, 4, 5].map((i) => ({ name: `Album ${hex}/p${i}.png`, data: png })),
    ]
    let copies = 0
    const { copyObject } = await import("~/infra/storage/object-storage")
    KnowledgeImportTestAccess.setCopyObject(async (args) => {
      copies++
      if (copies === 3) throw new Error("storage did not answer")
      await copyObject(args)
    })
    try {
      const run = await notion(amina, zipFile(entries))
      expect(run.counts["knowledge.document"]).toEqual({ created: 1, skipped: 0, failed: 0 })
      const page = (await docOf(labelOf(amina, "private"), hex))!
      const files = await filesOf(page.id)
      expect(files.length).toBe(4)
      expect(page.body.match(/liaison-file:/g)?.length).toBe(4)
      expect(page.body).toContain("p3")
      expect(
        lossesOf(run.report).some((l) => l.startsWith("Album: file not carried (p3.png)")),
      ).toBe(true)
    } finally {
      KnowledgeImportTestAccess.setCopyObject(null)
    }
  }, 120_000)

  it("an editor opened before the link pass gets a conflict; keeping their text still resolves links", async () => {
    const amina = await person("member")
    const label = labelOf(amina, "private")
    let opened: DocRow | undefined
    await notion(amina, zipFile(exportOf()), "private", {
      afterBatch: async () => {
        opened ??= (await docOf(label, C)) ?? undefined
      },
    })
    expect(opened!.revision).toBe(1)
    expect(opened!.body).toContain("notion-ref:")
    const actor = knowledgeActorFromContext(amina)
    const save = (revision: number) =>
      withRlsContext(amina, (tx) =>
        updateKnowledgeDocument(
          tx,
          { id: opened!.id, revision, body: `${opened!.body}\n\nMine.` },
          actor,
          [],
        ),
      )
    await expect(save(1)).rejects.toThrow(/conflict/i)
    const saved = await save(2)
    expect(saved.body).not.toContain("notion-ref:")
    expect(saved.body).toContain(`[](knowledge:document:${(await docOf(label, A))!.id})`)
    expect(saved.body).toContain("Mine.")
  }, 120_000)

  it("undo of an untouched run leaves no page, folder, file, object, version or link", async () => {
    const amina = await person("admin") // undo reads the live role's scopes
    const run = await notion(amina, zipFile(exportOf()))
    const label = labelOf(amina, "private")
    const onboarding = (await docOf(label, B))!
    const keys = (await filesOf(onboarding.id)).map((f) => f.storage_key)
    const docIds = (await Promise.all([A, B, C, D, E, F, G, H].map((h) => docOf(label, h)))).map(
      (d) => d!.id,
    )
    const report = await undoImportRun(orgId, run.runId, { userId: amina.userId })
    expect(report.refused).toEqual([])
    expect(await countOf(label)).toEqual({ docs: 0, folders: 0 })
    const idList = `{${docIds.join(",")}}`
    const [left] = await sql`
      SELECT (SELECT count(*)::int FROM app_knowledge.document_versions WHERE document_id = ANY(${idList}::uuid[])) AS versions,
             (SELECT count(*)::int FROM app_knowledge.document_links WHERE source_document_id = ANY(${idList}::uuid[]) OR target_document_id = ANY(${idList}::uuid[])) AS links,
             (SELECT count(*)::int FROM kernel.files WHERE entity_id = ANY(${docIds})) AS files`
    expect(left).toEqual({ versions: 0, links: 0, files: 0 })
    for (const key of keys) await expect(getObjectBuffer(key)).rejects.toBeDefined()
  }, 120_000)

  it("undo keeps a page someone edited after the import, with its folder, and lists it", async () => {
    const amina = await person("admin") // undo reads the live role's scopes
    const run = await notion(amina, zipFile(exportOf()))
    const label = labelOf(amina, "private")
    const policies = (await docOf(label, C))!
    const handbook = (await folderOf(label, A))!
    await withRlsContext(amina, (tx) =>
      updateKnowledgeDocument(
        tx,
        { id: policies.id, revision: policies.revision, body: `${policies.body}\n\nEdited.` },
        knowledgeActorFromContext(amina),
        [],
      ),
    )
    const report = await undoImportRun(orgId, run.runId, { userId: amina.userId })
    expect(report.refused).toContainEqual({
      table: "app_knowledge.documents",
      id: policies.id,
      reason: "changed_after_import",
    })
    expect(await countOf(label)).toEqual({ docs: 1, folders: 1 })
    expect((await docOf(label, C))!.body).toContain("Edited.")
    expect(await foldersOfDoc(policies.id)).toEqual([handbook.id])
    expect(await docOf(label, B)).toBeUndefined()
  }, 120_000)
})
