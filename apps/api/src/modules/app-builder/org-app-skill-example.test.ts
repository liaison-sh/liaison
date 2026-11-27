// SPDX-License-Identifier: FSL-1.1-ALv2
// The worked example of .claude/skills/building-an-org-app/SKILL.md builds and
// type-checks with the app builder as it is written there: the skill's fenced
// blocks tagged with a draft file name are the draft, unchanged.
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import { APP_ICON_NAMES } from "@liaison/shared"
import { forbiddenCustomAppDeclaration } from "~/modules/apps/app-org-scope"
import { buildDraft, DRAFT_FILE_NAMES } from "./build/build-draft"

const SKILL = join(import.meta.dir, "../../../../../.claude/skills/building-an-org-app/SKILL.md")
const APP = "visit-log-o1a2b3c4d"

/** The fenced blocks whose info string ends with a draft file name. */
function exampleFiles(markdown: string): Record<string, string> {
  const files: Record<string, string> = {}
  const fence = /^```[a-z]+ ([\w.]+)\n([\s\S]*?)^```$/gm
  for (const m of markdown.matchAll(fence)) {
    const [, name, body] = m
    if (name && body !== undefined && (DRAFT_FILE_NAMES as readonly string[]).includes(name)) {
      files[name] = body
    }
  }
  return files
}

describe("building-an-org-app skill example", () => {
  const files = exampleFiles(readFileSync(SKILL, "utf8"))

  test("carries the manifest, the handlers and the page", () => {
    expect(Object.keys(files).sort()).toEqual(["app.manifest.json", "handlers.ts", "ui.tsx"])
  })

  test("styles its page with the app UI kit, not bare HTML", () => {
    // A page of bare elements renders unstyled in the frame; the example shows the kit.
    expect(files["ui.tsx"]).toMatch(/from "@liaison\/app-ui\/kit"/)
  })

  test("builds and type-checks clean as a custom app", async () => {
    const r = await buildDraft(files, { appName: APP, version: "0.1.0", typecheck: true })
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
    expect(r.typecheck?.errors).toEqual([])
    expect(r.typecheck?.ok).toBe(true)
    expect(r.ui).toBeDefined()
    expect(r.manifest?.name).toBe(APP)
  }, 120_000)

  test("declares nothing an organization's app may not hold, and wires its page", () => {
    const manifest = JSON.parse(files["app.manifest.json"] ?? "{}") as {
      scopes: string[]
      iconName: string
      tools: Record<string, { handler: string; requiredScopes: string[] }>
      store: { collections: Record<string, { readScope: string }> }
      views: { tabTypes: Record<string, { component: string }> }
    }
    expect(forbiddenCustomAppDeclaration(manifest)).toBeNull()
    for (const s of manifest.scopes) expect(s.startsWith(`${APP}:`)).toBe(true)
    for (const tool of Object.values(manifest.tools)) {
      for (const s of tool.requiredScopes) expect(manifest.scopes).toContain(s)
      expect(files["handlers.ts"]).toContain(`export async function ${tool.handler}(`)
    }
    for (const c of Object.values(manifest.store.collections)) {
      expect(manifest.scopes).toContain(c.readScope)
    }
    expect((APP_ICON_NAMES as readonly string[]).includes(manifest.iconName)).toBe(true)
    // A page shows only when a tab's component is a named export of ui.tsx.
    for (const tab of Object.values(manifest.views.tabTypes)) {
      expect(files["ui.tsx"]).toContain(`export function ${tab.component}(`)
    }
  })
})
