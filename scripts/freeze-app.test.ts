// SPDX-License-Identifier: FSL-1.1-ALv2
import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { spawnSync } from "node:child_process"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { freezeApp } from "./freeze-app"

describe("freezeApp", () => {
  let workDir: string
  let appDir: string
  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "freeze-"))
    // monorepo-root-relative, matches the real layout
    appDir = join(workDir, "apps/api/src/apps/example")
    mkdirSync(appDir, { recursive: true })
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
      }),
    )
    writeFileSync(join(appDir, "manifest-descriptor.ts"), "export const exampleAppManifest = {}")
    writeFileSync(
      join(appDir, "handlers.ts"),
      "export const handlers = { ping: async () => ({ ok: true }) }",
    )
  })
  afterEach(() => rmSync(workDir, { recursive: true, force: true }))

  it("produces a gzipped tarball at the expected path", async () => {
    const out = await freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir })
    expect(out.tarballPath).toBe(join(workDir, "example-1.0.0.liaisonapp"))
    expect(existsSync(out.tarballPath)).toBe(true)
  })

  it("includes app.manifest.json and bundle.js as required files", async () => {
    const { tarballPath } = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: workDir,
    })
    const list = spawnSync("tar", ["-tzf", tarballPath]).stdout.toString().split("\n")
    expect(list).toContain("app.manifest.json")
    expect(list).toContain("bundle.js")
  })

  it("packs worker.js beside bundle.js: the same handlers as a Worker module", async () => {
    const { tarballPath } = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: workDir,
    })
    const list = spawnSync("tar", ["-tzf", tarballPath]).stdout.toString().split("\n")
    expect(list).toContain("worker.js")
    const worker = spawnSync("tar", ["-xzOf", tarballPath, "worker.js"]).stdout.toString()
    expect(worker).toContain('from "cloudflare:workers"')
    expect(worker).toContain("ping")
    expect(worker).not.toMatch(/["']node:/)
  })

  it("does NOT write bundle.js or ui.js into the source app dir (no source-tree pollution)", async () => {
    await freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir })
    expect(existsSync(join(appDir, "bundle.js"))).toBe(false)
    expect(existsSync(join(appDir, "ui.js"))).toBe(false)
  })

  it("cleans up the staging dir on success (no /tmp/liaison-freeze-* left behind)", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("liaison-freeze-")).length
    await freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir })
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("liaison-freeze-")).length
    expect(after).toBe(before)
  })

  it("rejects an app dir without a manifest", async () => {
    rmSync(join(appDir, "app.manifest.json"))
    await expect(
      freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir }),
    ).rejects.toThrow(/manifest/i)
  })

  it("rejects a manifest with scopes that don't validate", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["INVALID SCOPE"],
      }),
    )
    await expect(
      freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir }),
    ).rejects.toThrow(/scope/i)
  })

  it("fails freeze when a webhook's verify export is missing from the bundle", async () => {
    // Manifest declares a webhook whose `verify` references an export the bundle does not provide.
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        webhooks: {
          "orders/create": { handler: "ordersCreateHandler", verify: "hmacSha256Verifier" },
        },
      }),
    )
    writeFileSync(
      join(appDir, "handlers.ts"),
      "export const ordersCreateHandler = async () => ({ ok: true })\n",
    )
    await expect(
      freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir }),
    ).rejects.toThrow(/verify export 'hmacSha256Verifier' not found/i)
  })

  it("fails freeze when a webhook's handler export is missing from the bundle", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        webhooks: {
          "orders/create": { handler: "ordersCreateHandler", verify: "hmacSha256Verifier" },
        },
      }),
    )
    writeFileSync(join(appDir, "handlers.ts"), "export const hmacSha256Verifier = () => true\n")
    await expect(
      freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir }),
    ).rejects.toThrow(/handler export 'ordersCreateHandler' not found/i)
  })

  it("freeze succeeds when both webhook handler + verify exports are present", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        webhooks: {
          "orders/create": { handler: "ordersCreateHandler", verify: "hmacSha256Verifier" },
        },
      }),
    )
    writeFileSync(
      join(appDir, "handlers.ts"),
      "export const hmacSha256Verifier = () => true\nexport const ordersCreateHandler = async () => ({ ok: true })\n",
    )
    const out = await freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir })
    expect(existsSync(out.tarballPath)).toBe(true)
  })

  it("accepts an explicit appDir (out-of-tree app, e.g. bundled-apps/shopify)", async () => {
    // Out-of-tree layout: app dir is not under `<repoRoot>/apps/api/src/apps/`.
    const outOfTreeRoot = mkdtempSync(join(tmpdir(), "freeze-oot-"))
    const outOfTreeDir = join(outOfTreeRoot, "bundled-apps/shopify")
    mkdirSync(outOfTreeDir, { recursive: true })
    writeFileSync(
      join(outOfTreeDir, "app.manifest.json"),
      JSON.stringify({
        name: "shopify",
        version: "0.1.0",
        packageFormat: 1,
        license: "FSL-1.1-ALv2",
        scopes: ["shopify:orders:read"],
      }),
    )
    writeFileSync(
      join(outOfTreeDir, "handlers.ts"),
      "export const handlers = { ping: async () => ({ ok: true }) }",
    )
    try {
      const out = await freezeApp({
        appName: "shopify",
        appDir: outOfTreeDir,
        outDir: outOfTreeRoot,
      })
      expect(existsSync(out.tarballPath)).toBe(true)
      expect(out.tarballPath).toBe(join(outOfTreeRoot, "shopify-0.1.0.liaisonapp"))
    } finally {
      rmSync(outOfTreeRoot, { recursive: true, force: true })
    }
  })

  it("emits ui.js from ui.tsx with solid-js externalized and Solid JSX transform applied", async () => {
    writeFileSync(
      join(appDir, "ui.tsx"),
      `import { createSignal } from "solid-js"
       export function SettingsPanel() {
         const [n] = createSignal(0)
         return <div data-testid="ui-fixture-settings">{n()}</div>
       }`,
    )
    const { tarballPath } = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: workDir,
    })
    const extractDir = mkdtempSync(join(tmpdir(), "freeze-extract-"))
    try {
      const tr = spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir])
      expect(tr.status).toBe(0)
      const uiPath = join(extractDir, "ui.js")
      expect(existsSync(uiPath)).toBe(true)
      const ui = readFileSync(uiPath, "utf8")
      // Externalized: bare import, not inlined.
      expect(/from\s+["']solid-js["']/.test(ui)).toBe(true)
      // SettingsPanel is exported.
      expect(
        /export\s*\{[^}]*\bSettingsPanel\b[^}]*\}|export\s+function\s+SettingsPanel\b/.test(ui),
      ).toBe(true)
      // Solid JSX transform markers present — canary against future bundler misconfig.
      expect(/\btemplate\(|\bcreateComponent\(|\binsert\(/.test(ui)).toBe(true)
      // React-style markers absent.
      expect(/\bReact\.createElement\(|\b_jsx\(|\b_jsxs\(/.test(ui)).toBe(false)
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  it("Phase 16.6 — substitutes __LIAISON_APP_NAME__ with the manifest name in emitted ui.js", async () => {
    // esbuild's define: substitutes the ambient `__LIAISON_APP_NAME__`
    // identifier with the manifest's name as a string literal at build time.
    // Plugins consume it via the bundled @liaison/host package; here we
    // reference the identifier directly so the test fixture doesn't need
    // workspace dependency resolution inside its isolated work dir.
    writeFileSync(
      join(appDir, "ui.tsx"),
      `declare const __LIAISON_APP_NAME__: string
       export function SettingsPanel() {
         const name = __LIAISON_APP_NAME__
         return <div data-testid="app-name">{name}</div>
       }`,
    )
    const { tarballPath } = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: workDir,
    })
    const extractDir = mkdtempSync(join(tmpdir(), "freeze-define-extract-"))
    try {
      spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir])
      const ui = readFileSync(join(extractDir, "ui.js"), "utf8")
      // After substitution, the bundle contains the literal app name string.
      expect(ui).toContain('"example"')
      // And does NOT contain the un-substituted identifier — esbuild rewrites
      // every reference to the literal so no runtime token survives.
      expect(/\b__LIAISON_APP_NAME__\b/.test(ui)).toBe(false)
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  it("omits ui.js when ui.tsx is absent", async () => {
    const { tarballPath } = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: workDir,
    })
    const list = spawnSync("tar", ["-tzf", tarballPath]).stdout.toString().split("\n")
    expect(list).not.toContain("ui.js")
  })

  // ──────────────────────────────────────────────────────────────────
  // Sandboxed PDF template DSL — pdf_templates[] bundled as sandbox modules
  // ──────────────────────────────────────────────────────────────────
  // Each template `.ts` exports `renderTemplate(data) => DrawCommand[]`; freeze
  // bundles it (Bun.build, target bun) and appends
  // `globalThis.renderTemplate = renderTemplate` so the kernel can call it in
  // the QuickJS app sandbox. NO pdf-lib import, NO host-closure injection.

  it("emits a sandbox bundle templates/<kind>.js for every declared pdf_template", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        capabilities: ["pdf.render"],
        pdf_templates: [{ kind: "example:invoice_v1", source: "templates/invoice.ts" }],
      }),
    )
    mkdirSync(join(appDir, "templates"), { recursive: true })
    writeFileSync(
      join(appDir, "templates/invoice.ts"),
      `export function renderTemplate(data: { title: string }) {
         return [
           { op: "setMetadata", title: data.title },
           { op: "addPage", width: 595, height: 842 },
         ]
       }`,
    )
    const { tarballPath } = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: workDir,
    })
    const list = spawnSync("tar", ["-tzf", tarballPath]).stdout.toString().split("\n")
    // Colon in filename is reserved on NTFS; freeze sanitises to underscores.
    // The kind itself is preserved in the manifest.
    expect(list).toContain("templates/example__invoice_v1.js")
  })

  it("emitted sandbox bundle sets globalThis.renderTemplate and has no pdf-lib import", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        capabilities: ["pdf.render"],
        pdf_templates: [{ kind: "example:invoice_v1", source: "templates/invoice.ts" }],
      }),
    )
    mkdirSync(join(appDir, "templates"), { recursive: true })
    writeFileSync(
      join(appDir, "templates/invoice.ts"),
      `export function renderTemplate(data: { title: string }) {
         return [
           { op: "embedFont", ref: "f", standardFont: "Helvetica" },
           { op: "addPage", width: 595, height: 842 },
           { op: "drawText", page: 0, text: data.title, x: 40, y: 800, size: 12, font: "f" },
         ]
       }`,
    )
    const { tarballPath } = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: workDir,
    })
    const extractDir = mkdtempSync(join(tmpdir(), "freeze-tpl-extract-"))
    try {
      spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir])
      const js = readFileSync(join(extractDir, "templates/example__invoice_v1.js"), "utf8")
      expect(js).toContain("globalThis.renderTemplate")
      // No pdf-lib in the sandbox bundle — pdf-lib runs host-side in the replayer.
      expect(js).not.toMatch(/from\s*["']pdf-lib["']/)
    } finally {
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  it("binds globalThis.renderTemplate from an ALIASED export (M2 — no undefined-ref)", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        capabilities: ["pdf.render"],
        pdf_templates: [{ kind: "example:invoice_v1", source: "templates/invoice.ts" }],
      }),
    )
    mkdirSync(join(appDir, "templates"), { recursive: true })
    // The local binding is `build`, re-exported AS renderTemplate. Freeze must
    // bind globalThis.renderTemplate to `build` — binding the literal
    // `renderTemplate` would be an undefined-identifier ReferenceError at eval.
    writeFileSync(
      join(appDir, "templates/invoice.ts"),
      `const build = (data: { title: string }) => [
         { op: "addPage", width: 595, height: 842 },
         { op: "embedFont", ref: "f", standardFont: "Helvetica" },
       ]
       export { build as renderTemplate }`,
    )
    const { tarballPath } = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: workDir,
    })
    const extractDir = mkdtempSync(join(tmpdir(), "freeze-tpl-alias-"))
    const g = globalThis as { renderTemplate?: (d: unknown) => unknown }
    try {
      spawnSync("tar", ["-xzf", tarballPath, "-C", extractDir])
      const js = readFileSync(join(extractDir, "templates/example__invoice_v1.js"), "utf8")
      expect(js).toContain("globalThis.renderTemplate")
      // Evaluating the bundle script-mode (as QuickJS does) must define a
      // CALLABLE renderTemplate — not throw on an undefined identifier.
      delete g.renderTemplate
      new Function(js)()
      expect(typeof g.renderTemplate).toBe("function")
      expect(Array.isArray(g.renderTemplate?.({ title: "x" }))).toBe(true)
    } finally {
      delete g.renderTemplate
      rmSync(extractDir, { recursive: true, force: true })
    }
  })

  it("rejects pdf_templates[].kind not namespaced with the app id", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        capabilities: ["pdf.render"],
        pdf_templates: [{ kind: "other-app:invoice_v1", source: "templates/invoice.ts" }],
      }),
    )
    mkdirSync(join(appDir, "templates"), { recursive: true })
    writeFileSync(
      join(appDir, "templates/invoice.ts"),
      `export function renderTemplate() { return [{ op: "addPage", width: 1, height: 1 }] }`,
    )
    await expect(
      freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir }),
    ).rejects.toThrow(/must be namespaced/i)
  })

  it("fails freeze when pdf_templates[].source is missing on disk", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        capabilities: ["pdf.render"],
        pdf_templates: [{ kind: "example:invoice_v1", source: "templates/missing.ts" }],
      }),
    )
    await expect(
      freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir }),
    ).rejects.toThrow(/not found/i)
  })

  it("fails freeze when a template does not export renderTemplate", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        capabilities: ["pdf.render"],
        pdf_templates: [{ kind: "example:invoice_v1", source: "templates/invoice.ts" }],
      }),
    )
    mkdirSync(join(appDir, "templates"), { recursive: true })
    writeFileSync(
      join(appDir, "templates/invoice.ts"),
      `export default function wrong() { return [] }`,
    )
    await expect(
      freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir }),
    ).rejects.toThrow(/must export a 'renderTemplate/i)
  })

  it("refuses to package a manifest claiming trusted: true", async () => {
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        trusted: true,
      }),
    )
    await expect(
      freezeApp({ appName: "example", repoRoot: workDir, outDir: workDir }),
    ).rejects.toThrow(/trusted/i)
  })

  // The catalog reconcile compares an installed app's stored artifact sha256 with the
  // tarball the image bakes. Every image build re-freezes every app, so a tarball that
  // carries build-time metadata (file mtimes, the gzip header time, the builder's
  // umask) changes sha on every build and the reconcile reinstalls every catalog app
  // on every deploy. The same sources must freeze to the same bytes.
  it("freezes the same sources to byte-identical tarballs (reproducible artifact sha256)", async () => {
    mkdirSync(join(appDir, "templates"), { recursive: true })
    writeFileSync(
      join(appDir, "app.manifest.json"),
      JSON.stringify({
        name: "example",
        version: "1.0.0",
        packageFormat: 1,
        license: "MIT",
        scopes: ["example:items:read"],
        capabilities: ["pdf.render"],
        pdf_templates: [{ kind: "example:invoice_v1", source: "templates/invoice.ts" }],
      }),
    )
    writeFileSync(
      join(appDir, "templates/invoice.ts"),
      "export function renderTemplate() { return [] }",
    )
    writeFileSync(join(appDir, "README.md"), "# example\n")
    const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
    const firstOut = join(workDir, "first")
    const secondOut = join(workDir, "second")
    const first = await freezeApp({ appName: "example", repoRoot: workDir, outDir: firstOut })
    // Past a one-second boundary, so every timestamp a build could record differs.
    await new Promise((r) => setTimeout(r, 1100))
    const previousUmask = process.umask(0o077)
    let second: Awaited<ReturnType<typeof freezeApp>>
    try {
      second = await freezeApp({ appName: "example", repoRoot: workDir, outDir: secondOut })
    } finally {
      process.umask(previousUmask)
    }
    expect(sha(second.tarballPath)).toBe(sha(first.tarballPath))
  })

  it("a changed source still freezes to a different tarball", async () => {
    const sha = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex")
    const first = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: join(workDir, "first"),
    })
    writeFileSync(
      join(appDir, "handlers.ts"),
      "export const handlers = { ping: async () => ({ ok: false }) }",
    )
    const second = await freezeApp({
      appName: "example",
      repoRoot: workDir,
      outDir: join(workDir, "second"),
    })
    expect(sha(second.tarballPath)).not.toBe(sha(first.tarballPath))
  })
})
