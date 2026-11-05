// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Computers > <computer> > Folders > Find repos I can access (S3,
// S6, S7, S16): three row states (Shared; on the computer, Share; not on it,
// Clone and share), a tool missing or signed out says so with the command to
// run, and an older computer is told to update.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import type { NodeSummary } from "~/modules/nodes/node-api"
import { ApiContext } from "~/modules/shell/ApiContext"
import { RemoteReposSection } from "./RemoteReposSection"

const node: NodeSummary = {
  id: "n-1",
  name: "Mac",
  enabled: true,
  online: true,
  lastSeenAt: null,
  os: "macos",
  appVersion: null,
  deviceId: "d",
  queue: { queued: 0, running: 0 },
  sharedFolderNames: [],
}

const repo = (over: Record<string, unknown>) => ({
  source: "github",
  fullName: "me/app",
  host: "github.com",
  cloneUrl: "https://github.com/me/app.git",
  private: false,
  pushedAt: null,
  local: null,
  ...over,
})

const list = { shared: { roots: ["/Users/me/code/app"] }, search: { roots: [] } }

function renderSection(
  post: (path: string, body: any) => unknown,
  cloned: () => Promise<string | null> = () => new Promise(() => {}),
) {
  const api = { get: vi.fn(), post: vi.fn(async (p: string, b: any) => post(p, b)) }
  const onShared = vi.fn()
  const onClone = vi.fn(cloned)
  render(() => (
    <ApiContext.Provider value={api as never}>
      <RemoteReposSection
        node={node}
        onShared={onShared}
        onClone={onClone}
        sentence={(err) => `refused ${err instanceof ApiError ? err.code : String(err)}`}
      />
    </ApiContext.Provider>
  ))
  return { api, onShared, onClone }
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("Find repos I can access", () => {
  it("S6: shared shows Shared, local unshared has Share, a remote one Clone and share", async () => {
    const { api, onShared, onClone } = renderSection((path) => {
      if (path.endsWith("/remotes")) {
        return {
          repos: [
            repo({
              fullName: "me/done",
              local: { display: "~/done", shared: true, candidateId: null },
            }),
            repo({
              fullName: "me/here",
              private: true,
              local: { display: "~/code/here", shared: false, candidateId: "c-here" },
            }),
            repo({ fullName: "team/away", cloneUrl: "git@github.com:team/away.git" }),
          ],
          sources: [
            { tool: "gh", state: "ok" },
            { tool: "glab", state: "missing" },
          ],
          dropped: 0,
        }
      }
      if (path.endsWith("/share")) return list
      throw new Error(path)
    })
    fireEvent.click(screen.getByTestId("remote-repos-run"))
    await waitFor(() => expect(screen.getAllByTestId("remote-repos-row")).toHaveLength(3))
    expect(screen.getAllByTestId("remote-repos-row").map((r) => r.dataset.state)).toEqual([
      "shared",
      "local",
      "remote",
    ])
    expect(screen.getByTestId("remote-repos-shared").textContent).toBe("Shared")
    // gh works: glab being absent is not worth a line.
    expect(screen.queryByTestId("remote-repos-source-glab")).toBeNull()
    fireEvent.click(screen.getByTestId("remote-repos-share"))
    await waitFor(() => expect(onShared).toHaveBeenCalledWith(expect.anything(), "here"))
    expect(api.post).toHaveBeenCalledWith("/nodes/n-1/folders/share", { candidateId: "c-here" })
    await waitFor(() =>
      expect(screen.getAllByTestId("remote-repos-row")[1]?.dataset.state).toBe("shared"),
    )
    fireEvent.click(screen.getByTestId("remote-repos-clone"))
    expect(onClone).toHaveBeenCalledWith("git@github.com:team/away.git", "away")
    expect(screen.getAllByTestId("remote-repos-row")[2]?.dataset.state).toBe("cloning")
  })

  it("S6: a clone that fails says why on its row and offers Clone again", async () => {
    renderSection(
      () => ({
        repos: [repo({ fullName: "team/away" })],
        sources: [{ tool: "gh", state: "ok" }],
        dropped: 0,
      }),
      async () => "refused CloneAuthFailed",
    )
    fireEvent.click(screen.getByTestId("remote-repos-run"))
    fireEvent.click(await screen.findByTestId("remote-repos-clone"))
    await waitFor(() =>
      expect(screen.getByTestId("remote-repos-row-error").textContent).toBe(
        "refused CloneAuthFailed",
      ),
    )
    expect(screen.getByTestId("remote-repos-row").dataset.state).toBe("remote")
    expect(screen.getByTestId("remote-repos-clone")).toBeTruthy()
  })

  it("S6: a clone that succeeds asks the computer again, and the row says Shared", async () => {
    let asked = 0
    const { api } = renderSection(
      () => {
        asked++
        return {
          repos: [
            repo({
              fullName: "team/away",
              local:
                asked > 1
                  ? { display: "~/Liaison Node/repos/away", shared: true, candidateId: null }
                  : null,
            }),
          ],
          sources: [{ tool: "gh", state: "ok" }],
          dropped: 0,
        }
      },
      async () => null,
    )
    fireEvent.click(screen.getByTestId("remote-repos-run"))
    fireEvent.click(await screen.findByTestId("remote-repos-clone"))
    await waitFor(() => expect(screen.getByTestId("remote-repos-row").dataset.state).toBe("shared"))
    expect(api.post).toHaveBeenCalledTimes(2)
  })

  it("S7: gh signed out and glab missing say so, each with the command to run", async () => {
    renderSection(() => ({
      repos: [],
      sources: [
        { tool: "gh", state: "signed_out" },
        { tool: "glab", state: "missing" },
      ],
      dropped: 0,
    }))
    fireEvent.click(screen.getByTestId("remote-repos-run"))
    const gh = await screen.findByTestId("remote-repos-source-gh")
    expect(gh.textContent).toContain("is not signed in")
    expect(screen.getByTestId("remote-repos-login-gh").textContent).toBe("gh auth login")
    expect(screen.getByTestId("remote-repos-source-glab").textContent).toContain("not installed")
    expect(screen.getByTestId("remote-repos-login-glab").textContent).toBe("glab auth login")
    expect(screen.queryByTestId("remote-repos-empty")).toBeNull()
  })

  it("S16: an older computer (failed) is told to update Liaison", async () => {
    renderSection(() => {
      throw new ApiError("refused", 422, "failed")
    })
    fireEvent.click(screen.getByTestId("remote-repos-run"))
    expect((await screen.findByTestId("remote-repos-error")).textContent).toContain(
      "Update Liaison on this computer to use this.",
    )
  })

  it("the filter narrows the rows by name; dropped repos are counted", async () => {
    renderSection(() => ({
      repos: [repo({ fullName: "me/app" }), repo({ fullName: "me/docs" })],
      sources: [{ tool: "gh", state: "ok" }],
      dropped: 2,
    }))
    fireEvent.click(screen.getByTestId("remote-repos-run"))
    await waitFor(() => expect(screen.getAllByTestId("remote-repos-row")).toHaveLength(2))
    fireEvent.input(screen.getByTestId("remote-repos-filter"), { target: { value: "doc" } })
    await waitFor(() => expect(screen.getAllByTestId("remote-repos-row")).toHaveLength(1))
    expect(screen.getByTestId("remote-repos-dropped").textContent).toContain("2")
  })
})
