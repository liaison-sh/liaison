// SPDX-License-Identifier: FSL-1.1-ALv2
// The Notion built-in (K7 T7.2) on hand-written fixtures (both export
// generations, every construct of S16) through the real staging path: the
// registry's file rules, the listing, nested zips and the sandbox. One
// assertion per mapping, read from the records the transform emits for the
// knowledge kinds. (Writing them into knowledge is T7.3's, with its own tests.)
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import type { UserContext } from "~/db/rls"
import type { ImportKindDecl } from "~/modules/imports/kind-schema"
import type { ImportKindInfo } from "~/modules/imports/kinds"
import { buildZip, type FixtureEntry } from "~/modules/imports/parsers/__test-helpers__/zip-writer"
import {
  prepareTransform,
  stageTransformSource,
  type TransformSource,
} from "~/modules/imports/transform-run"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"

const A = "a0000000000000000000000000000001" // Harbor Handbook: a page with children
const B = "b0000000000000000000000000000002" // Onboarding: every block construct
const C = "c0000000000000000000000000000003" // Policies
const D = "d0000000000000000000000000000004" // Projects: a database (view + _all)
const E = "e0000000000000000000000000000005" // Launch: a row page
const F = "f0000000000000000000000000000006" // Field Notes: older export, folder without id
const G = "a1000000000000000000000000000007" // Visit: a child in that folder
const H = "b1000000000000000000000000000008" // Inventory: 205 rows

const FIXTURES = join(import.meta.dir, "__fixtures__", "notion")

/** The knowledge record shapes the transform emits (T7.3 accepts them). */
const COLLECTION: ImportKindDecl = {
  schema: {
    type: "object",
    required: ["externalRef", "name"],
    properties: {
      externalRef: { type: "string" },
      name: { type: "string", minLength: 1, maxLength: 240 },
      parentExternalRef: { type: "string" },
      shared: { type: "boolean" },
    },
    additionalProperties: false,
  },
  handler: "importCollections",
  dedupKey: "externalRef",
  tables: [],
  writeScopes: [],
}
const DOCUMENT: ImportKindDecl = {
  schema: {
    type: "object",
    required: ["externalRef", "title", "body"],
    properties: {
      externalRef: { type: "string" },
      title: { type: "string", minLength: 1, maxLength: 240 },
      body: { type: "string", maxLength: 1_000_000 },
      collectionRefs: { type: "array", items: { type: "string" } },
      indexOfCollectionRef: { type: "string" },
      orgAccess: { enum: ["none", "viewer", "editor"] },
      attachments: {
        type: "array",
        items: {
          type: "object",
          required: ["fileId", "ref"],
          properties: { fileId: { type: "string" }, ref: { type: "string" } },
          additionalProperties: false,
        },
      },
      losses: {
        type: "array",
        items: {
          type: "object",
          required: ["what", "where"],
          properties: { what: { type: "string" }, where: { type: "string" } },
          additionalProperties: false,
        },
      },
    },
    additionalProperties: false,
  },
  handler: "importDocuments",
  dedupKey: "externalRef",
  tables: [],
  writeScopes: [],
  files: ["attachments"],
  parent: "collection",
}
const KINDS: ImportKindInfo[] = [
  { kind: "knowledge.collection", app: "knowledge", name: "collection", decl: COLLECTION },
  { kind: "knowledge.document", app: "knowledge", name: "document", decl: DOCUMENT },
]

interface Doc {
  externalRef: string
  title: string
  body: string
  collectionRefs: string[]
  indexOfCollectionRef?: string
  orgAccess: string
  attachments?: Array<{ fileId: string; ref: string }>
  losses?: Array<{ what: string; where: string }>
}
interface Folder {
  externalRef: string
  name: string
  parentExternalRef?: string
  shared: boolean
}

let dir = ""
const orgId = crypto.randomUUID()
const actor: UserContext = {
  actorType: "user",
  userId: crypto.randomUUID(),
  orgId,
  scopes: ["*"],
  dimensionGrants: { "*": ["*"] },
}

/** Every fixture file of one generation, as zip entries at the zip's root. */
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

/** Stage the built-in over a local zip and return what it emitted, by kind. */
async function stage(zip: Uint8Array, params: Record<string, unknown> = {}) {
  const path = join(dir, `${crypto.randomUUID()}.zip`)
  writeFileSync(path, zip)
  const source: TransformSource = {
    type: "transform",
    transform: { builtin: "notion-export", params },
    input: { type: "paths", paths: [path] },
  }
  const prepared = await prepareTransform(
    orgId,
    source,
    KINDS.map((k) => k.kind),
  )
  const rejected: string[] = []
  const staged = await stageTransformSource({
    orgId,
    runId: crypto.randomUUID(),
    actor,
    kinds: KINDS,
    source,
    prepared,
    mode: "cli",
    dryRun: true,
    callbacks: {
      onRejected: (kind, at, message) => {
        rejected.push(`${kind} ${at}: ${message}`)
      },
      onCall: async () => false,
    },
  })
  try {
    const lines = readFileSync(staged.spoolPath, "utf8").trim().split("\n").filter(Boolean)
    const records = lines.map((l) => JSON.parse(l) as { kind: string; record: unknown })
    const folders = records
      .filter((r) => r.kind === "knowledge.collection")
      .map((r) => r.record as Folder)
    const docs = new Map(
      records
        .filter((r) => r.kind === "knowledge.document")
        .map((r) => [(r.record as Doc).externalRef, r.record as Doc]),
    )
    return { folders, docs, rejected, report: staged.report }
  } finally {
    await staged.cleanup()
    rmSync(path, { force: true })
  }
}

