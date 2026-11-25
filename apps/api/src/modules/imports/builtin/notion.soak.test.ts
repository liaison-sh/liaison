// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SOAK (skipped unless LIAISON_SOAK=1; a few minutes and about 2 GiB of free
// temporary disk, plus 1 GB in object storage while it runs): the Notion
// built-in at the size S17 names (A2): 1,000 pages and a 1 GB upload, as a
// zip of two zips. 100 top pages with 9 children each (100 folders), each
// page with a 1 MB picture of the export. Every page must come out with its
// picture staged, the run's copies and staged files must be gone afterwards.
//
//   LIAISON_SOAK=1 bun test src/modules/imports/builtin/notion.soak.test.ts
import { afterAll, describe, expect, it } from "bun:test"
import crypto from "node:crypto"
import { closeSync, mkdtempSync, openSync, readFileSync, rmSync, writeSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { UserContext } from "~/db/rls"
import type { ImportKindInfo } from "~/modules/imports/kinds"
import {
  prepareTransform,
  stageTransformSource,
  type TransformSource,
} from "~/modules/imports/transform-run"
import { shutdownTransformPool } from "~/modules/imports/transforms/pool"

const SOAK = process.env.LIAISON_SOAK === "1"
const PICTURE_BYTES = 1_000_000

const ANY = { type: "object" }
const KINDS: ImportKindInfo[] = [
  {
    kind: "knowledge.collection",
    app: "knowledge",
    name: "collection",
    decl: { schema: ANY, handler: "c", dedupKey: "externalRef", tables: [], writeScopes: [] },
  },
  {
    kind: "knowledge.document",
    app: "knowledge",
    name: "document",
    decl: {
      schema: ANY,
      handler: "d",
      dedupKey: "externalRef",
      tables: [],
      writeScopes: [],
      files: ["attachments"],
      parent: "collection",
    },
  },
]

/** A stored-entry zip written straight to disk (entries are streamed, never held). */
class StoredZip {
  private fd: number
  private offset = 0
  private central: Buffer[] = []
  private count = 0
  constructor(path: string) {
    this.fd = openSync(path, "w")
  }
  add(name: string, data: Uint8Array) {
    const n = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(data.byteLength, 18)
    local.writeUInt32LE(data.byteLength, 22)
    local.writeUInt16LE(n.byteLength, 26)
    const cd = Buffer.alloc(46)
    cd.writeUInt32LE(0x02014b50, 0)
    cd.writeUInt16LE(20, 4)
    cd.writeUInt16LE(20, 6)
    cd.writeUInt16LE(0x0800, 8)
    cd.writeUInt32LE(data.byteLength, 20)
    cd.writeUInt32LE(data.byteLength, 24)
    cd.writeUInt16LE(n.byteLength, 28)
    cd.writeUInt32LE(this.offset, 42)
    this.central.push(cd, n)
    this.count++
    for (const b of [local, n, data]) {
      writeSync(this.fd, b)
      this.offset += b.byteLength
    }
  }
  close() {
    const start = this.offset
    let size = 0
    for (const b of this.central) {
      writeSync(this.fd, b)
      size += b.byteLength
    }
    const end = Buffer.alloc(22)
    end.writeUInt32LE(0x06054b50, 0)
    end.writeUInt16LE(this.count, 8)
    end.writeUInt16LE(this.count, 10)
    end.writeUInt32LE(size, 12)
    end.writeUInt32LE(start, 16)
    writeSync(this.fd, end)
    closeSync(this.fd)
  }
}

const hex = (i: number) => i.toString(16).padStart(32, "0")

describe.skipIf(!SOAK)("SOAK: the Notion built-in on 1,000 pages and 1 GB", () => {
  let dir: string | null = null
  afterAll(async () => {
    await shutdownTransformPool()
    if (dir) rmSync(dir, { recursive: true, force: true })
  })

  it("imports every page with its picture, then leaves nothing behind", async () => {
    dir = mkdtempSync(join(tmpdir(), "liaison-soak-notion-"))
    const parts = [join(dir, "part-1.zip"), join(dir, "part-2.zip")]
    const zips = parts.map((p) => new StoredZip(p))
    const picture = crypto.randomBytes(PICTURE_BYTES)
    let page = 0
    for (let top = 0; top < 100; top++) {
      const zip = zips[top % 2]!
      const topId = hex(++page)
      const topTitle = `Area ${top}`
      zip.add(
        `${topTitle} ${topId}.md`,
        Buffer.from(`# ${topTitle}\n\n![p](${encodeURI(`${topTitle} ${topId}`)}/p.png)\n`),
      )
      zip.add(`${topTitle} ${topId}/p.png`, picture)
      for (let c = 0; c < 9; c++) {
        const id = hex(++page)
        const title = `Note ${top}-${c}`
        const folder = `${topTitle} ${topId}`
        zip.add(
          `${folder}/${title} ${id}.md`,
          Buffer.from(
            `# ${title}\n\nBack to [${topTitle}](../${encodeURI(`${topTitle} ${topId}`)}.md).\n\n![p](${encodeURI(`${title} ${id}`)}/p.png)\n`,
          ),
        )
        zip.add(`${folder}/${title} ${id}/p.png`, picture)
      }
    }
    for (const z of zips) z.close()
    const outerPath = join(dir, "export.zip")
    const outer = new StoredZip(outerPath)
    for (const p of parts) outer.add(`Export-${p.endsWith("1.zip") ? 1 : 2}.zip`, readFileSync(p))
    outer.close()
    for (const p of parts) rmSync(p)

    const orgId = crypto.randomUUID()
    const actor: UserContext = {
      actorType: "user",
      userId: crypto.randomUUID(),
      orgId,
      scopes: ["*"],
      dimensionGrants: { "*": ["*"] },
    }
    const source: TransformSource = {
      type: "transform",
      transform: { builtin: "notion-export", params: {} },
      input: { type: "paths", paths: [outerPath] },
    }
    const prepared = await prepareTransform(
      orgId,
      source,
      KINDS.map((k) => k.kind),
    )
    const rejected: string[] = []
    const started = Date.now()
    const staged = await stageTransformSource({
      orgId,
      runId: crypto.randomUUID(),
      actor,
      kinds: KINDS,
      source,
      prepared,
      mode: "cli",
      dryRun: false,
      hooks: { storageQuotaBytesLeft: async () => null },
      callbacks: {
        onRejected: (_k, at, message) => {
          rejected.push(`${at}: ${message}`)
        },
        onCall: async () => false,
      },
    })
    try {
      const lines = readFileSync(staged.spoolPath, "utf8").trim().split("\n")
      const docs = lines
        .map((l) => JSON.parse(l) as { kind: string; record: Record<string, unknown> })
        .filter((r) => r.kind === "knowledge.document")
      expect(rejected).toEqual([])
      expect(docs).toHaveLength(1000)
      const withPicture = docs.filter(
        (d) => Array.isArray(d.record.attachments) && d.record.attachments.length === 1,
      )
      expect(withPicture).toHaveLength(1000)
      expect(staged.report.attachmentsMissing).toBeUndefined()
      console.log(`notion soak: 1,000 pages and 1 GB staged in ${Date.now() - started} ms`)
    } finally {
      await staged.cleanup()
    }
  }, 1_800_000)
})
