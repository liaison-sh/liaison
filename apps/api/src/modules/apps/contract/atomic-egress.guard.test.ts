// SPDX-License-Identifier: FSL-1.1-ALv2
//
// `atomic` survives only where no egress happens (atomic-egress.ts), and no
// bundled app declares an atomic tool at all. The jobs
// that still call outside inside an atomic run are listed in
// atomic-egress.allowlist.json; the list only shrinks: every row must be in
// the frozen baseline (pinned by its hash), and every row must still name an
// atomic job of a bundled app (a split job removes its row).
import { describe, expect, it } from "bun:test"
import { createHash } from "node:crypto"
import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { RlsClient } from "~/db"
import {
  ATOMIC_LOCAL_METHODS,
  ATOMIC_REFUSED_EGRESS_METHODS,
  type AtomicEgressAllowance,
  type AtomicToolAllowance,
  guardAtomicJobEgress,
  guardAtomicToolEgress,
  isAtomicLocalMethod,
} from "~/modules/apps/atomic-egress"
import { createRpcBridge } from "~/modules/apps/sandbox/rpc-bridge"

const ALLOWLIST_PATH = join(import.meta.dir, "atomic-egress.allowlist.json")
const BASELINE_PATH = join(import.meta.dir, "atomic-egress.baseline.json")
const BASELINE_SHA256 = "4c5714abad56abddba3c2df9d858b9a2d9888461289121a7b4274b12b7b263b4"
const BUNDLED = join(import.meta.dir, "../../../../../../bundled-apps")
const IN_TREE = join(import.meta.dir, "../../../apps")
const TOOLS_ALLOWLIST_PATH = join(import.meta.dir, "atomic-tools.allowlist.json")
const TOOLS_BASELINE_PATH = join(import.meta.dir, "atomic-tools.baseline.json")
const TOOLS_BASELINE_SHA256 = "0f58474e39c447d12f698cd352076d37327a3e96701a2c0d87643be550aa3b30"

const read = (p: string) => JSON.parse(readFileSync(p, "utf8")) as AtomicEgressAllowance[]
const keyOf = (r: AtomicEgressAllowance) => `${r.app}:${r.job}`

