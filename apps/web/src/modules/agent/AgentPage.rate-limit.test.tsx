// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * A refused listing and a THROTTLED listing are different facts. The page used
 * to treat every failure alike and tell the reader the agent is not available,
 * which is wrong and unactionable when the only thing that happened is that
 * they asked too often: the agent is there, the answer is to ask again.
 */
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import AgentPage from "~/modules/agent/AgentPage"
import { resetAgentMemoryStore } from "~/modules/agent/agent-memory-store"
import { ApiContext } from "~/modules/shell/ApiContext"
import { resetTabStore } from "~/modules/shell/tab-store"
import { resetToastStore } from "~/modules/shell/toast-store"

const AGENT = "11111111-1111-4111-8111-111111111111"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => false,
  hasAppsAdmin: () => false,
  userFromToken: () => ({
    userId: "33333333-3333-4333-8333-333333333333",
    orgId: "org",
    scopes: [],
    roles: [],
    dimensionGrants: {},
    exp: 0,
    name: "Me",
  }),
}))

/**
 * BOTH reads are throttled `throttledCalls` times, then answer normally.
 *
 * The page asks the listing AND, when the route carries an id, the page read:
 * a throttle only reaches the reader when neither could answer, because an
 * answered page read is the agent, whatever the listing is doing.
 */
function setup(throttledCalls: number) {
  let listingCalls = 0
  let pageCalls = 0
  const api: any = {
    get: vi.fn(async (path: string) => {
      if (path === "/agents") {
        listingCalls++
        if (listingCalls <= throttledCalls) {
          throw new ApiError("Too many requests", 429, "RATE_LIMITED", 30)
        }
        return [{ id: AGENT, handle: "@logistics", displayName: "Logistics", kind: "role" }]
      }
      if (/^\/agents\/[^/]+$/.test(path)) {
        pageCalls++
        if (pageCalls <= throttledCalls) {
          throw new ApiError("Too many requests", 429, "RATE_LIMITED", 30)
        }
        return {
          data: {
            id: AGENT,
            handle: "@logistics",
            displayName: "Logistics",
            kind: "role",
            ownerUserId: null,
            purpose: "Keeps the shipping queue moving.",
            avatarUrl: "https://example.test/a.png",
            lastActivityAt: null,
            channels: [{ id: "c-1", handle: "@shipping", name: "Shipping" }],
            counts: { skills: 0, routines: 0, memoryFiles: 0, knowledgePointers: 0 },
            capabilityCategories: [],
            runsOn: "liaison",
          },
        }
      }
      return null
    }),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentPage entityId={AGENT} />
    </ApiContext.Provider>
  ))
  return api
}

