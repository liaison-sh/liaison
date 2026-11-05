// SPDX-License-Identifier: FSL-1.1-ALv2
// The kernel's own guides that are not the kernel overview (kernel-config,
// kernel-admin, kernel-notifications) are registered under keys that are not
// app names, so discovering one of their tools never mapped to them: the agent
// configuring an org through kernel__config_* only ever saw the guide's one-line
// summary, which promised the full guide "loads automatically once you discover
// one of its tools". Each guide now names its tools, and the first of them a
// turn loads brings the guide in full, as the agent loop's guide note; the
// system prompt keeps the summary line whatever the thread loaded.
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { guideCoversLoaded } from "~/modules/agent/context/app-guide"
import { agentInstructionsRegistry, toolRegistry } from "~/modules/apps/app-registries"
import { bootstrapAdminThread } from "~/tests/helpers/agent-ctx"
import { acquireTestLock, releaseTestLock } from "~/tests/route-test-setup"
import {
  assembleContext,
  coveringGuideKeys,
  resetSystemPromptCache,
  systemPartsToText,
} from "./context"

beforeAll(acquireTestLock)
afterAll(releaseTestLock)

const GUIDES = [
  {
    key: "kernel-config",
    tool: "kernel__config_mail",
    body: "Read before you change: call `kernel__config_export` first",
  },
  { key: "kernel-admin", tool: "kernel__roles_list", body: "Silent-filter contract" },
  {
    key: "kernel-notifications",
    tool: "kernel__notifications_set",
    body: "Map the request to the smallest change",
  },
]

describe("kernel guides follow their tools", () => {
  beforeEach(() => resetSystemPromptCache())

  test("an ordinary turn carries each kernel guide as its summary line only", async () => {
    const { orgId, actor, threadId } = await bootstrapAdminThread()
    const text = systemPartsToText(
      (await assembleContext({ threadId, orgId, actor, discoveredTools: new Set() })).system,
    )
    for (const g of GUIDES) {
      expect(text).toContain(`- **${g.key}**:`)
      expect(text).not.toContain(`### ${g.key}\n`)
      expect(text).not.toContain(g.body)
    }
  })

  test("a discovered tool leaves the system prompt as it was: its guide is the agent loop's note", async () => {
    const { orgId, actor, threadId } = await bootstrapAdminThread()
    const base = systemPartsToText(
      (await assembleContext({ threadId, orgId, actor, discoveredTools: new Set() })).system,
    )
    for (const g of GUIDES) {
      resetSystemPromptCache()
      const assembled = await assembleContext({
        threadId,
        orgId,
        actor,
        discoveredTools: new Set([g.tool]),
      })
      // The system prompt does not depend on what the thread loaded (guide-notes.ts).
      expect(systemPartsToText(assembled.system)).toBe(base)
      expect(assembled.systemGuideParts.has(g.key)).toBe(false)
      // The agent loop's note carries the guide the discovered tool names.
      expect(coveringGuideKeys(orgId, [g.tool])).toEqual([g.key])
    }
  })

  test("every tool a kernel guide names is a registered kernel tool", async () => {
    const { orgId } = await bootstrapAdminThread()
    const kernelTools = [...toolRegistry.entries()]
      .filter(([k]) => k[0] === orgId && k[1] === "kernel")
      .map(([k]) => `kernel__${k[2]}`)
    for (const g of GUIDES) {
      const raw = agentInstructionsRegistry.get([orgId, g.key])
      const covered = typeof raw === "string" ? undefined : raw?.coveredTools
      expect(covered?.length ?? 0).toBeGreaterThan(0)
      for (const pattern of covered ?? []) {
        const matches = kernelTools.filter((n) =>
          guideCoversLoaded({ core: "", coveredTools: [pattern] }, [n]),
        )
        expect({ pattern, matches: matches.length > 0 }).toEqual({ pattern, matches: true })
      }
    }
    // The overview stays the always-on kernel guide, never tool-gated.
    expect(typeof agentInstructionsRegistry.get([orgId, "kernel"])).toBe("string")
  })
})
