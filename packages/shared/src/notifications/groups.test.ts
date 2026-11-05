// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  ATTENTION_KINDS,
  DEFAULT_GRID,
  effectiveGrid,
  gridOverrides,
  groupForChatMessage,
  groupForKind,
  isUrgentFor,
  MONITORING_INCIDENT_KINDS,
  NODE_SESSION_NOTICE_KINDS,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_GROUP_IDS,
  NOTIFICATION_GROUP_SECTIONS,
  NOTIFICATION_GROUPS,
  type NotificationGroupId,
} from "@liaison/shared"

describe("notification groups", () => {
  it("maps every kind of every family to exactly one group", () => {
    // KIND_TO_GROUP has no compile-time exhaustiveness: this is the check. It also
    // fails when two groups list the same kind.
    const kinds = [
      ...ATTENTION_KINDS,
      ...NODE_SESSION_NOTICE_KINDS,
      ...MONITORING_INCIDENT_KINDS,
      "knowledge_review",
      "new_email",
    ]
    for (const kind of kinds) {
      const owners = NOTIFICATION_GROUPS.filter((g) =>
        (g.kinds as readonly string[]).includes(kind),
      )
      expect({ kind, owners: owners.map((g) => g.id) }).toEqual({
        kind,
        owners: [groupForKind(kind)],
      })
    }
  })

  it("lists the groups of the spec table in order, each with a label key", () => {
    const ordered: NotificationGroupId[] = [
      "direct",
      "replies",
      "approvals",
      "decisions",
      "work",
      "mail",
      "agent",
      "session_needs_you",
      "session_done",
      "session_failed",
      "monitoring",
      "system",
    ]
    expect(NOTIFICATION_GROUPS.map((g) => g.id)).toEqual(ordered)
    // effectiveGrid and the settings API iterate this list: keep it aligned.
    expect([...NOTIFICATION_GROUP_IDS]).toEqual(ordered)
    for (const g of NOTIFICATION_GROUPS) expect(g.labelKey).toBe(`notifications.groups.${g.id}`)
  })

  it("places the kinds the spec table names", () => {
    const expected: Record<string, NotificationGroupId> = {
      mention: "direct",
      dm_window_closing: "direct",
      thread_reply: "replies",
      file_shared: "replies",
      approval_pending: "approvals",
      // A decision on your own request is news, not an ask (etiquette rule 9).
      approval_decision: "decisions",
      scope_request: "approvals",
      scope_request_decided: "decisions",
      admin_action: "approvals",
      sla_risk: "work",
      awaiting_agent: "work",
      unassigned: "work",
      nudge_due: "work",
      followup_due: "work",
      task_overdue: "work",
      task_due_this_week: "work",
      task_blocked: "work",
      knowledge_review: "work",
      new_email: "mail",
      agent_notification: "agent",
      system_alert: "system",
    }
    for (const [kind, group] of Object.entries(expected)) expect(groupForKind(kind)).toBe(group)
  })

  it("sends an app-namespaced kind, or any unknown kind, to work", () => {
    expect(groupForKind("shopify:order.created")).toBe("work")
    expect(groupForKind("invoicing:overdue")).toBe("work")
    expect(groupForKind("something_new")).toBe("work")
  })

  it("owns the monitoring incident kinds, outside any section", () => {
    expect(groupForKind("monitoring:incident.critical")).toBe("monitoring")
    expect(groupForKind("monitoring:incident.warning")).toBe("monitoring")
    expect([...MONITORING_INCIDENT_KINDS]).toEqual([
      "monitoring:incident.critical",
      "monitoring:incident.warning",
    ])
    expect(NOTIFICATION_GROUPS.find((g) => g.id === "monitoring")).toEqual({
      id: "monitoring",
      labelKey: "notifications.groups.monitoring",
      label: "Monitoring incidents",
      kinds: [...MONITORING_INCIDENT_KINDS],
    })
    expect(NOTIFICATION_GROUP_SECTIONS.flatMap((s) => [...s.groups])).not.toContain("monitoring")
  })

  it("keeps any other monitoring-namespaced kind in work (explicit list, no prefix match)", () => {
    expect(groupForKind("monitoring:incident.info")).toBe("work")
  })

  it("has the four channels, in_app first", () => {
    expect([...NOTIFICATION_CHANNELS]).toEqual(["in_app", "desktop", "push", "email"])
  })

  it("defaults equal the spec's default grid", () => {
    const row = (inApp: boolean, desktop: boolean, push: boolean, email: boolean) => ({
      in_app: inApp,
      desktop,
      push,
      email,
    })
    expect(DEFAULT_GRID).toEqual({
      direct: row(true, true, true, true),
      // Interrupt only for a direct ask (etiquette rule 2): a channel post is
      // inbox news unless the member opts the channel into every post.
      replies: row(true, false, false, true),
      approvals: row(true, true, true, true),
      // Rule 9: decisions and new email go to the inbox quietly.
      decisions: row(true, false, false, true),
      work: row(true, false, false, true),
      mail: row(true, false, false, false),
      agent: row(true, true, true, true),
      session_needs_you: row(true, true, true, false),
      session_done: row(true, true, true, false),
      session_failed: row(true, true, true, false),
      // Incident pushes at any hour for criticals; no email.
      monitoring: row(true, true, true, false),
      system: row(true, false, false, true),
    })
  })

  it("S11: three session groups exist with phone and computer on, email off", () => {
    const sessions = [
      ["session_needs_you", "node_session_needs_you", "Computer session needs you"],
      ["session_done", "node_session_done", "Computer session done"],
      ["session_failed", "node_session_failed", "Computer session failed"],
    ] as const
    for (const [id, kind, label] of sessions) {
      expect((NOTIFICATION_GROUP_IDS as readonly string[]).includes(id)).toBe(true)
      const group = NOTIFICATION_GROUPS.find((g) => g.id === id)
      expect(group).toEqual({ id, labelKey: `notifications.groups.${id}`, label, kinds: [kind] })
      expect(groupForKind(kind)).toBe(id as NotificationGroupId)
      const cells = (DEFAULT_GRID as Record<string, Record<string, boolean>>)[id]
      expect(cells).toEqual({ in_app: true, desktop: true, push: true, email: false })
    }
    // Settings shows them under one "Computer sessions" heading.
    expect(NOTIFICATION_GROUP_SECTIONS).toEqual([
      {
        id: "sessions",
        label: "Computer sessions",
        labelKey: "notifications.sections.sessions",
        groups: ["session_needs_you", "session_done", "session_failed"],
      },
    ])
    // A stored override switches one session cell like any other group's.
    const grid = effectiveGrid({ session_done: { push: false } })
    expect((grid as Record<string, Record<string, boolean>>).session_done?.push).toBe(false)
    expect(gridOverrides(grid)).toEqual({ session_done: { push: false } } as never)
  })
})

