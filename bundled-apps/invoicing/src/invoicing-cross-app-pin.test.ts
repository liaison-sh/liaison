// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What invoicing may call in projects. A cross-app hop widens the actor with the target's scopes,
// so every projects target is pinned here: the billed-lines read, the reconciliation mark, and
// later the milestone status read and the retainer timebox write. Never a read that carries an
// assignee, time spent or activity (no `projects:get`, no per-task time summary).

import { expect, test } from "bun:test"
import { existsSync, readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as {
  cross_app_calls: Array<{ target: string; reason: string }>
}

test("invoicing calls only the declared projects reads and the mark", () => {
  const projects = manifest.cross_app_calls
    .map((c) => c.target)
    .filter((t) => t.startsWith("projects:"))
    .sort()
  expect(projects).toEqual([
    "projects:milestone_status_read",
    "projects:period_timebox_set",
    "projects:reconcile_lines_read",
    "projects:reconcile_mark",
  ])
  for (const c of manifest.cross_app_calls.filter((x) => x.target.startsWith("projects:"))) {
    expect(c.reason.length).toBeGreaterThan(20)
  }
})

test("invoicing's amendment step is a cross-app target of agreements alone, hidden from the model", () => {
  const appsDir = join(import.meta.dir, "..", "..")
  const callers = readdirSync(appsDir)
    .filter((d) => existsSync(join(appsDir, d, "app.manifest.json")))
    .filter((d) => {
      const m = JSON.parse(readFileSync(join(appsDir, d, "app.manifest.json"), "utf8")) as {
        cross_app_calls?: Array<{ target: string }>
      }
      return (m.cross_app_calls ?? []).some((c) => c.target === "invoicing:billing_step_add")
    })
  expect(callers).toEqual(["agreements"])
  const tool = (manifest as unknown as { tools: Record<string, Record<string, unknown>> }).tools
    .billing_step_add
  expect(tool).toMatchObject({ agentVisible: false, trustBoundary: "internal" })
})
