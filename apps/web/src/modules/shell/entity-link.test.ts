// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it, vi } from "vitest"
import { registerTabType, resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { copyLink, ownEntityLink } from "~/modules/shell/entity-link"
import { resetTabStore } from "~/modules/shell/tab-store"
import { toasts } from "~/modules/shell/toast-store"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})

const origin = window.location.origin

function registerEntityTypes() {
  for (const [type, urlPattern, label] of [
    ["projects:project", "/projects/:entityId", "Project"],
    ["projects:task", "/projects/tasks/:entityId", "Task"],
    ["tickets:ticket", "/tickets/:entityId", "Ticket"],
  ] as const) {
    registerTabType(type, {
      component: () => null,
      sidebar: null,
      icon: () => null,
      urlPattern,
      defaultLabel: label,
      referenceable: true,
    })
  }
}

describe("ownEntityLink", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    bootstrapKernelApps()
    registerEntityTypes()
    resetTabStore()
  })

  it("turns an own-origin task address into a task reference", () => {
    expect(ownEntityLink(`${origin}/projects/tasks/t-1`)).toEqual({
      ref: "projects:task:t-1",
      label: "Task",
    })
  })

  it("names the project, ticket and thread references", () => {
    expect(ownEntityLink(`${origin}/projects/p-1`)?.ref).toBe("projects:project:p-1")
    expect(ownEntityLink(`${origin}/tickets/k-1`)?.ref).toBe("tickets:ticket:k-1")
    expect(ownEntityLink(`${origin}/threads/th-1`)?.ref).toBe("thread:th-1")
  })

  it("leaves another origin a plain link", () => {
    expect(ownEntityLink("https://elsewhere.example/projects/tasks/t-1")).toBeNull()
  })

  it("leaves non-entity pages, sub routes, prose and unknown paths alone", () => {
    expect(ownEntityLink(`${origin}/projects`)).toBeNull()
    expect(ownEntityLink(`${origin}/projects/p-1/board`)).toBeNull()
    expect(ownEntityLink(`${origin}/settings`)).toBeNull()
    expect(ownEntityLink(`see ${origin}/projects/tasks/t-1`)).toBeNull()
    expect(ownEntityLink("not a url")).toBeNull()
  })

  it("refuses an address whose id is not an id shape", () => {
    const boss = "0d6f1c2e-6c1a-4c55-9a51-1f0c8c1f2b3a"
    expect(ownEntityLink(`${origin}/projects/tasks/x)@[Boss](user:${boss}`)).toBeNull()
    expect(ownEntityLink(`${origin}/projects/tasks/a%29b`)).toBeNull()
    expect(ownEntityLink(`${origin}/tickets/k[1]`)).toBeNull()
    expect(ownEntityLink(`${origin}/projects/tasks/${boss}`)?.ref).toBe(`projects:task:${boss}`)
  })
})

describe("copyLink", () => {
  it("copies the deployment address of the route and toasts", async () => {
    const writeText = vi.fn(async () => {})
    vi.stubGlobal("navigator", { clipboard: { writeText } })
    expect(await copyLink("/projects/tasks/t-1")).toBe(true)
    expect(writeText).toHaveBeenCalledWith(`${origin}/projects/tasks/t-1`)
    expect(toasts().some((t) => t.message === "Link copied")).toBe(true)
  })
})
