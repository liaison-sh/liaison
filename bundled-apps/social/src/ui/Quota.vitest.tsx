// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The quota block rendered: YouTube units as a line and a meter, deferred polls
// as a calm banner, rate limits as readable lines (never raw JSON), Refresh
// re-reading the quota. (Connection rows, labels and Share with organization
// moved to the kernel connections block and are tested there.)
import { cleanup, fireEvent, render, screen } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const answers = new Map<string, unknown>()
const toolCalls: string[] = []

vi.mock("@liaison/host", () => ({
  app: {
    invokeTool: (name: string) => {
      toolCalls.push(name)
      return answers.has(name) ? Promise.resolve(answers.get(name)) : Promise.reject(new Error(`no ${name}`))
    },
    createResource: (fetcher: () => unknown) => createResource(fetcher),
  },
  navigate: () => {},
}))

beforeEach(() => {
  answers.clear()
  toolCalls.length = 0
  answers.set("quota_status", {
    youtube: { day: "2026-10-20", resetsAt: null, cap: 9000, consumed: 1200, remaining: 7800, deferred: 0, exhaustedUntil: null },
    rateLimits: [],
  })
})
afterEach(() => cleanup())

describe("Social quota block", () => {
  it("shows YouTube quota as units today with a meter", async () => {
    answers.set("quota_status", {
      youtube: { day: "2026-10-20", resetsAt: null, cap: 9000, consumed: 1499, remaining: 7501, deferred: 0, exhaustedUntil: null },
      rateLimits: [],
    })
    const { SocialQuota } = await import("./Quota")
    render(() => <SocialQuota />)
    expect((await screen.findByTestId("social-quota-readout")).textContent).toBe("YouTube: 1,499 of 9,000 units today")
    const meter = screen.getByTestId("social-quota-meter")
    expect(meter.getAttribute("role")).toBe("meter")
    expect(meter.getAttribute("aria-valuenow")).toBe("1499")
    expect(meter.getAttribute("aria-valuemax")).toBe("9000")
    expect(screen.queryByTestId("social-quota-banner")).toBeNull()
  })

  it("says how many watch polls wait once the budget is spent", async () => {
    answers.set("quota_status", {
      youtube: { day: "2026-10-20", resetsAt: null, cap: 9000, consumed: 9000, remaining: 0, deferred: 4, exhaustedUntil: "2026-10-21T07:00:00Z" },
      rateLimits: [],
    })
    const { SocialQuota } = await import("./Quota")
    render(() => <SocialQuota />)
    expect((await screen.findByTestId("social-quota-banner")).textContent).toContain("4 watch polls deferred")
    expect(screen.getByTestId("social-quota-deferred").textContent).toBe("4 watch polls deferred")
  })

  it("renders rate limits as readable lines, never raw JSON", async () => {
    answers.set("quota_status", {
      youtube: null,
      rateLimits: [{ platform: "facebook", rateLimit: { rate_limit: { call_count: 42, total_time: 10 } } }],
    })
    const { SocialQuota } = await import("./Quota")
    render(() => <SocialQuota />)
    const line = await screen.findByTestId("social-quota-rate-facebook")
    expect(line.textContent).toContain("call count 42")
    expect(line.textContent).toContain("total time 10")
    expect(line.textContent).not.toMatch(/[{}"]/)
  })

  it("Refresh reloads the quota", async () => {
    const { SocialQuota } = await import("./Quota")
    render(() => <SocialQuota />)
    await screen.findByTestId("social-quota-readout")
    const count = () => toolCalls.filter((c) => c === "quota_status").length
    expect(count()).toBe(1)
    fireEvent.click(screen.getByTestId("social-quota-refresh"))
    await vi.waitFor(() => expect(count()).toBe(2))
  })
})
