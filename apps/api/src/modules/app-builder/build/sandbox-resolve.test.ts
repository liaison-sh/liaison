// SPDX-License-Identifier: FSL-1.1-ALv2
// The bundler plugins on their own (no pre-scan in front): the second layer must
// refuse every escape vector by itself, and a Bun macro must never run.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { build as esbuild } from "esbuild"
import { solidPlugin } from "esbuild-plugin-solid"
import {
  attributeLikeText,
  bunSandboxPlugin,
  decideDraftImport,
  esbuildSandboxPlugin,
  sandboxPolicy,
  scanDraftSource,
} from "./sandbox-resolve"

const SECRET = "PLUGIN_PROBE_SECRET_51c2"
let root: string
let appDir: string
let secretFile: string
let macroMarker: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sandbox-resolve-"))
  appDir = join(root, "a", "b", "app")
  mkdirSync(appDir, { recursive: true })
  secretFile = join(root, "secret.json")
  writeFileSync(secretFile, JSON.stringify({ k: SECRET }))
  writeFileSync(join(root, "a", ".env"), `X=${SECRET}\n`)
  macroMarker = join(root, "MACRO_RAN")
  writeFileSync(
    join(root, "macro.ts"),
    `import { writeFileSync } from "node:fs"\nexport function boom() { writeFileSync(${JSON.stringify(macroMarker)}, "x"); return 1 }\n`,
  )
})
afterAll(() => rmSync(root, { recursive: true, force: true }))

async function bunBuild(source: string): Promise<{ ok: boolean; text: string }> {
  const entry = join(appDir, "handlers.ts")
  writeFileSync(entry, source)
  const policy = sandboxPolicy({ mode: "handlers", draftDir: appDir, entryPoints: [entry] })
  try {
    const r = await Bun.build({
      entrypoints: [entry],
      target: "bun",
      plugins: [bunSandboxPlugin(policy)],
    })
    const text = r.success ? await r.outputs[0].text() : r.logs.map(String).join("\n")
    return { ok: r.success, text }
  } catch (err) {
    return { ok: false, text: String((err as AggregateError).errors ?? err) }
  }
}

async function uiBuild(source: string): Promise<{ ok: boolean; text: string }> {
  const entry = join(appDir, "ui.tsx")
  writeFileSync(entry, source)
  const policy = sandboxPolicy({ mode: "ui", draftDir: appDir, entryPoints: [entry] })
  try {
    const r = await esbuild({
      entryPoints: [entry],
      bundle: true,
      write: false,
      format: "esm",
      outfile: join(appDir, "ui.js"),
      absWorkingDir: appDir,
      tsconfigRaw: "{}",
      external: ["solid-js", "solid-js/web", "solid-js/store"],
      plugins: [esbuildSandboxPlugin(policy), solidPlugin()],
      logLevel: "silent",
    })
    return { ok: true, text: r.outputFiles[0].text }
  } catch (err) {
    return { ok: false, text: JSON.stringify((err as { errors?: unknown }).errors ?? String(err)) }
  }
}

describe("Bun plugin alone", () => {
  const vectors: Record<string, string> = {
    "/proc/1/environ": `import e from "/proc/1/environ" with { type: "text" }\nexport const x = e\n`,
    "absolute .json": `import e from "SECRET"\nexport const x = e\n`,
    "../../.env": `import e from "../../.env"\nexport const x = e\n`,
    "deep relative": `import e from "${"../".repeat(25)}etc/hosts"\nexport const x = e\n`,
    "data: URL": `import e from "data:text/javascript,export default 1"\nexport const x = e\n`,
    "file: URL": `import e from "file://SECRET"\nexport const x = e\n`,
    "bare package": `import { z } from "zod"\nexport const x = z\n`,
  }
  for (const [name, src] of Object.entries(vectors)) {
    test(`refuses ${name}`, async () => {
      const r = await bunBuild(src.replaceAll("SECRET", secretFile))
      expect(r.ok).toBe(false)
      expect(r.text).not.toContain(SECRET)
    })
  }

  test("a builtin stays a run-time import (Bun skips plugins for builtins; the pre-scan refuses it)", async () => {
    const r = await bunBuild(
      `import { readFileSync } from "node:fs"\nexport const x = readFileSync\n`,
    )
    expect(r.text).toMatch(/from "(node:)?fs"/)
    const policy = sandboxPolicy({ mode: "handlers", draftDir: appDir, entryPoints: [] })
    const issues = scanDraftSource(
      policy,
      "handlers.ts",
      `import { readFileSync } from "node:fs"\n`,
    )
    expect(issues[0]).toMatchObject({ line: 1, code: "import_refused" })
  })

  test("a macro import never runs", async () => {
    const r = await bunBuild(
      `import { boom } from "${join(root, "macro.ts")}" with { type: "macro" }\nexport const v = boom()\n`,
    )
    expect(r.ok).toBe(false)
    expect(existsSync(macroMarker)).toBe(false)
  })

  test("the SDK resolves, with its own imports", async () => {
    const r = await bunBuild(
      `import { defineHandlers } from "@liaison/app-sdk"\nexport default defineHandlers({})\n`,
    )
    expect(r.ok).toBe(true)
  })
})

