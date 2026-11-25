// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SOAK (skipped unless LIAISON_SOAK=1; about a minute): a Notion export of
// 1,000 pages written into Knowledge through the real runner and database (S17,
// A2). 100 top pages with 9 children each (100 folders with their folder
// pages), every child linking to its parent and to the next child, every page
// with a picture. Every page, folder, file and link must be written, no
// `notion-ref:` or `import-file:` left, and undo must remove all of it. (The
// 1 GB upload side is the engine's soak, builtin/notion.soak.test.ts.)
//
//   LIAISON_SOAK=1 bun test src/apps/knowledge/notion-import.soak.test.ts
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { sql } from "~/db"
import type { UserContext } from "~/db/rls"
import { rebuildFilesSelectPolicy } from "~/infra/boot-phase10"
import { ensureAppsForOrg } from "~/modules/apps/init"
import { builtinSourceLabel } from "~/modules/imports/builtin/registry"
import { buildZip, type FixtureEntry } from "~/modules/imports/parsers/__test-helpers__/zip-writer"
import { runImport } from "~/modules/imports/runner"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"
import { undoImportRun } from "~/modules/imports/undo"
import { ensureOrg } from "~/modules/provisioning/ensure-org"
import { ensureUser } from "~/modules/provisioning/ensure-user"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"

const SOAK = process.env.LIAISON_SOAK === "1"
const TOPS = 100
const CHILDREN = 9

const hex = (n: number) => n.toString(16).padStart(32, "0")
const enc = (s: string) => encodeURIComponent(s)

/** The export: top i is `Top i <hex>.md` with a folder of 9 children. */
function exportEntries(): FixtureEntry[] {
  const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex")
  const out: FixtureEntry[] = []
  for (let t = 0; t < TOPS; t++) {
    const top = `Top ${t} ${hex(t * 100 + 1)}`
    out.push({ name: `${top}.md`, data: `# Top ${t}\n\n![cover](${enc(top)}/cover.png)\n` })
    out.push({ name: `${top}/cover.png`, data: png })
    for (let c = 0; c < CHILDREN; c++) {
      const page = `Child ${t}-${c} ${hex(t * 100 + 10 + c)}`
      const next = `Child ${t}-${(c + 1) % CHILDREN} ${hex(t * 100 + 10 + ((c + 1) % CHILDREN))}`
      out.push({
        name: `${top}/${page}.md`,
        data:
          `# Child ${t}-${c}\n\nUp to [top](../${enc(top)}.md), on to [next](${enc(next)}.md).\n\n` +
          `![photo](${enc(page)}/photo.png)\n`,
      })
      out.push({ name: `${top}/${page}/photo.png`, data: png })
    }
  }
  return out
}

let orgId = ""
let dir = ""

beforeAll(async () => {
  if (!SOAK) return
  await acquireTestLock()
  dir = mkdtempSync(join(tmpdir(), "notion-import-soak-"))
  orgId = (
    await ensureOrg({ slug: `notion-soak-${crypto.randomUUID().slice(0, 8)}`, name: "Soak" })
  ).orgId
  await ensureAppsForOrg(orgId)
  await rebuildFilesSelectPolicy()
}, 300_000)

afterAll(async () => {
  if (!SOAK) return
  rmSync(dir, { recursive: true, force: true })
  await shutdownTransformPool()
  await releaseTestLock()
})

describe.skipIf(!SOAK)("Notion import soak: 1,000 pages into Knowledge", () => {
  it("writes every page, folder, file and link, and undo removes all of it", async () => {
    const userId = (
      await ensureUser({
        orgId,
        email: `soak-${crypto.randomUUID().slice(0, 8)}@harborfinch.example`,
        name: "Soak",
        password: "pw-notion-soak-1!",
        role: "admin",
      })
    ).userId
    const actor: UserContext = {
      actorType: "user",
      userId,
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    const zip = join(dir, "export.zip")
    writeFileSync(zip, buildZip(exportEntries()))
    const params = { access: "private" }
    const label = builtinSourceLabel("notion-export", params, userId)
    const started = Date.now()
    const run = await runImport({
      orgId,
      actor,
      kinds: ["knowledge.collection", "knowledge.document"],
      source: {
        type: "transform",
        transform: { builtin: "notion-export", params },
        input: { type: "paths", paths: [zip] },
      },
      sourceLabel: label,
      mode: "cli",
    })
    const seconds = (Date.now() - started) / 1000
    console.log(`soak: 1,000 pages written in ${seconds.toFixed(1)} s`)
    expect(run.status).toBe("done")
    expect(run.errors).toEqual([])
    expect(run.counts["knowledge.document"]).toEqual({ created: 1000, skipped: 0, failed: 0 })
    expect(run.counts["knowledge.collection"]!.created).toBeGreaterThanOrEqual(TOPS)

    const like = `${label}:%`
    const [facts] = await sql`
      SELECT
        (SELECT count(*)::int FROM app_knowledge.documents
          WHERE org_id = ${orgId} AND external_ref LIKE ${like}) AS docs,
        (SELECT count(*)::int FROM app_knowledge.documents
          WHERE org_id = ${orgId} AND external_ref LIKE ${like}
            AND (body LIKE '%notion-ref:%' OR body LIKE '%import-file:%')) AS unresolved,
        (SELECT count(*)::int FROM app_knowledge.collections
          WHERE org_id = ${orgId} AND external_ref LIKE ${like} AND index_document_id IS NOT NULL) AS foldersWithPage,
        (SELECT count(*)::int FROM kernel.files f JOIN app_knowledge.documents d ON d.id::text = f.entity_id
          WHERE d.org_id = ${orgId} AND d.external_ref LIKE ${like}) AS files,
        (SELECT count(*)::int FROM app_knowledge.document_links k JOIN app_knowledge.documents d ON d.id = k.source_document_id
          WHERE d.org_id = ${orgId} AND d.external_ref LIKE ${like}) AS links`
    expect(facts).toEqual({
      docs: 1000,
      unresolved: 0,
      folderswithpage: TOPS,
      files: 1000,
      links: TOPS * CHILDREN * 2,
    })

    const report = await undoImportRun(orgId, run.runId, { userId })
    expect(report.refused).toEqual([])
    const [left] = await sql`
      SELECT (SELECT count(*)::int FROM app_knowledge.documents WHERE org_id = ${orgId}) AS docs,
             (SELECT count(*)::int FROM app_knowledge.collections WHERE org_id = ${orgId} AND external_ref LIKE ${like}) AS folders,
             (SELECT count(*)::int FROM kernel.files WHERE org_id = ${orgId} AND app = 'knowledge') AS files`
    expect(left).toEqual({ docs: 0, folders: 0, files: 0 })
  }, 900_000)
})
