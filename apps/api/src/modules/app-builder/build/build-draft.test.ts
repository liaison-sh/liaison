// SPDX-License-Identifier: FSL-1.1-ALv2
// buildDraft end to end: the subprocess build of a draft, its outputs, and one
// probe per sandbox escape vector (each must be refused, and no secret byte may
// reach any output).
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { gunzipSync } from "node:zlib"
import {
  BUILD_ADDRESS_SPACE_BYTES,
  BUILD_MEMORY_LIMIT_BYTES,
  BuildDraftTestAccess,
  buildDraft,
  type DraftFiles,
} from "./build-draft"

const APP = "returns-o1a2b3c4d"
const SECRET = "SENTINEL_SECRET_9f8e7d"

const manifest = (extra: Record<string, unknown> = {}) =>
  JSON.stringify(
    {
      name: "whatever",
      version: "9.9.9",
      packageFormat: 1,
      host: "^1",
      license: "MIT",
      description: "Track returns",
      scopes: [`${APP}:returns:read`],
      tools: {
        returns_list: {
          description: "List returns",
          requiredScopes: [`${APP}:returns:read`],
          handler: "returns_list",
          readOnly: true,
          params: { type: "object", properties: {} },
        },
      },
      ...extra,
    },
    null,
    2,
  )

const HANDLERS = `import { type AppContext, defineHandlers } from "@liaison/app-sdk"
export async function returns_list(_p: Record<string, unknown>, ctx: AppContext) {
  return { data: [], org: ctx.orgId }
}
export default defineHandlers({ returns_list })
`

const UI = `import { createSignal } from "solid-js"
export default function Returns() {
  const [n, setN] = createSignal(0)
  return <button data-testid="returns-count" onClick={() => setN(n() + 1)}>{n()}</button>
}
`

const draft = (over: Partial<DraftFiles> = {}): DraftFiles => ({
  "app.manifest.json": manifest(),
  "handlers.ts": HANDLERS,
  ...over,
})

const build = (
  files: Record<string, unknown>,
  extra: Partial<Parameters<typeof buildDraft>[1]> = {},
) => buildDraft(files, { appName: APP, version: "1.0.3", ...extra })

/** Every byte the build returned, as text, to look for leaked secrets. */
function allOutput(r: Awaited<ReturnType<typeof buildDraft>>): string {
  const parts = [JSON.stringify(r.errors), JSON.stringify(r.manifest ?? {})]
  for (const f of [r.bundle, r.ui, r.worker]) if (f) parts.push(new TextDecoder().decode(f.bytes))
  if (r.package) parts.push(gunzipSync(r.package.bytes).toString("latin1"))
  return parts.join("\n")
}

let secretDir: string
let secretJson: string
beforeAll(() => {
  secretDir = mkdtempSync(join(tmpdir(), "draft-probe-secret-"))
  secretJson = join(secretDir, "secret.json")
  writeFileSync(secretJson, JSON.stringify({ key: SECRET }))
  writeFileSync(join(secretDir, ".env"), `JWT_SECRET=${SECRET}\n`)
})
afterAll(() => rmSync(secretDir, { recursive: true, force: true }))

