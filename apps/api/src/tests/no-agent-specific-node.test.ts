// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S20: NO AGENT-SPECIFIC NODE FEATURES (D18; P1-T42, GAP6, A31, A51, K29, K30).
//
// One node system for every agent: the profile templates (default,
// researcher, bug_fixer, custom) are gone from the schema, the shell, the
// sidecar and the editor, and the node never asks GitHub about branch
// protection (D20). Both are pinned by a repo-wide grep.
//
// The discriminator is the spec's own, run with -P (on macOS `git grep -E`
// silently ignores `\b`, GAP6). It may match only:
// - the P1 migration that maps the old templates away, and its test;
// - the unrelated `dealer-researcher` sub-agent role examples (A31):
//   sub-agent-definitions.ts and its test, the sub-agent dispatch prompt and
//   kernel-tools.ts, and the tests that use a `researcher` sub-agent as their
//   example (the sub-agent chat surface, the access-change gates, the approval
//   card's sub-agent crumb, the lively seed's activity plan);
// - this file (A51), whose own text names the pattern.
// The 0127 migration that created the templates is history and is excluded.
import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { resolve } from "node:path"

const REPO_ROOT = resolve(new URL("../../../..", import.meta.url).pathname)

const ALLOWED = new Set([
  "apps/api/src/db/migrations/0140_node_sessions.sql",
  "apps/api/src/db/migrations/0140_node_sessions.test.ts",
  "apps/api/src/modules/agent/subruns/sub-agent-definitions.ts",
  "apps/api/src/modules/agent/subruns/sub-agent-definitions.test.ts",
  "apps/api/src/modules/agent/prompts/kernel/sub-agent-dispatch.md",
  "apps/api/src/modules/agent/tools/kernel-tools.ts",
  "apps/api/src/modules/agent/subruns/spawn-agent-chat-surface.test.ts",
  "apps/api/src/modules/agent/tools/access-change-gates.test.ts",
  "apps/web/src/modules/approvals/ApprovalCard.test.tsx",
  "apps/api/src/seed/tiers/lively/activity-plan.test.ts",
  "apps/api/src/tests/no-agent-specific-node.test.ts",
])

function gitGrep(args: string[]): string[] {
  const r = spawnSync("git", ["grep", "-n", ...args], { cwd: REPO_ROOT, encoding: "utf8" })
  // 1: no match. Anything else but 0 is git failing, never a pass.
  if (r.status === 1) return []
  if (r.status !== 0) throw new Error(`git grep failed (${r.status}): ${r.stderr}`)
  return r.stdout.split("\n").filter(Boolean)
}

describe("S20: one node system for every agent", () => {
  test("no profile template is left outside the migration that maps it away", () => {
    const hits = gitGrep([
      "-P",
      String.raw`\b(bug_fixer|researcher)\b|ProfileTemplate|NODE_PROFILE_TEMPLATES`,
      "--",
      "apps",
      "packages",
      ":!apps/api/src/db/migrations/0127_local_nodes.sql",
    ])
    const outside = hits.filter((line) => !ALLOWED.has(line.slice(0, line.indexOf(":"))))
    expect(outside).toEqual([])
    // The grep itself works: the migration that maps the templates is found.
    expect(hits.some((line) => line.startsWith("apps/api/src/db/migrations/0140_"))).toBe(true)
  })

  test("the node asks GitHub nothing about branch protection (D20, K29)", () => {
    const hits = gitGrep([
      "-E",
      ["recheck_branch", "_protection|GITHUB", "_API|branches/[^ ]*/protection"].join(""),
      "--",
      "apps/desktop",
      "apps/api/src/modules/nodes",
      "packages",
    ])
    expect(hits).toEqual([])
  })
})
