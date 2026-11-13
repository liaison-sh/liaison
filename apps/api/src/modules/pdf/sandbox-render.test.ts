// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { PDFDocument } from "pdf-lib"
import { createSandboxPool, type SandboxPool } from "~/modules/apps/sandbox/pool"
import { onRunSettled, type RunSettledInfo } from "~/modules/apps/workers/run-settled"
import { runTemplateToPdf } from "./sandbox-render"

// A minimal template bundle: sets globalThis.renderTemplate = (data) => DrawCommand[].
// (Built the same way handler bundles are; here we inline a tiny one for the unit test.)
const bundle = `
globalThis.renderTemplate = (data) => ([
  { op: "embedFont", ref: "f", standardFont: "Helvetica" },
  { op: "addPage", width: 595, height: 842 },
  { op: "drawText", page: 0, text: "Hi " + data.name, x: 40, y: 800, size: 12, font: "f" },
]);
`

const owner = { orgId: "00000000-0000-0000-0000-0000000000b1", appName: "invoicing" }

// M2 — getSandboxPool() THROWS if initSandboxPool() never ran. In bare bun:test
// units, construct an explicit pool and pass it (mirrors executor.test.ts:9-10).
describe("runTemplateToPdf", () => {
  let pool: SandboxPool
  beforeAll(async () => {
    pool = await createSandboxPool({ initialSize: 1, maxSize: 1 })
  }, 60_000)
  afterAll(async () => {
    if (pool) await pool.shutdown()
  }, 60_000)

  // A render is always asked for by a running app (ctx.pdf.render), which holds
  // its own process while it waits: the render must be a nested run, so the
  // sandbox service gives it a process kept for nested runs instead of queueing
  // it behind its own caller.
  it("runs as a nested run, under the execution of the app that asked for it", async () => {
    const settled: RunSettledInfo[] = []
    const off = onRunSettled((info) => {
      if (info.entry === "pdf-template:renderTemplate") settled.push(info)
    })
    try {
      await runTemplateToPdf({
        ...owner,
        bundleSource: bundle,
        data: { name: "Acme" },
        pool,
        nestedParentKey: "parent-execution-token",
      })
      await runTemplateToPdf({ ...owner, bundleSource: bundle, data: { name: "Acme" }, pool })
    } finally {
      off()
    }
    expect(settled.map((s) => s.nested)).toEqual([true, true])
  })

  it("executes a template bundle in the sandbox and replays its commands to a PDF", async () => {
    const bytes = await runTemplateToPdf({
      ...owner,
      bundleSource: bundle,
      data: { name: "Acme" },
      pool,
    })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it("propagates a render error when the template returns a non-array", async () => {
    const bad = `globalThis.renderTemplate = () => ({ not: "an array" });`
    await expect(
      runTemplateToPdf({ ...owner, bundleSource: bad, data: {}, pool }),
    ).rejects.toBeDefined()
  })
})