describe("buildDraft: a valid draft", () => {
  test("emits the package, bundle.js, ui.js and worker.js with their shas; name and version forced", async () => {
    const r = await build(draft({ "ui.tsx": UI, "README.md": "# Returns\n" }))
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.manifest?.name).toBe(APP)
    expect(r.manifest?.version).toBe("1.0.3")
    for (const f of [r.package, r.bundle, r.ui, r.worker]) {
      expect(f).toBeDefined()
      expect(f?.sha256).toBe(
        createHash("sha256")
          .update(f?.bytes ?? new Uint8Array())
          .digest("hex"),
      )
    }
    expect(r.sha256).toBe(r.package?.sha256)
    const tar = gunzipSync(r.package?.bytes ?? new Uint8Array()).toString("latin1")
    for (const name of ["app.manifest.json", "bundle.js", "ui.js", "README.md"])
      expect(tar).toContain(name)
    expect(tar).toContain(`"name": "${APP}"`)
    expect(tar).not.toContain('"whatever"')
    const bundle = new TextDecoder().decode(r.bundle?.bytes)
    expect(bundle).toContain("returns_list")
    const worker = new TextDecoder().decode(r.worker?.bytes)
    expect(worker).toContain("cloudflare:workers")
    expect(worker).not.toMatch(/from\s*["']node:/)
    const ui = new TextDecoder().decode(r.ui?.bytes)
    expect(ui).toMatch(/from\s*["']solid-js(\/web)?["']/)
  }, 60_000)

  test("the same draft builds to the same package bytes", async () => {
    const [a, b] = [await build(draft()), await build(draft())]
    expect(a.ok && b.ok).toBe(true)
    expect(a.sha256).toBe(b.sha256 as string)
    expect(a.worker?.sha256).toBe(b.worker?.sha256 as string)
  }, 60_000)

  test("leaves no temp dir behind", async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith("liaison-draft-")).length
    await build(draft())
    const after = readdirSync(tmpdir()).filter((n) => n.startsWith("liaison-draft-")).length
    expect(after).toBeLessThanOrEqual(before)
  }, 30_000)
})

describe("buildDraft: validation errors carry file and line", () => {
  test("a syntax error in handlers.ts names the line", async () => {
    const r = await build(draft({ "handlers.ts": `${HANDLERS}\nexport const broken = (;\n` }))
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.file).toBe("handlers.ts")
    expect(r.errors.some((e) => e.line === 6 || e.line === 7)).toBe(true)
  }, 30_000)

  test("manifest JSON errors and schema errors name app.manifest.json", async () => {
    const bad = await build(draft({ "app.manifest.json": '{\n  "packageFormat": 1,\n  oops\n}' }))
    expect(bad.ok).toBe(false)
    expect(bad.errors[0]).toMatchObject({ file: "app.manifest.json", line: 3 })
    const forbidden = await build(draft({ "app.manifest.json": manifest({ trusted: true }) }))
    expect(forbidden.errors.some((e) => e.file === "app.manifest.json")).toBe(true)
    expect(forbidden.ok).toBe(false)
  })

  test("unknown files, oversize drafts and bad names are refused before any build", async () => {
    expect((await build({ ...draft(), "evil.ts": "x" })).errors[0]?.code).toBe("files")
    const big = await build(draft({ "README.md": "x".repeat(512 * 1024) }))
    expect(big.errors.map((e) => e.code)).toContain("files_too_large")
    const badName = await buildDraft(draft(), { appName: "returns", version: "1.0.0" })
    expect(badName.errors[0]?.code).toBe("app_name")
  })

  test("a webhook whose export is missing fails the build", async () => {
    const r = await build(
      draft({
        "app.manifest.json": manifest({
          webhooks: { order: { handler: "onOrder", verify: "verifyOrder" } },
        }),
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.message).toContain("onOrder")
  }, 30_000)
})

describe("buildDraft: sandbox probes", () => {
  const probes: Array<[string, Partial<DraftFiles>]> = [
    [
      "/proc/1/environ as text",
      {
        "handlers.ts": `import env from "/proc/1/environ" with { type: "text" }\nexport const e = env\n${HANDLERS}`,
      },
    ],
    [
      "/proc/1/environ without attributes",
      { "handlers.ts": `import env from "/proc/1/environ"\nexport const e = env\n${HANDLERS}` },
    ],
    [
      "../../.env",
      { "handlers.ts": `import env from "../../.env"\nexport const e = env\n${HANDLERS}` },
    ],
    [
      "an absolute .json",
      { "handlers.ts": `import s from "${"SECRET_JSON"}"\nexport const e = s\n${HANDLERS}` },
    ],
    [
      "a macro",
      {
        "handlers.ts": `import { returns_list as m } from "./handlers" with { type: "macro" }\nexport const e = m()\n${HANDLERS}`,
      },
    ],
    [
      "a macro, escaped keyword",
      {
        "handlers.ts": `import { readFileSync as m } from "node:fs" \\u0077ith { type: "macro" }\nexport const e = m("/etc/passwd")\n${HANDLERS}`,
      },
    ],
    [
      "a data: URL",
      {
        "handlers.ts": `import x from "data:text/javascript,export default 1"\nexport const e = x\n${HANDLERS}`,
      },
    ],
    [
      "a file: URL",
      { "handlers.ts": `import x from "file:///etc/passwd"\nexport const e = x\n${HANDLERS}` },
    ],
    [
      "a deep relative path",
      {
        "handlers.ts": `import x from "${"../".repeat(30)}etc/passwd"\nexport const e = x\n${HANDLERS}`,
      },
    ],
    [
      "a dynamic import",
      { "handlers.ts": `export const e = () => import("/etc/passwd")\n${HANDLERS}` },
    ],
    [
      "a require",
      {
        "handlers.ts": `export const e = require("node:fs").readFileSync("/etc/passwd")\n${HANDLERS}`,
      },
    ],
    [
      "a node builtin",
      {
        "handlers.ts": `import { readFileSync } from "node:fs"\nexport const e = readFileSync\n${HANDLERS}`,
      },
    ],
    [
      "another package",
      { "handlers.ts": `import { z } from "zod"\nexport const e = z\n${HANDLERS}` },
    ],
    [
      "a triple-slash reference",
      { "handlers.ts": `/// <reference path="/etc/passwd" />\n${HANDLERS}` },
    ],
    [
      "ui: an absolute .json",
      { "ui.tsx": `import s from "SECRET_JSON"\nexport default () => <p>{String(s)}</p>\n` },
    ],
    [
      "ui: import attributes",
      {
        "ui.tsx": `import s from "./handlers" with { type: "text" }\nexport default () => <p>{s}</p>\n`,
      },
    ],
    [
      "ui: ../../.env",
      { "ui.tsx": `import s from "../../.env"\nexport default () => <p>{s}</p>\n` },
    ],
    [
      "ui: a repo file",
      {
        "ui.tsx": `import s from "../../../../../../package.json"\nexport default () => <p>{String(s)}</p>\n`,
      },
    ],
  ]
  for (const [name, over] of probes) {
    test(`refuses ${name}`, async () => {
      const files = draft(
        Object.fromEntries(
          Object.entries(over).map(([k, v]) => [
            k,
            (v as string).replaceAll("SECRET_JSON", secretJson),
          ]),
        ),
      )
      const r = await build(files)
      expect(r.ok).toBe(false)
      expect(r.errors.length).toBeGreaterThan(0)
      expect(
        r.errors.every((e) =>
          ["import_refused", "import_attribute", "syntax"].includes(e.code ?? ""),
        ),
      ).toBe(true)
      expect(
        r.errors.some((e) => e.code === "import_refused" || e.code === "import_attribute"),
      ).toBe(true)
      expect(r.errors.some((e) => typeof e.line === "number")).toBe(true)
      expect(allOutput(r)).not.toContain(SECRET)
      expect(r.package).toBeUndefined()
    }, 30_000)
  }

  test("a 512 KiB file of nested template literals ends within its timeout, refused", async () => {
    const depth = 40_000
    const body = `${"`${".repeat(depth)}1${"}`".repeat(depth)}`
    const filler = Math.max(0, 500 * 1024 - body.length - HANDLERS.length - 40)
    const t0 = Date.now()
    const r = await build(
      draft({ "handlers.ts": `${HANDLERS}\nexport const t = ${body}\n//${"x".repeat(filler)}\n` }),
      {
        timeoutMs: 8_000,
      },
    )
    expect(Date.now() - t0).toBeLessThan(15_000)
    expect(r.ok).toBe(false)
    expect(r.package).toBeUndefined()
  }, 30_000)

  test("an output over the cap is refused", async () => {
    const big = `export const blob = "${"a".repeat(300 * 1024)}"\n`
    const r = await build(draft({ "handlers.ts": `${HANDLERS}${big}` }), {
      outputCapBytes: 256 * 1024,
    })
    expect(r.ok).toBe(false)
    expect(r.errors[0]?.code).toBe("output_cap")
  }, 30_000)
})

describe("the build subprocess limits", () => {
  const scripts = mkdtempSync(join(tmpdir(), "draft-worker-scripts-"))
  afterAll(() => rmSync(scripts, { recursive: true, force: true }))
  const script = (name: string, body: string) => {
    const path = join(scripts, name)
    writeFileSync(path, body)
    return path
  }
  const req = { mode: "build" as const, files: {}, appName: APP, outputCap: 1024 }
  const limits = {
    timeoutMs: 1_500,
    outputCapBytes: 64 * 1024,
    memoryLimitBytes: 1024 * 1024 * 1024,
  }

  test("the address-space ceiling leaves Bun's per-thread reservations room", () => {
    // 1 GiB of address space aborted a small Bun.build on a 4-core Linux host
    // (exit 134), so the ceiling is never the 1 GiB memory limit itself.
    expect(BUILD_ADDRESS_SPACE_BYTES).toBeGreaterThanOrEqual(4 * BUILD_MEMORY_LIMIT_BYTES)
  })

  test("a hung build and the children it started are killed at the timeout", async () => {
    const marker = join(scripts, "grandchild-alive")
    const path = script(
      "hang.ts",
      `Bun.spawn(["sh", "-c", "sleep 3; touch ${marker}"], { stdio: ["ignore", "ignore", "ignore"] })\nsetInterval(() => {}, 1000)\n`,
    )
    const t0 = Date.now()
    const out = await BuildDraftTestAccess.runWorker(req, limits, path)
    expect(Date.now() - t0).toBeLessThan(5_000)
    expect(out.kind === "failed" && out.issue.code).toBe("build_timeout")
    await Bun.sleep(2_500)
    expect(readdirSync(scripts)).not.toContain("grandchild-alive")
  }, 15_000)

  test("stdout + stderr over the cap kills the build", async () => {
    const path = script(
      "spew.ts",
      `const s = "x".repeat(16384)\nfor (let i = 0; i < 1000; i++) { process.stdout.write(s); process.stderr.write(s) }\n`,
    )
    const out = await BuildDraftTestAccess.runWorker(req, limits, path)
    expect(out.kind === "failed" && out.issue.code).toBe("output_cap")
  }, 15_000)

  test("the environment is stripped and the cwd is a fresh empty dir", async () => {
    process.env.DRAFT_PROBE_SECRET = SECRET
    try {
      const path = script(
        "env.ts",
        `import { readdirSync } from "node:fs"\nconsole.log(JSON.stringify({ ok: false, errors: [{ file: JSON.stringify(Object.keys(process.env).sort()), message: JSON.stringify(readdirSync(process.cwd())) }] }))\n`,
      )
      const out = await BuildDraftTestAccess.runWorker(req, limits, path)
      expect(out.kind).toBe("done")
      if (out.kind !== "done") return
      rmSync(out.dir, { recursive: true, force: true })
      const keys = JSON.parse(out.result.errors[0].file) as string[]
      expect(
        keys.filter((k) => !["PATH", "HOME", "TMPDIR", "LANG", "NO_COLOR"].includes(k)),
      ).toEqual([])
      expect(JSON.parse(out.result.errors[0].message)).toEqual([])
    } finally {
      delete process.env.DRAFT_PROBE_SECRET
    }
  }, 15_000)

  test("a build over the memory limit is stopped", async () => {
    const path = script(
      "alloc.ts",
      `const a: Uint8Array[] = []\nfor (let i = 0; i < 200; i++) { a.push(new Uint8Array(16 << 20).fill(1)); await Bun.sleep(20) }\nconsole.log("{}")\n`,
    )
    const out = await BuildDraftTestAccess.runWorker(
      req,
      { ...limits, timeoutMs: 15_000, memoryLimitBytes: 256 * 1024 * 1024 },
      path,
    )
    expect(out.kind).toBe("failed")
    if (out.kind === "failed")
      expect(["memory_limit", "build_crashed"]).toContain(out.issue.code as string)
  }, 30_000)
})

describe("typecheck (apps_build_check)", () => {
  test("reports a wrong ctx call with its line, only in draft files", async () => {
    const handlers = `import type { AppContext } from "@liaison/app-sdk"\nexport async function returns_list(_p: Record<string, unknown>, ctx: AppContext) {\n  return ctx.notAThing()\n}\n`
    const r = await build(draft({ "handlers.ts": handlers }), { typecheck: true })
    expect(r.ok).toBe(true)
    expect(r.typecheck?.ok).toBe(false)
    const e = r.typecheck?.errors[0]
    expect(e).toMatchObject({ file: "handlers.ts", line: 3 })
    expect(e?.message).toContain("notAThing")
  }, 60_000)

  test("a clean draft with a UI typechecks", async () => {
    const r = await build(draft({ "ui.tsx": UI }), { typecheck: true })
    expect(r.typecheck?.errors).toEqual([])
    expect(r.typecheck?.ok).toBe(true)
  }, 60_000)
})
