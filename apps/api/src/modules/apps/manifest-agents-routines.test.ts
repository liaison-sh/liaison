// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, test } from "bun:test"
import { validateAppManifest } from "~/modules/apps/contract"

const base = { name: "social", version: "0.1.0", events: { emits: ["finding:created"] } }

describe("manifest validator — Component-A sections (A8)", () => {
  test("accepts skills.kind + enabledByDefault", () => {
    const r = validateAppManifest({
      ...base,
      skills: {
        "social-overview": {
          description: "guide",
          body: "how to use",
          kind: "guide",
          enabledByDefault: true,
        },
        "triage-social-findings": {
          description: "triage",
          body: "...",
          kind: "playbook",
          enabledByDefault: false,
        },
      },
    })
    expect(r.success).toBe(true)
  })

  test("accepts agents + routines sections", () => {
    const r = validateAppManifest({
      ...base,
      agents: {
        "community-manager": {
          whenToUse: "x",
          systemPrompt: "y",
          scopeCeiling: ["social:findings:read"],
        },
      },
      routines: {
        "triage-event": {
          description: "d",
          kind: "event",
          event: "social:finding:created",
          promptTemplate: "p",
          scopes: ["social:findings:read"],
          enabledByDefault: false,
        },
      },
    })
    expect(r.success).toBe(true)
  })

  test("rejects an event routine whose event the app does not emit", () => {
    const r = validateAppManifest({
      ...base,
      routines: {
        bad: {
          description: "d",
          kind: "event",
          event: "social:dm:received",
          promptTemplate: "p",
          scopes: [],
          enabledByDefault: false,
        },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/routines\.bad\.event.*not declared|does not emit/i)
  })

  test("rejects a recurring routine template missing cron", () => {
    const r = validateAppManifest({
      ...base,
      routines: {
        bad: {
          description: "d",
          kind: "recurring",
          promptTemplate: "p",
          scopes: [],
          enabledByDefault: false,
        },
      },
    })
    expect(r.success).toBe(false)
  })

  test("rejects an event routine for a different app's event namespace", () => {
    const r = validateAppManifest({
      ...base,
      routines: {
        bad: {
          description: "d",
          kind: "event",
          event: "other:finding:created",
          promptTemplate: "p",
          scopes: [],
          enabledByDefault: false,
        },
      },
    })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/must equal manifest name/i)
  })
})
