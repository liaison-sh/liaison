// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P8-FX22 F6. A45 let the knowledge org-scope approval gate be skipped for a connector's own
// webhook ingestion. The skip fired for ANY declared cross-app caller, and nothing but the
// registry's own contents kept it to the one path it was written for: a second app declaring
// knowledge:create tomorrow would have inherited an approval exemption nobody re-read.
//
// So the kernel names the ingestion paths, and this file pins what that name may cover: one
// caller (the calls connector), one target (knowledge:create), declared in that app's own
// operator-approved cross_app_calls, and called from its webhook delivery path alone.

import { describe, expect, it } from "bun:test"
import { readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { CROSS_APP_INGESTIONS, ingestionCallerApp } from "~/modules/apps/cross-app-ingestions"

const REPO = path.resolve(import.meta.dir, "../../../../../..")
const BUNDLED = path.join(REPO, "bundled-apps")
const IN_TREE = path.resolve(import.meta.dir, "../../../apps")

type Declaration = { target?: unknown }

/** Every app that declares `target` in its manifest's cross_app_calls, bundled or in tree. */
function declaringApps(target: string): string[] {
  const out: string[] = []
  for (const [root, dirs] of [
    [BUNDLED, readdirSync(BUNDLED)],
    [IN_TREE, readdirSync(IN_TREE)],
  ] as Array<[string, string[]]>) {
    for (const dir of dirs) {
      const manifestPath = path.join(root, dir, "app.manifest.json")
      try {
        if (!statSync(manifestPath).isFile()) continue
      } catch {
        continue
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
        cross_app_calls?: Declaration[]
      }
      const declared = (manifest.cross_app_calls ?? []).some((c) => c.target === target)
      if (declared) out.push(dir)
    }
  }
  return out.sort()
}

describe("cross-app ingestion: the approval-gate exemption is one declared path", () => {
  it("names exactly the calls connector's knowledge:create", () => {
    expect(CROSS_APP_INGESTIONS).toEqual({ calls: ["knowledge:create"] })
  })

  it("every ingestion pair is declared in that app's own cross_app_calls", () => {
    for (const [app, targets] of Object.entries(CROSS_APP_INGESTIONS)) {
      for (const target of targets) {
        expect([app, target, declaringApps(target).includes(app)]).toEqual([app, target, true])
      }
    }
  })

  it("no other app declares knowledge:create as a cross-app target", () => {
    expect(declaringApps("knowledge:create")).toEqual(["calls"])
  })

  it("answers only for a recognised pair that the caller really declared", () => {
    const call = (callerApp: string | undefined, toolName: string, declared: boolean) =>
      ingestionCallerApp({ callerApp, toolName, declared })
    expect(call("calls", "knowledge:create", true)).toBe("calls")
    // Declared, but not an ingestion path: the everyday cross-app call, still gated.
    expect(call("calls", "knowledge:update", true)).toBe("")
    expect(call("shopify", "knowledge:create", true)).toBe("")
    // A recognised pair the caller never declared, and a direct user or agent call.
    expect(call("calls", "knowledge:create", false)).toBe("")
    expect(call(undefined, "knowledge:create", true)).toBe("")
    expect(call("", "knowledge:create", true)).toBe("")
  })

  it("the knowledge create gate asks for the ingestion, not for any caller app", () => {
    const src = readFileSync(
      path.resolve(import.meta.dir, "../../../apps/knowledge/handlers.ts"),
      "utf8",
    )
    expect(src).toContain("const ingestionCaller = await ingestionCallerOf(ctx)")
    expect(src).toContain("if (!ctx.approval && !ingestionCaller")
    // The old question, which every declared cross-app caller answered.
    expect(src.includes("!callerApp &&")).toBe(false)
  })

  it("the calls connector calls it from its webhook delivery path alone", () => {
    const src = path.join(BUNDLED, "calls", "src")
    const callers = readdirSync(src)
      .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts") && f !== "test-ctx.ts")
      .filter((f) =>
        readFileSync(path.join(src, f), "utf8").includes('executeTool("knowledge:create"'),
      )
      .sort()
    expect(callers).toEqual(["webhooks.ts"])
  })
})