describe("esbuild plugin alone (UI)", () => {
  test("refuses import attributes, absolute and escaping paths", async () => {
    for (const src of [
      `import s from "./handlers" with { type: "text" }\nexport default () => <p>{s}</p>\n`,
      `import s from "${secretFile}"\nexport default () => <p>{String(s)}</p>\n`,
      `import s from "../../.env"\nexport default () => <p>{s}</p>\n`,
      `import s from "data:application/json,{}"\nexport default () => <p>{String(s)}</p>\n`,
    ]) {
      const r = await uiBuild(src)
      expect(r.ok).toBe(false)
      expect(r.text).not.toContain(SECRET)
    }
  })

  test("Solid, app-ui and the host SDK resolve", async () => {
    const r = await uiBuild(
      `import { createSignal } from "solid-js"\nimport { accessToken } from "@liaison/host"\nexport default () => { const [n] = createSignal(1); void accessToken; return <p>{n()}</p> }\n`,
    )
    expect(r.ok).toBe(true)
    expect(r.text).toMatch(/from "solid-js(\/web)?"/)
  })
})

describe("decisions and the pre-scan", () => {
  test("the attribute pre-scan sees through comments and stays linear on comment runs", () => {
    expect(attributeLikeText('import x from "./a" /* c */ with { type: "json" }')).toEqual({
      line: 1,
    })
    expect(attributeLikeText('import x from "./a" /* a ** b */\n// d\n assert {}')).toEqual({
      line: 1,
    })
    expect(attributeLikeText('const s = "a" /* with */ + "b"')).toBeNull()
    // Many `*//*` after a quote used to backtrack exponentially.
    const started = performance.now()
    expect(attributeLikeText(`"/*${"*//*".repeat(5000)}`)).toBeNull()
    expect(performance.now() - started).toBeLessThan(1000)
  })

  test("a draft may import only the fixed entry points and its own files", () => {
    const policy = sandboxPolicy({ mode: "handlers", draftDir: appDir, entryPoints: [] })
    writeFileSync(join(appDir, "ui.tsx"), "export default 1\n")
    expect(decideDraftImport(policy, "@liaison/app-sdk").kind).toBe("path")
    expect(decideDraftImport(policy, "@liaison/app-sdk/effects").kind).toBe("path")
    expect(decideDraftImport(policy, "@liaison/app-sdk/src/index.ts").kind).toBe("refuse")
    expect(decideDraftImport(policy, "@liaison/app-ui").kind).toBe("refuse")
    expect(decideDraftImport(policy, "solid-js").kind).toBe("refuse")
    expect(decideDraftImport(policy, "./ui").kind).toBe("path")
    expect(decideDraftImport(policy, "./sub/ui").kind).toBe("refuse")
    const ui = sandboxPolicy({ mode: "ui", draftDir: appDir, entryPoints: [] })
    expect(decideDraftImport(ui, "solid-js/web").kind).toBe("external")
    expect(decideDraftImport(ui, "@liaison/app-ui/kit").kind).toBe("path")
  })

  test("the pre-scan names the line of each refused import", () => {
    const policy = sandboxPolicy({ mode: "handlers", draftDir: appDir, entryPoints: [] })
    const issues = scanDraftSource(
      policy,
      "handlers.ts",
      `import { defineHandlers } from "@liaison/app-sdk"\nimport fs from "node:fs"\nexport const f = () => import.meta.require("x")\nconst y = require(name)\n`,
    )
    expect(issues.map((i) => i.line)).toEqual(expect.arrayContaining([2, 3, 4]))
    expect(issues.some((i) => i.line === 1)).toBe(false)
  })

  test("type-only imports are allowed; an attribute on any import is not", () => {
    const policy = sandboxPolicy({ mode: "handlers", draftDir: appDir, entryPoints: [] })
    expect(
      scanDraftSource(
        policy,
        "handlers.ts",
        `import type { Foo } from "zod"\nexport const a = 1\n`,
      ),
    ).toEqual([])
    const attr = scanDraftSource(
      policy,
      "handlers.ts",
      `import x from "@liaison/app-sdk" assert { type: "json" }\nexport const a = x\n`,
    )
    expect(attr.some((i) => i.code === "import_attribute")).toBe(true)
  })
})
