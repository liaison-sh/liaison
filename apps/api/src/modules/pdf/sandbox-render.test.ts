// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { PDFDocument } from "pdf-lib"
import { createSandboxPool, type SandboxPool } from "~/modules/apps/sandbox/pool"
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

  it("executes a template bundle in the sandbox and replays its commands to a PDF", async () => {
    const bytes = await runTemplateToPdf({ bundleSource: bundle, data: { name: "Acme" }, pool })
    const doc = await PDFDocument.load(bytes)
    expect(doc.getPageCount()).toBe(1)
  })

  it("propagates a render error when the template returns a non-array", async () => {
    const bad = `globalThis.renderTemplate = () => ({ not: "an array" });`
    await expect(runTemplateToPdf({ bundleSource: bad, data: {}, pool })).rejects.toBeDefined()
  })
})