describe("notification group labels", () => {
  // The EN and FR parity checks pass when a key is missing in both locales, so
  // this pins the keys a group needs: the settings grid label and the label of the
  // notice an agent change produces.
  type KernelLabels = {
    notifications: { groups: Record<string, string> }
    agentNotificationChange: { groups: Record<string, string> }
  }
  const readKernel = (locale: string) =>
    JSON.parse(
      readFileSync(join(import.meta.dir, "..", "i18n", "locales", locale, "kernel.json"), "utf8"),
    ) as KernelLabels
  const en = readKernel("en")
  const fr = readKernel("fr")

  it("has the EN settings label of every group, equal to its English label", () => {
    for (const g of NOTIFICATION_GROUPS) {
      expect({ id: g.id, label: en.notifications.groups[g.id] }).toEqual({
        id: g.id,
        label: g.label,
      })
    }
  })

  it("has a non-empty agent change notice label for every group, in both locales", () => {
    for (const kernel of [en, fr]) {
      for (const g of NOTIFICATION_GROUPS) {
        expect(kernel.agentNotificationChange.groups[g.id], g.id).toBeTruthy()
      }
    }
  })

  it("has a non-empty FR settings label for every group, monitoring pinned", () => {
    for (const g of NOTIFICATION_GROUPS) expect(fr.notifications.groups[g.id], g.id).toBeTruthy()
    expect(fr.notifications.groups.monitoring).toBe("Incidents de supervision")
    expect(fr.agentNotificationChange.groups.monitoring).toBe("Incidents de supervision")
  })
})

describe("isUrgentFor", () => {
  it("is true for a stored urgent item", () => {
    expect(isUrgentFor({ kind: "sla_risk", isUrgent: true }, "u1")).toBe(true)
  })

  it("is false for a non-urgent item", () => {
    expect(isUrgentFor({ kind: "sla_risk", isUrgent: false }, "u1")).toBe(false)
  })

  it("is true for an approval pending on the user", () => {
    expect(
      isUrgentFor({ kind: "approval_pending", isUrgent: false, approverIds: ["u0", "u1"] }, "u1"),
    ).toBe(true)
  })

  it("is false for an approval pending on someone else", () => {
    expect(
      isUrgentFor({ kind: "approval_pending", isUrgent: false, approverIds: ["u0"] }, "u1"),
    ).toBe(false)
    expect(isUrgentFor({ kind: "approval_pending", isUrgent: false }, "u1")).toBe(false)
  })

  it("does not treat approvers on another kind as urgent", () => {
    expect(
      isUrgentFor({ kind: "approval_decision", isUrgent: false, approverIds: ["u1"] }, "u1"),
    ).toBe(false)
  })
})

describe("grid storage helpers", () => {
  it("reads NULL as the defaults", () => {
    expect(effectiveGrid(null)).toEqual(DEFAULT_GRID)
  })

  it("merges stored cells and ignores unknown groups, channels, non-booleans and in_app", () => {
    const grid = effectiveGrid({
      work: { push: true, bogus: true },
      nope: { push: true },
      direct: { in_app: false, email: "yes" },
    })
    expect(grid.work.push).toBe(true)
    expect(grid.direct.in_app).toBe(true)
    expect(grid.direct.email).toBe(true)
    expect(Object.keys(grid)).not.toContain("nope")
  })

  it("stores only the cells that differ from the defaults", () => {
    const grid = effectiveGrid({ work: { push: true }, direct: { push: true } })
    expect(gridOverrides(grid)).toEqual({ work: { push: true } })
    expect(gridOverrides(effectiveGrid(null))).toEqual({})
  })

  it("needs no migration: a stored grid without monitoring gets the default row", () => {
    const stored = { work: { push: true }, direct: { email: false } }
    const grid = effectiveGrid(stored)
    expect(grid.work.push).toBe(true)
    expect(grid.direct.email).toBe(false)
    expect(grid.monitoring).toEqual(DEFAULT_GRID.monitoring)
    expect(gridOverrides(grid)).toEqual(stored)
  })

  it("puts a chat message in direct when the room is direct or the user is mentioned", () => {
    expect(groupForChatMessage({ direct: true, mentioned: false })).toBe("direct")
    expect(groupForChatMessage({ direct: false, mentioned: true })).toBe("direct")
    expect(groupForChatMessage({ direct: false, mentioned: false })).toBe("replies")
  })
})
