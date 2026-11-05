// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The demo reset clears an org with plain SQL, which the search indexer never
// hears about, so each night left one more copy of every seeded result in
// search. Both destructive entry points must clear the org's search documents
// after their DELETEs: the content reset by rebuilding the org from Postgres
// (`reindexOrg`, unit tested in modules/search/reindex.test.ts), the purge by
// the shared org purge's filter delete of every document of the org, which
// also reaches the message, brief and mail documents a rebuild never pruned.
// A source scan, because exercising them needs a demo database
// (demo-reset-ledger.test.ts covers the rows; modules/org/purge/purge-org.test.ts
// the purge's stores).
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { resolve } from "node:path"

const source = readFileSync(resolve(import.meta.dir, "demo-reset.ts"), "utf-8")
const purgeSource = readFileSync(
  resolve(import.meta.dir, "..", "org", "purge", "purge-org.ts"),
  "utf-8",
)

function body(fn: string): string {
  const start = source.indexOf(`export async function ${fn}(`)
  expect(start).toBeGreaterThan(-1)
  const next = source.indexOf("\nexport ", start + 1)
  return source.slice(start, next === -1 ? undefined : next)
}

describe("demo reset keeps the search index in step with its deletes", () => {
  it("resetDemoOrgContent sweeps the org's search documents after deleting its rows", () => {
    const b = body("resetDemoOrgContent")
    const del = b.indexOf("deleteOrgRows(")
    const sweep = b.indexOf("sweepOrgSearchIndex(")
    expect(del).toBeGreaterThan(-1)
    expect(sweep).toBeGreaterThan(del)
  })

  it("purgeDemoOrg runs the shared org purge, which filter-deletes the org's documents after its rows", () => {
    expect(body("purgeDemoOrg")).toContain("purgeOrg(")
    const start = purgeSource.indexOf("export async function purgeOrg(")
    expect(start).toBeGreaterThan(-1)
    const b = purgeSource.slice(start)
    const del = b.indexOf("deleteOrgRows(")
    const search = b.indexOf("deleteOrgSearchDocuments(")
    expect(del).toBeGreaterThan(-1)
    expect(search).toBeGreaterThan(del)
  })

  it("the sweep rebuilds the org from Postgres, which prunes the ghosts", () => {
    expect(source).toMatch(/async function sweepOrgSearchIndex[\s\S]*?reindexOrg\(orgId\)/)
  })
})
