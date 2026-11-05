// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import AgentArchiveAdmin from "~/modules/agent/AgentArchiveAdmin"
import { ApiContext } from "~/modules/shell/ApiContext"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"

const ARCHIVED = "11111111-1111-4111-8111-111111111111"
const TARGET = "22222222-2222-4222-8222-222222222222"
const BLOCKED_COPY = "This agent still owns skills or routines. Reassign them first."

/** The route answers a blocked archive with 409 and puts the blocking assets
 *  on `error.details`, which the api client rethrows as ApiError.details. */
function blockedError(
  routines: Array<{ id: string; name: string }>,
  skills: Array<{ id: string; name: string }>,
) {
  return new ApiError(BLOCKED_COPY, 409, "archive_blocked", undefined, {
    blocked: true,
    routines,
    skills,
  })
}

function setup(api: Record<string, unknown>) {
  render(() => (
    <ApiContext.Provider value={api as never}>
      <AgentArchiveAdmin agentId={ARCHIVED} />
    </ApiContext.Provider>
  ))
}

describe("AgentArchiveAdmin (P4b-T34)", () => {
  beforeEach(async () => {
    resetAgentDirectory()
    await loadAgentDirectory({
      get: async () => ({
        data: [
          { id: ARCHIVED, handle: "@old", displayName: "Old", avatarUrl: null },
          { id: TARGET, handle: "@support", displayName: "Support", avatarUrl: null },
        ],
      }),
    })
  })
  afterEach(() => cleanup())

  it("archiving a blocked agent shows the exact Archive blocked string and lists each blocking skill and routine with a reassign action", async () => {
    const post = vi.fn(async () => {
      throw blockedError(
        [{ id: "r1", name: "Weekly digest" }],
        [{ id: "s1", name: "Shipping lookup" }],
      )
    })
    setup({ post, patch: vi.fn(async () => ({ data: {} })) })
    fireEvent.click(screen.getByTestId("agent-archive"))
    await waitFor(() => expect(screen.getByTestId("agent-archive-blocked")).toBeInTheDocument())
    expect(screen.getByTestId("agent-archive-blocked").textContent).toBe(BLOCKED_COPY)
    expect(screen.getByText("Weekly digest")).toBeInTheDocument()
    expect(screen.getByText("Shipping lookup")).toBeInTheDocument()
    expect(screen.getByTestId("reassign-routine-r1")).toBeInTheDocument()
    expect(screen.getByTestId("reassign-skill-s1")).toBeInTheDocument()
  })

  it("archiving succeeds once every blocking asset is reassigned", async () => {
    let attempt = 0
    const post = vi.fn(async () => {
      attempt += 1
      if (attempt === 1) {
        throw blockedError(
          [{ id: "r1", name: "Weekly digest" }],
          [{ id: "s1", name: "Shipping lookup" }],
        )
      }
      return { data: { blocked: false, archivedAt: "2026-09-12T00:00:00.000Z" } }
    })
    const patch = vi.fn(async () => ({ data: {} }))
    setup({ post, patch })
    fireEvent.click(screen.getByTestId("agent-archive"))
    await waitFor(() => expect(screen.getByTestId("agent-archive-blocked")).toBeInTheDocument())

    fireEvent.click(screen.getByTestId("reassign-routine-r1"))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(1))
    fireEvent.click(screen.getByTestId("reassign-skill-s1"))
    await waitFor(() => expect(patch).toHaveBeenCalledTimes(2))
    expect(patch).toHaveBeenCalledWith("/agent/routines/r1", { ownerAgentId: TARGET })
    expect(patch).toHaveBeenCalledWith("/agent/skills/s1", { ownerAgentId: TARGET })

    // The last reassign clears the blocker list, so the archive is retried
    // without the admin pressing Archive a second time.
    await waitFor(() => expect(screen.getByTestId("agent-archived")).toBeInTheDocument())
    expect(post).toHaveBeenCalledTimes(2)
    expect(screen.queryByTestId("agent-archive-blocked")).not.toBeInTheDocument()
  })

  it("reassigning to nobody is not offered when no other agent exists", async () => {
    resetAgentDirectory()
    await loadAgentDirectory({
      get: async () => ({
        data: [{ id: ARCHIVED, handle: "@old", displayName: "Old", avatarUrl: null }],
      }),
    })
    const post = vi.fn(async () => {
      throw blockedError([{ id: "r1", name: "Weekly digest" }], [])
    })
    setup({ post, patch: vi.fn() })
    fireEvent.click(screen.getByTestId("agent-archive"))
    await waitFor(() => expect(screen.getByTestId("agent-archive-blocked")).toBeInTheDocument())
    expect(screen.getByTestId("reassign-routine-r1")).toBeDisabled()
  })
})