describe("AgentPage when the listing is rate limited", () => {
  beforeEach(() => {
    resetAgentMemoryStore()
    resetToastStore()
    try {
      resetTabStore()
    } catch {
      /* test isolation */
    }
  })
  afterEach(() => cleanup())

  it("says the request was throttled instead of claiming the agent does not exist", async () => {
    setup(1)
    const name = await screen.findByTestId("agent-profile-name")
    await waitFor(() => expect(name.textContent).not.toBe(""))
    expect(name.textContent).not.toContain("This agent is not available.")
    expect(name.textContent).toContain("Too many requests")
    expect(screen.getByTestId("agent-page-retry")).toBeInTheDocument()
  })

  it("the retry control re-reads BOTH the listing and the page read", async () => {
    const api = setup(1)
    const retry = await screen.findByTestId("agent-page-retry")
    fireEvent.click(retry)
    await waitFor(() =>
      expect(screen.getByTestId("agent-profile-name").textContent).toBe("Logistics"),
    )
    expect(screen.queryByTestId("agent-page-retry")).toBeNull()
    expect(api.get.mock.calls.filter((c: unknown[]) => c[0] === "/agents")).toHaveLength(2)
    // THE PAGE READ IS RETRIED TOO. It was asked once, throttled, and never
    // asked again, so everything only it carries (the purpose, the channels,
    // the avatar) stayed empty for the rest of the session.
    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-purpose").textContent).toBe(
        "Keeps the shipping queue moving.",
      ),
    )
    expect(screen.getByTestId("agent-overview-channel-c-1").textContent).toBe("Shipping")
    expect(screen.getByTestId("agent-page-avatar")).toBeInTheDocument()
  })

  it("a non throttled failure still reads as an agent that is not available", async () => {
    const api: any = {
      get: vi.fn(async (path: string) => {
        if (path === "/agents") throw new ApiError("Nope", 500)
        return null
      }),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <AgentPage entityId={AGENT} />
      </ApiContext.Provider>
    ))
    await waitFor(() =>
      expect(screen.getAllByTestId("agent-profile-name")[0].textContent).toContain(
        "This agent is not available.",
      ),
    )
  })
  // A throttled LISTING is not an unknown agent when the page read answered:
  // the reader gets the agent rather than a notice about a request they did
  // not make.
  it("an answered page read fills the header even while the listing is throttled", async () => {
    const api: any = {
      get: vi.fn(async (path: string) => {
        if (path === "/agents") throw new ApiError("Too many requests", 429, "RATE_LIMITED", 30)
        if (/^\/agents\/[^/]+$/.test(path)) {
          return {
            data: { id: AGENT, handle: "@logistics", displayName: "Logistics", kind: "role" },
          }
        }
        return null
      }),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <AgentPage entityId={AGENT} />
      </ApiContext.Provider>
    ))
    await waitFor(() =>
      expect(screen.getAllByTestId("agent-profile-name")[0].textContent).toBe("Logistics"),
    )
    expect(screen.queryByTestId("agent-page-retry")).toBeNull()
  })
  // A THROTTLE ON ONE READ IS STILL A THROTTLE. The listing answered, so the
  // page had a name and a handle and looked fine, while everything only the
  // page read carries stayed empty with nothing on screen to ask again.
  it("offers the retry when only the page read was throttled, and fills the page after it", async () => {
    let pageCalls = 0
    const api: any = {
      get: vi.fn(async (path: string) => {
        if (path === "/agents") {
          return [{ id: AGENT, handle: "@logistics", displayName: "Logistics", kind: "role" }]
        }
        if (/^\/agents\/[^/]+$/.test(path)) {
          pageCalls++
          if (pageCalls === 1) {
            throw new ApiError("Too many requests", 429, "RATE_LIMITED", 30)
          }
          return {
            data: {
              id: AGENT,
              handle: "@logistics",
              displayName: "Logistics",
              kind: "role",
              ownerUserId: null,
              purpose: "Keeps the shipping queue moving.",
              avatarUrl: "https://example.test/a.png",
              lastActivityAt: null,
              channels: [{ id: "c-1", handle: "@shipping", name: "Shipping" }],
              counts: { skills: 0, routines: 0, memoryFiles: 0, knowledgePointers: 0 },
              capabilityCategories: [],
              runsOn: "liaison",
            },
          }
        }
        return null
      }),
      post: vi.fn(),
      put: vi.fn(),
      patch: vi.fn(),
      delete: vi.fn(),
    }
    render(() => (
      <ApiContext.Provider value={api as never}>
        <AgentPage entityId={AGENT} />
      </ApiContext.Provider>
    ))
    // The listing answered, so the header is the agent, and the retry is still
    // offered because the page read has not answered.
    await waitFor(() =>
      expect(screen.getAllByTestId("agent-profile-name")[0].textContent).toBe("Logistics"),
    )
    const retry = await screen.findByTestId("agent-page-retry")
    fireEvent.click(retry)

    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-purpose").textContent).toBe(
        "Keeps the shipping queue moving.",
      ),
    )
    expect(screen.getByTestId("agent-overview-channel-c-1").textContent).toBe("Shipping")
    expect(screen.getByTestId("agent-page-avatar")).toBeInTheDocument()
    expect(screen.queryByTestId("agent-page-retry")).toBeNull()
  })
})
