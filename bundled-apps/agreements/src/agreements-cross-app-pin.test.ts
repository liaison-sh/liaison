// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What agreements may call in other apps. A cross-app hop widens the actor with the target's
// scopes, so every target is pinned here to the list the design names. The client action
// links are never a cross-app call: the app reaches them through its own bridge methods,
// inside a person's decision. Never a read that carries an assignee, time spent or activity.

import { expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const manifest = JSON.parse(
  readFileSync(join(import.meta.dir, "..", "app.manifest.json"), "utf8"),
) as { cross_app_calls?: Array<{ target: string; reason: string }> }

const ALLOWED = new Set([
  "kernel:contacts_read",
  "kernel:companies_read",
  "kernel:contacts_group_add",
  "kernel:contacts_group_remove",
  "kernel:files_merge_pdfs",
  "invoicing:documents_get",
  "invoicing:quote_create_and_issue",
  "invoicing:quote_set_outcome",
  "invoicing:billing_plan_get",
  "invoicing:billing_plan_set",
  "knowledge:create",
  "knowledge:archive",
  "mail:reply",
  "projects:create",
  "projects:createProject",
  "projects:time_plan_set",
])

test("agreements calls only the declared targets, and never the agent's link tools", () => {
  const calls = manifest.cross_app_calls ?? []
  for (const c of calls) {
    expect(ALLOWED.has(c.target)).toBe(true)
    expect(c.reason.length).toBeGreaterThan(20)
  }
  const targets = calls.map((c) => c.target)
  expect(targets).not.toContain("kernel:client_action_create")
  expect(targets).not.toContain("kernel:client_action_revoke")
  expect(targets.filter((t) => t === "projects:get" || t.includes("time_summary"))).toEqual([])
})