describe("atomic jobs that call outside (shrink-only allowlist)", () => {
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

  it("every row is still an atomic job of its app", () => {
    for (const row of read(ALLOWLIST_PATH)) {
      const manifest = JSON.parse(
        readFileSync(join(BUNDLED, row.app, "app.manifest.json"), "utf8"),
      ) as { jobs?: Record<string, { atomic?: boolean }> }
      expect({ row: keyOf(row), atomic: manifest.jobs?.[row.job]?.atomic }).toEqual({
        row: keyOf(row),
        atomic: true,
      })
    }
  })

  // D10: no sandboxed run holds a host transaction across a call outside. A tool that needs
  // several writes to land together uses one `ctx.db.batch` call. No bundled app declares an
  // atomic tool; the in-tree ones still atomic are listed (atomic-tools.allowlist.json), and the
  // list only shrinks.
  const atomicToolsIn = (root: string): string[] => {
    const out: string[] = []
    for (const app of readdirSync(root, { withFileTypes: true })) {
      if (!app.isDirectory()) continue
      let manifest: { name?: string; tools?: Record<string, { atomic?: boolean }> }
      try {
        manifest = JSON.parse(readFileSync(join(root, app.name, "app.manifest.json"), "utf8"))
      } catch {
        continue
      }
      for (const [name, tool] of Object.entries(manifest.tools ?? {})) {
        if (tool.atomic === true) out.push(`${manifest.name ?? app.name}:${name}`)
      }
    }
    return out.sort()
  }
  const toolRows = (p: string) =>
    (JSON.parse(readFileSync(p, "utf8")) as AtomicToolAllowance[]).map((r) => `${r.app}:${r.tool}`)

  it("no bundled app declares an atomic tool", () => {
    expect(atomicToolsIn(BUNDLED)).toEqual([])
  })

  it("the in-tree atomic tools are exactly the listed ones, and the list only shrinks", () => {
    const sha = createHash("sha256").update(readFileSync(TOOLS_BASELINE_PATH)).digest("hex")
    expect(sha).toBe(TOOLS_BASELINE_SHA256)
    const baseline = new Set(toolRows(TOOLS_BASELINE_PATH))
    const listed = toolRows(TOOLS_ALLOWLIST_PATH)
    expect(listed.filter((k) => !baseline.has(k))).toEqual([])
    expect(atomicToolsIn(IN_TREE)).toEqual([...listed].sort())
  })

  it("an atomic tool's egress methods refuse, its local ones are left alone", async () => {
    const original = async () => "called"
    const bridge: Record<string, unknown> = { db_findMany: original, db_batch: original }
    for (const m of ATOMIC_REFUSED_EGRESS_METHODS) bridge[m] = original
    guardAtomicToolEgress(bridge, "pennylane", "refresh-snapshots")
    // A listed in-tree tool keeps its bridge as it is.
    const listed: Record<string, unknown> = { fetch: original }
    guardAtomicToolEgress(listed, "tickets", "convertToMail")
    expect(listed.fetch).toBe(original)
    expect(bridge.db_findMany).toBe(original)
    expect(bridge.db_batch).toBe(original)
    for (const m of ATOMIC_REFUSED_EGRESS_METHODS) {
      const err = await (bridge[m] as () => Promise<unknown>)().catch((e: unknown) => e)
      expect({ m, code: (err as { code?: string }).code }).toEqual({
        m,
        code: "atomic_run_egress_refused",
      })
    }
  })

  it("an unlisted atomic job's egress methods refuse; a listed one's are left alone", async () => {
    const original = async () => "called"
    const unlisted: Record<string, unknown> = { db_findMany: original }
    const listed: Record<string, unknown> = {}
    for (const m of ATOMIC_REFUSED_EGRESS_METHODS) {
      unlisted[m] = original
      listed[m] = original
    }
    guardAtomicJobEgress(unlisted, "monitoring", "assign-refs")
    // Any listed row (the list only shrinks: once it is empty there is nothing left to leave alone).
    const row = read(ALLOWLIST_PATH)[0]
    if (row) guardAtomicJobEgress(listed, row.app, row.job)
    expect(unlisted.db_findMany).toBe(original)
    for (const m of ATOMIC_REFUSED_EGRESS_METHODS) {
      if (row) expect(listed[m]).toBe(original)
      const err = await (unlisted[m] as () => Promise<unknown>)().catch((e: unknown) => e)
      expect((err as { code?: string }).code).toBe("atomic_run_egress_refused")
    }
  })

  it("an atomic job's bridge refuses fetch; a session job's does not wrap it", async () => {
    const tx = {} as RlsClient
    const job = (atomic: boolean) => ({
      currentJob: { name: "assign-refs", payload: {}, timeoutMs: 60_000, atomic },
    })
    const org = "00000000-0000-0000-0000-00000000a7e1"
    const atomic = createRpcBridge(
      "monitoring",
      "system:monitoring",
      org,
      tx,
      { name: "monitoring" },
      undefined,
      "system",
      undefined,
      job(true),
    )
    const err = await atomic.fetch("https://example.test", "{}").catch((e: unknown) => e)
    expect((err as { code?: string }).code).toBe("atomic_run_egress_refused")
    const session = createRpcBridge(
      "monitoring",
      "system:monitoring",
      org,
      tx,
      { name: "monitoring" },
      undefined,
      "system",
      undefined,
      job(false),
    )
    const other = await session.fetch("https://example.test", "{}").catch((e: unknown) => e)
    expect((other as { code?: string }).code).not.toBe("atomic_run_egress_refused")
  })

  // The refusal set is derived from the bridge: every method not reviewed as
  // local is refused, so a remote query (sql_*), a model call
  // (files_analyzeDocument), a nested run (pdf_render) or a method added later
  // cannot hold the run's transaction across its latency.
  const org = "00000000-0000-0000-0000-00000000a7e2"
  const poison = new Proxy(
    {},
    {
      get(_t, prop) {
        if (typeof prop === "symbol" || prop === "then") return undefined
        throw new Error(`poison tx: ${String(prop)}`)
      },
    },
  ) as RlsClient
  const bridgeOf = (atomic: boolean) =>
    createRpcBridge(
      "monitoring",
      "system:monitoring",
      org,
      poison,
      { name: "monitoring" },
      undefined,
      "system",
      undefined,
      { currentJob: { name: "assign-refs", payload: {}, timeoutMs: 60_000, atomic } },
    )

  it("every bridge method that is not local refuses in an atomic job, sql and long calls included", async () => {
    const plain = bridgeOf(false)
    const atomic = bridgeOf(true)
    const methods = Object.keys(atomic).filter((k) => typeof atomic[k] === "function")
    const notRefused: string[] = []
    for (const name of methods) {
      if (isAtomicLocalMethod(name)) {
        expect({
          name,
          same: atomic[name] === plain[name] || String(atomic[name]) === String(plain[name]),
        }).toEqual({ name, same: true })
        continue
      }
      const err = await (atomic[name] as () => Promise<unknown>)().catch((e: unknown) => e)
      if ((err as { code?: string })?.code !== "atomic_run_egress_refused") notRefused.push(name)
    }
    expect(notRefused).toEqual([])
    for (const m of [
      "sql_query",
      "sql_reads",
      "sql_schema",
      "sql_probe",
      "files_analyzeDocument",
      "pdf_render",
    ]) {
      expect({ m, present: methods.includes(m), local: isAtomicLocalMethod(m) }).toEqual({
        m,
        present: true,
        local: false,
      })
    }
  })

  it("the named egress methods all exist on the bridge and none is classed local", () => {
    const methods = new Set(Object.keys(bridgeOf(false)))
    const stale = ATOMIC_REFUSED_EGRESS_METHODS.filter(
      (m) => !methods.has(m) && !m.startsWith("connector_"),
    )
    expect(stale).toEqual([])
    expect(ATOMIC_REFUSED_EGRESS_METHODS.filter(isAtomicLocalMethod)).toEqual([])
    // A local entry that no bridge method carries any more is stale.
    expect([...ATOMIC_LOCAL_METHODS].filter((m) => !methods.has(m))).toEqual([])
  })
})
