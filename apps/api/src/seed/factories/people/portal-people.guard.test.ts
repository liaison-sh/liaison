// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The seed's portal-person factory writes a client onto a portal without the invitation mail.
// Only the seed may do that: a product caller invites through `invitePortalPerson`, which refuses
// on a demo (no mail leaves, so the client could never sign in). This guard holds that no route,
// tool, bridge, job or other product file imports the factory or names its function, so the
// one door past the mail stays inside `src/seed/`.
import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, relative } from "node:path"

const SRC = join(import.meta.dir, "../../..")
const ROOT = join(SRC, "../../..")
const FACTORY = "seed/factories/people/portal-people"

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name.startsWith(".")) continue
    const path = join(dir, name)
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path))
    else if (/\.(ts|tsx)$/.test(name)) out.push(path)
  }
  return out
}

const isTest = (file: string) => /\.test\.tsx?$|\.testutil\.ts$/.test(file)
const withoutComments = (text: string) =>
  text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`])\/\/.*$/gm, "$1")

/** Files outside the seed that import the factory or call its function. */
function reachingOutsideSeed(files: Array<{ file: string; text: string }>): string[] {
  return files
    .filter(({ file }) => !file.startsWith("apps/api/src/seed/") && !isTest(file))
    .filter(({ text }) => {
      const code = withoutComments(text)
      return code.includes(FACTORY) || /\bseedPortalPerson\b/.test(code)
    })
    .map(({ file }) => file)
}

describe("the seed's portal-person factory", () => {
  it("is imported by no route, tool, bridge or other product file outside the seed", () => {
    const files = [
      ...sourceFiles(join(ROOT, "apps/api/src")),
      ...sourceFiles(join(ROOT, "bundled-apps")),
      ...sourceFiles(join(ROOT, "packages")),
    ].map((path) => ({ file: relative(ROOT, path), text: readFileSync(path, "utf8") }))
    expect(files.length).toBeGreaterThan(1000)
    expect(reachingOutsideSeed(files)).toEqual([])
  }, 120_000)

  it("the scan catches an import and a call from product code, and leaves the seed alone", () => {
    expect(
      reachingOutsideSeed([
        {
          file: "apps/api/src/modules/portal/routes.ts",
          text: `import { seedPortalPerson } from "~/${FACTORY}"`,
        },
        {
          file: "apps/api/src/modules/agent/tools/kernel-tools.ts",
          text: "seedPortalPerson(ctx, {})",
        },
        {
          file: "apps/api/src/modules/apps/sandbox/bridge/portal.ts",
          text: `const m = await import("../../../../${FACTORY}")`,
        },
        {
          file: "apps/api/src/seed/worlds/studio/portal.ts",
          text: `import { seedPortalPerson } from "~/${FACTORY}"`,
        },
        {
          file: "apps/api/src/modules/portal/access.ts",
          text: "// seedPortalPerson is the seed's, never called here",
        },
      ]),
    ).toEqual([
      "apps/api/src/modules/portal/routes.ts",
      "apps/api/src/modules/agent/tools/kernel-tools.ts",
      "apps/api/src/modules/apps/sandbox/bridge/portal.ts",
    ])
  })
})
