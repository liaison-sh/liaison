// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import type Redis from "ioredis"
import { WebSocketManager } from "~/infra/websocket"

// `hasAccess` is the scope-level gate of every live frame. Trailing-`*` grants
// must follow the same semantics as `hasScope` (permissions.ts): a role holding
// `projects:*` reads every projects resource through RLS, so it must also get
// the live frames for them. Mid-segment wildcards stay denied, as in hasScope.
const manager = new WebSocketManager({} as Redis)
const can = (scopes: string[], app: string, entity: string) =>
  manager.hasAccess(scopes, app, entity)

describe("WebSocketManager.hasAccess wildcard grants", () => {
  it("projects:* delivers task, project_status and task_checklist_item", () => {
    expect(can(["projects:*"], "projects", "task")).toBe(true)
    expect(can(["projects:*"], "projects", "project_status")).toBe(true)
    expect(can(["projects:*"], "projects", "task_checklist_item")).toBe(true)
    expect(can(["projects:*"], "projects", "project")).toBe(true)
    expect(can(["projects:*"], "projects", "label")).toBe(true)
  })

  it("tickets:* delivers ticket, message, sla, inbox and category", () => {
    for (const entity of ["ticket", "message", "sla", "inbox", "category"]) {
      expect(can(["tickets:*"], "tickets", entity)).toBe(true)
    }
  })

  it("a mail provider switch reaches every reader of the mailbox list, nobody else", () => {
    expect(can(["mail:accounts:read"], "mail", "provider")).toBe(true)
    expect(can(["mail:*"], "mail", "provider")).toBe(true)
    expect(can(["mail:conversations:read"], "mail", "provider")).toBe(false)
    expect(can(["kernel:threads:read"], "mail", "provider")).toBe(false)
  })

  it("monitoring:* delivers incident", () => {
    expect(can(["monitoring:*"], "monitoring", "incident")).toBe(true)
  })

  it("kernel:* and kernel:approvals:* deliver approval_request", () => {
    expect(can(["kernel:approvals:*"], "kernel", "approval_request")).toBe(true)
    expect(can(["kernel:*"], "kernel", "approval_request")).toBe(true)
    expect(can(["kernel:approvals:write"], "kernel", "approval_request")).toBe(false)
  })

  it("kernel:* delivers kernel entities like the bare kernel grant", () => {
    expect(can(["kernel:*"], "kernel", "thread")).toBe(true)
    expect(can(["kernel:*"], "kernel", "contact")).toBe(true)
  })

  it("knowledge:* delivers synced_source", () => {
    expect(can(["knowledge:*"], "knowledge", "synced_source")).toBe(true)
    expect(can(["knowledge:documents:*"], "knowledge", "synced_source")).toBe(true)
  })

  it("a wildcard on another app delivers nothing", () => {
    expect(can(["tickets:*"], "projects", "task")).toBe(false)
    expect(can(["monitoring:*"], "tickets", "ticket")).toBe(false)
    expect(can(["projects:*"], "kernel", "approval_request")).toBe(false)
  })

  it("mid-segment wildcards stay denied", () => {
    expect(can(["projects:*:read"], "projects", "task")).toBe(false)
    expect(can(["projects:*:read"], "projects", "project_status")).toBe(false)
    expect(can(["tickets:*:read"], "tickets", "ticket")).toBe(false)
    expect(can(["tickets:*:read"], "tickets", "message")).toBe(false)
    expect(can(["monitoring:*:read"], "monitoring", "incident")).toBe(false)
    expect(can(["kernel:*:read"], "kernel", "approval_request")).toBe(false)
  })
})

describe("WebSocketManager.hasAccess projects task rows follow the project read scope", () => {
  // RLS on app_projects.tasks gates task rows on projects:projects:read, so the
  // live frame does too: a task-only grant reads no task row and gets no frame.
  it("projects:projects:read delivers task and task_checklist_item", () => {
    expect(can(["projects:projects:read"], "projects", "task")).toBe(true)
    expect(can(["projects:projects:read"], "projects", "task_checklist_item")).toBe(true)
    expect(can(["projects:projects"], "projects", "task")).toBe(true)
    expect(can(["projects"], "projects", "task")).toBe(true)
    expect(can(["*"], "projects", "task")).toBe(true)
  })

  it("projects:tasks:read alone does not deliver task or task_checklist_item", () => {
    expect(can(["projects:tasks:read"], "projects", "task")).toBe(false)
    expect(can(["projects:tasks:*"], "projects", "task")).toBe(false)
    expect(can(["projects:task_checklist_items:read"], "projects", "task_checklist_item")).toBe(
      false,
    )
    expect(can(["projects:projects:write"], "projects", "task")).toBe(false)
    expect(can([], "projects", "task")).toBe(false)
  })
})

describe("WebSocketManager.hasAccess kernel node", () => {
  // Scope level only: owner-only delivery is a per-user filter (hasNodeOwnerAccess).
  it("passes the scope gate for any client", () => {
    expect(can([], "kernel", "node")).toBe(true)
    expect(can(["tickets:tickets:read"], "kernel", "node")).toBe(true)
  })
})

describe("WebSocketManager.hasAccess unchanged behaviour", () => {
  it("org-wide, read_state and app-less frames keep their gate", () => {
    expect(can([], "kernel", "presence")).toBe(true)
    expect(can([], "kernel", "read_state")).toBe(true)
    expect(manager.hasAccess(["*"], "")).toBe(false)
  })

  it("explicit grants keep working", () => {
    expect(can(["tickets:tickets:read"], "tickets", "ticket")).toBe(true)
    expect(can(["tickets:tickets:read"], "tickets", "message")).toBe(true)
    expect(can(["tickets:tickets:read"], "tickets", "inbox")).toBe(false)
    expect(can(["monitoring:incidents:read"], "monitoring", "incident")).toBe(true)
    expect(can(["projects:tasks:read"], "projects", "project_status")).toBe(true)
    expect(can(["kernel:threads:read"], "kernel", "message")).toBe(true)
    expect(can(["kernel:threads:read"], "kernel", "contact")).toBe(false)
  })
})

describe("projects label catalog follows the project read scope", () => {
  it("delivers label frames to project readers only", () => {
    expect(can(["projects:projects:read"], "projects", "label")).toBe(true)
    expect(can(["projects:projects"], "projects", "label")).toBe(true)
    expect(can(["projects:tasks:read"], "projects", "label")).toBe(false)
    expect(can(["projects:tasks:*"], "projects", "label")).toBe(false)
    expect(can([], "projects", "label")).toBe(false)
  })
})
