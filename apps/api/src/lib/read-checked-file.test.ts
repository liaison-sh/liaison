// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { withOpenFile, withOpenFileSync } from "./read-checked-file"

const root = mkdtempSync(join(tmpdir(), "read-checked-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

describe("withOpenFileSync / withOpenFile", () => {
  it("reads the file its stat describes, even when the path is replaced in between", async () => {
    const file = join(root, "a.txt")
    const swap = join(root, "swap.txt")
    writeFileSync(file, "checked")
    writeFileSync(swap, "replaced and much larger than the file that was checked")
    const sync = withOpenFileSync(file, (st, read) => {
      renameSync(swap, file)
      return { size: st.size, text: read().toString("utf8") }
    })
    expect(sync).toEqual({ size: 7, text: "checked" })

    writeFileSync(swap, "replaced again, also larger")
    const later = await withOpenFile(file, async (st, read) => {
      const size = st.size
      renameSync(swap, file)
      return { size, text: (await read()).toString("utf8") }
    })
    expect(later.text).toBe("replaced and much larger than the file that was checked")
    expect(later.size).toBe(later.text.length)
  })

  it("lets the caller refuse by the descriptor's stat before anything is read", async () => {
    const file = join(root, "big.txt")
    writeFileSync(file, "x".repeat(100))
    expect(() =>
      withOpenFileSync(file, (st) => {
        if (st.size > 10) throw new Error("too large")
      }),
    ).toThrow("too large")
    expect(await withOpenFile(file, (st) => (st.size > 10 ? null : "small"))).toBeNull()
  })

  it("opens a FIFO without waiting for a writer, so its stat can refuse it", async () => {
    if (process.platform === "win32") return
    const fifo = join(root, "fifo")
    if (spawnSync("mkfifo", [fifo]).status !== 0) return
    expect(withOpenFileSync(fifo, (st) => st.isFile())).toBe(false)
    expect(await withOpenFile(fifo, (st) => st.isFile())).toBe(false)
  })

  it("throws the open error for a missing file", () => {
    expect(() => withOpenFileSync(join(root, "missing"), () => 1)).toThrow(/ENOENT/)
  })
})
