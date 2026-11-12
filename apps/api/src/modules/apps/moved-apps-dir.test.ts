// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The moved-app declarations (moved-apps.d/<name>.json): the real ones load, and a
// malformed one throws instead of quietly dropping an app's data steps.
import { afterEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MOVED_APPS, readMovedApps } from "~/modules/apps/moved-apps"

const dirs: string[] = []
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

function dirWith(files: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "moved-apps-"))
  dirs.push(dir)
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(dir, name), typeof body === "string" ? body : JSON.stringify(body))
  }
  return dir
}

const WHY = "what moves, and why everything else stays where it is"

describe("moved-app declarations", () => {
  it("loads the repository's, in name order", () => {
    const names = MOVED_APPS.map((a) => a.name)
    expect(names).toEqual([...names].sort())
    expect(names).toContain("database")
    const db = MOVED_APPS.find((a) => a.name === "database")
    expect(db?.steps.map((s) => s.kind)).toEqual(["org-setting-to-store", "synced-sources-to-kind"])
  })

  it("reads both step kinds with their optional fields", () => {
    const dir = dirWith({
      "a.json": {
        name: "a",
        why: WHY,
        steps: [
          {
            id: "s1",
            kind: "org-setting-to-store",
            settingPath: ["a", "b"],
            collection: "settings",
            docId: "d",
          },
          {
            id: "s2",
            kind: "synced-sources-to-kind",
            sourceKind: "folder",
            folderRef: "x",
            configFromColumns: { ref: "folder_ref" },
          },
        ],
      },
      "notes.txt": "ignored",
    })
    expect(readMovedApps(dir)).toEqual([
      {
        name: "a",
        steps: [
          {
            id: "s1",
            kind: "org-setting-to-store",
            settingPath: ["a", "b"],
            collection: "settings",
            docId: "d",
          },
          {
            id: "s2",
            kind: "synced-sources-to-kind",
            sourceKind: "folder",
            folderRef: "x",
            configFromColumns: { ref: "folder_ref" },
          },
        ],
      },
    ])
  })

  it("throws on a file named apart from its app, a missing why, an unknown kind or a repeated id", () => {
    expect(() => readMovedApps(dirWith({ "a.json": { name: "b", why: WHY, steps: [] } }))).toThrow(
      '"name" must be "a"',
    )
    expect(() => readMovedApps(dirWith({ "a.json": { name: "a", steps: [] } }))).toThrow('"why"')
    expect(() =>
      readMovedApps(
        dirWith({ "a.json": { name: "a", why: WHY, steps: [{ id: "x", kind: "rename" }] } }),
      ),
    ).toThrow("unknown step kind")
    const twice = { id: "x", kind: "synced-sources-to-kind", sourceKind: "folder" }
    expect(() =>
      readMovedApps(dirWith({ "a.json": { name: "a", why: WHY, steps: [twice, twice] } })),
    ).toThrow("step ids repeat")
    expect(() =>
      readMovedApps(
        dirWith({
          "a.json": {
            name: "a",
            why: WHY,
            steps: [{ ...twice, configFromColumns: { ref: "owner_id" } }],
          },
        }),
      ),
    ).toThrow("configFromColumns")
  })
})
