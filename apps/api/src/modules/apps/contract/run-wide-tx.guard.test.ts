// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A sandboxed event handler or webhook delivery holds no transaction across its
// run (run-wide-tx.ts). The handlers that still rely on one are listed in
// run-wide-tx.allowlist.json; the list only shrinks: every row must be in the
// frozen baseline (pinned by its hash), must name a handler its sandboxed app
// still declares (a handler made safe removes its row), and must give a reason.
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { handlerRunHoldsTx, type RunWideTxAllowance } from "~/modules/apps/run-wide-tx"

const ALLOWLIST_PATH = join(import.meta.dir, "run-wide-tx.allowlist.json")
const BASELINE_PATH = join(import.meta.dir, "run-wide-tx.baseline.json")
const BASELINE_SHA256 = "12e97eb80533e6e7e969e3674907d336d1674333630fd9134c27ec3c0b646df0"
const BUNDLED = join(import.meta.dir, "../../../../../../bundled-apps")
const IN_TREE = join(import.meta.dir, "../../../apps")

const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as RunWideTxAllowance[]
const keyOf = (r: RunWideTxAllowance) => `${r.app}:${r.entry}`

interface Manifest {
  trusted?: boolean
  events?: { subscribes?: Record<string, string | { handler?: string }> }
  webhooks?: Record<string, { handler?: string }>
}

function manifestOf(app: string): Manifest {
  const bundled = join(BUNDLED, app, "app.manifest.json")
  const path = existsSync(bundled) ? bundled : join(IN_TREE, app, "app.manifest.json")
  return JSON.parse(readFileSync(path, "utf8")) as Manifest
}

/** The entries a manifest declares: `event:<export>` and `webhook:<export>`. */
function entriesOf(m: Manifest): Set<string> {
  const out = new Set<string>()
  for (const v of Object.values(m.events?.subscribes ?? {})) {
    const h = typeof v === "string" ? v : v.handler
    if (h) out.add(`event:${h}`)
  }
  for (const w of Object.values(m.webhooks ?? {})) if (w.handler) out.add(`webhook:${w.handler}`)
  return out
}

describe("handlers that hold a transaction for their whole run (shrink-only allowlist)", () => {
  it("baseline is the frozen one", () => {
    const sha = createHash("sha256").update(readFileSync(BASELINE_PATH)).digest("hex")
    expect(sha).toBe(BASELINE_SHA256)
  })

  it("holds no row the baseline does not (the list may only shrink)", () => {
    const baseline = new Set(read(BASELINE_PATH).map(keyOf))
    expect(
      read(ALLOWLIST_PATH)
        .map(keyOf)
        .filter((k) => !baseline.has(k)),
    ).toEqual([])
  })

  it("every row names a handler its sandboxed app still declares, with a reason", () => {
    for (const row of read(ALLOWLIST_PATH)) {
      const m = manifestOf(row.app)
      expect({
        row: keyOf(row),
        sandboxed: m.trusted !== true,
        declared: entriesOf(m).has(row.entry),
      }).toEqual({ row: keyOf(row), sandboxed: true, declared: true })
      expect(row.reason.length).toBeGreaterThan(20)
    }
  })

  it("a listed handler holds the transaction, an unlisted sandboxed one does not, a core one does", () => {
    // Any listed row (the list only shrinks: once it is empty no sandboxed handler holds one).
    const [row] = read(ALLOWLIST_PATH)
    if (row)
      expect(handlerRunHoldsTx({ trusted: false, app: row.app, entry: row.entry })).toBe(true)
    expect(
      handlerRunHoldsTx({
        trusted: false,
        app: "invoicing",
        entry: "event:onShopifyProductChanged",
      }),
    ).toBe(false)
    expect(handlerRunHoldsTx({ trusted: true, app: "tickets", entry: "webhook:anything" })).toBe(
      true,
    )
  })
})