const both = () => buildZip([...fixtureEntries("current"), ...fixtureEntries("older"), inventory()])
const lossesOf = (d: Doc | undefined) => (d?.losses ?? []).map((l) => l.what)

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "notion-export-test-"))
})
afterAll(async () => {
  rmSync(dir, { recursive: true, force: true })
  await shutdownTransformPool()
})

describe("notion-export: S16 mapping on the fixtures", () => {
  it("every record fits the knowledge kinds; none is refused", async () => {
    const out = await stage(both())
    expect(out.rejected).toEqual([])
    expect(out.docs.size).toBe(8)
  }, 120_000)

  it("a page with children becomes a folder with a folder page", async () => {
    const { folders, docs } = await stage(both())
    expect(folders.find((f) => f.externalRef === A)?.name).toBe("Harbor Handbook")
    expect(docs.get(A)?.indexOfCollectionRef).toBe(A)
    expect(docs.get(B)?.collectionRefs).toEqual([A])
    expect(docs.get(C)?.indexOfCollectionRef).toBeUndefined()
  }, 120_000)

  it("folders come parents first, children pointing at their parent", async () => {
    const { folders } = await stage(both())
    const order = folders.map((f) => f.externalRef)
    expect(order.indexOf(A)).toBeLessThan(order.indexOf(D))
    expect(folders.find((f) => f.externalRef === D)?.parentExternalRef).toBe(A)
    expect(folders.find((f) => f.externalRef === A)?.parentExternalRef).toBeUndefined()
  }, 120_000)

  it("an older export (folder without the id) maps the same way", async () => {
    const { folders, docs } = await stage(both())
    expect(folders.some((f) => f.externalRef === F)).toBe(true)
    expect(docs.get(G)?.collectionRefs).toEqual([F])
    expect(docs.get(G)?.body).toContain(`[field notes](notion-ref:${F})`)
  }, 120_000)

  it("links between exported pages become page links, by path or notion.so URL", async () => {
    const { docs } = await stage(both())
    expect(docs.get(A)?.body).toContain(`[Onboarding](notion-ref:${B})`)
    expect(docs.get(C)?.body).toContain(`[handbook](notion-ref:${A})`)
    expect(docs.get(B)?.body).toContain(`[projects board](notion-ref:${D})`)
    expect(docs.get(B)?.body).toContain(
      "[Mira at the studio site](https://harborfinch.example.com/team)",
    )
  }, 120_000)

  it("a link to a page not in the export keeps its id for the knowledge import's link pass", async () => {
    // That pass resolves it to a page an earlier import made, or names it (import-kind.ts).
    const { docs } = await stage(both())
    expect(docs.get(B)?.body).toContain(
      "Our [old wiki page](notion-ref:c1000000000000000000000000000009) and",
    )
    expect(lossesOf(docs.get(B)).some((w) => w.includes("old wiki page"))).toBe(false)
  }, 120_000)

  it("images and files of the export become files; a missing one is named", async () => {
    const { docs } = await stage(both())
    const b = docs.get(B)
    expect(b?.body).toContain("![Team photo](import-file:1)")
    expect(b?.body).toContain("[contract template](import-file:2)")
    expect(b?.attachments?.map((a) => a.ref)).toEqual(["1", "2"])
    expect(b?.body).toContain("and a lost scan.")
    expect(lossesOf(b).some((w) => w.startsWith("file missing from the export"))).toBe(true)
    expect(docs.get(E)?.body).toContain("[plan](import-file:1)")
  }, 120_000)

  it("a web image, an embed and an unknown block are named; their text or link stays", async () => {
    const { docs } = await stage(both())
    const b = docs.get(B)
    expect(lossesOf(b)).toContain("web image (https://images.example.com/skyline.png)")
    expect(b?.body).toContain("[Skyline](https://images.example.com/skyline.png)")
    expect(lossesOf(b)).toContain("embed (https://video.example.com/embed/welcome)")
    expect(lossesOf(b)).toContain("unknown block <table>")
    expect(b?.body).toContain("Desk3B")
  }, 120_000)

  it("toggles stay as text under a heading, callouts as callouts, the title line is dropped", async () => {
    const { docs } = await stage(both())
    const b = docs.get(B)?.body ?? ""
    expect(b).toContain("#### First week")
    expect(b).toContain("> [!NOTE]\n> Ask your buddy before you ask the channel.")
    expect(b).not.toContain("💡")
    expect(b).not.toContain("<aside>")
    expect(b.startsWith("# Onboarding")).toBe(false)
  }, 120_000)

  it("a warning icon makes a warning callout; a callout over several lines stays one", async () => {
    const page = "c2000000000000000000000000000019"
    const { docs } = await stage(
      buildZip([
        {
          name: `Ops ${page}.md`,
          data: Buffer.from(
            "# Ops\n\n<aside>\n⚠️ Never restart on a Friday.\nAsk first.\n</aside>\n\nAfter\n",
          ),
        },
      ]),
    )
    const body = docs.get(page)?.body ?? ""
    expect(body).toContain("> [!WARNING]\n> Never restart on a Friday.\n> Ask first.\n\nAfter")
    expect(body).not.toContain("⚠")
  }, 120_000)

  it("a callout's tags go even when nested, and a table cell keeps its backslashes and pipes", async () => {
    const page = "c2000000000000000000000000000009"
    const db = "d2000000000000000000000000000010"
    const { docs } = await stage(
      buildZip([
        {
          name: `Odd ${page}.md`,
          data: Buffer.from("# Odd\n\n<aside><scr<script>ipt>Hi</aside>\n"),
        },
        { name: `Paths ${db}.csv`, data: Buffer.from('Name,Path\nOne,"C:\\a|b"\n') },
      ]),
    )
    const odd = docs.get(page)?.body ?? ""
    expect(odd).not.toContain("<script")
    expect(odd).toContain("> [!NOTE]\n> ipt>Hi")
    expect(docs.get(db)?.body).toContain("| One | C:\\\\a\\|b |")
  }, 120_000)

  it("a database becomes a folder page with a table, its row pages inside, the _all file wins", async () => {
    const { folders, docs } = await stage(both())
    expect(folders.some((f) => f.externalRef === D)).toBe(true)
    const d = docs.get(D)
    expect(d?.indexOfCollectionRef).toBe(D)
    expect(d?.body).toContain("| Name | Status | Owner page |")
    expect(d?.body).toContain(`| [Launch](notion-ref:${E}) | Doing | Policies |`)
    expect(d?.body).toContain("| Pop-up shop | Idea | Policies, Onboarding |")
    expect(docs.get(E)?.collectionRefs).toEqual([D])
  }, 120_000)

  it("relation columns are kept as text and named", async () => {
    const { docs } = await stage(both())
    expect(lossesOf(docs.get(D))).toContain("relation column kept as text (Owner page)")
  }, 120_000)

  it("a row page's properties become a list", async () => {
    const { docs } = await stage(both())
    expect(docs.get(E)?.body).toContain("- **Status:** Doing")
  }, 120_000)

  it("a table holds at most 200 rows; the rest are named", async () => {
    const { docs } = await stage(both())
    const inv = docs.get(H)
    expect(inv?.body.split("\n").filter((l) => l.startsWith("| Item ")).length).toBe(200)
    expect(lossesOf(inv)).toContain("5 rows past the first 200 are not in the table")
  }, 120_000)

  it("who sees the pages: only me by default, everyone when shared", async () => {
    const mine = await stage(both())
    expect(mine.docs.get(A)?.orgAccess).toBe("none")
    expect(mine.folders.every((f) => f.shared === false)).toBe(true)
    const team = await stage(both(), { access: "edit" })
    expect(team.docs.get(A)?.orgAccess).toBe("editor")
    expect(team.folders.every((f) => f.shared === true)).toBe(true)
    const view = await stage(both(), { access: "view" })
    expect(view.docs.get(C)?.orgAccess).toBe("viewer")
  }, 180_000)

  it("a zip of zips gives the same pages as one zip", async () => {
    const one = await stage(both())
    const parts = buildZip([
      { name: "Export-Part-1.zip", data: buildZip(fixtureEntries("current")) },
      { name: "Export-Part-2.zip", data: buildZip([...fixtureEntries("older"), inventory()]) },
    ])
    const split = await stage(parts)
    expect([...split.docs.keys()].sort()).toEqual([...one.docs.keys()].sort())
    expect(split.docs.get(B)?.body).toBe(one.docs.get(B)?.body)
  }, 120_000)

  it("refuses an export of more than 20,000 files, saying why", async () => {
    const entries = Array.from({ length: 20_001 }, (_, i) => ({
      name: `Big ${A}/f${i}.txt`,
      data: "",
      method: 0 as const,
    }))
    const err = await stage(buildZip(entries)).catch((e: unknown) => e)
    expect(String((err as Error).message)).toContain("at most 20000")
  }, 180_000)
})
