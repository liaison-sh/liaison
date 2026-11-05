// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Settings > Computers > <computer> > Folders > Scan for repos (S1, S2, S16):
// the scan's repositories as a checklist (shared ticked and fixed, ones that
// cannot be shared fixed with their reason), Share selected in ONE request,
// refused rows said in words, an older computer told to update.
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import type { NodeSummary } from "~/modules/nodes/node-api"
import { ApiContext } from "~/modules/shell/ApiContext"
import { RepoScanSection } from "./RepoScanSection"

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

const candidate = (over: Record<string, unknown>) => ({
  candidateId: null,
  name: "repo",
  display: "~/code/repo",
  shared: false,
  shareable: true,
  refusal: null,
  ...over,
})

const scan = (candidates: unknown[], over: Record<string, unknown> = {}) => ({
  searchRoots: 1,
  partial: false,
  denied: [],
  skippedProtected: false,
  candidates,
  ...over,
})

const list = { shared: { roots: ["/Users/me/code/app"] }, search: { roots: [] } }

function renderSection(post: (path: string, body: any) => unknown) {
  const api = { get: vi.fn(), post: vi.fn(async (p: string, b: any) => post(p, b)) }
  const onShared = vi.fn()
  const sentence = vi.fn((err: unknown, name = "") =>
    err instanceof ApiError || typeof err === "string"
      ? `refused ${err instanceof ApiError ? err.code : err} ${name}`
      : "failed",
  )
  render(() => (
    <ApiContext.Provider value={api as never}>
      <RepoScanSection node={node} onShared={onShared} sentence={sentence} />
    </ApiContext.Provider>
  ))
  return { api, onShared }
}

afterEach(() => {
  document.body.innerHTML = ""
})

describe("Scan for repos", () => {
  it("S1: the heading names the computer (no raw placeholder)", () => {
    renderSection(() => {
      throw new Error("no call")
    })
    const heading = screen.getByRole("heading", { level: 2 })
    expect(heading.textContent).toBe("Repositories on Mac")
  })

  it("S1, S2: shows the repos as a checklist; Share selected shares every ticked row in one request", async () => {
    const { api, onShared } = renderSection((path) => {
      if (path.endsWith("/scan")) {
        return scan([
          candidate({ name: "done", display: "~/code/done", shared: true }),
          candidate({ candidateId: "c-a", name: "app", display: "~/code/app" }),
          candidate({ candidateId: "c-b", name: "lib", display: "~/code/lib" }),
          candidate({ name: "dots", display: "~/.dots", shareable: false, refusal: "hidden" }),
        ])
      }
      if (path.endsWith("/share-many")) return { ...list, refused: [] }
      throw new Error(path)
    })
    fireEvent.click(screen.getByTestId("repo-scan-run"))
    await waitFor(() => expect(screen.getAllByTestId("repo-scan-row")).toHaveLength(4))
    const checks = screen.getAllByTestId("repo-scan-check") as HTMLInputElement[]
    // Shared: ticked and fixed. Hidden: fixed, with why.
    expect(checks[0]?.checked).toBe(true)
    expect(checks[0]?.disabled).toBe(true)
    expect(checks[3]?.disabled).toBe(true)
    expect(screen.getByTestId("repo-scan-reason").textContent).toContain("Hidden or system folder")
    const share = screen.getByTestId("repo-scan-share") as HTMLButtonElement
    expect(share.disabled).toBe(true)
    fireEvent.click(checks[1] as HTMLInputElement)
    fireEvent.click(checks[2] as HTMLInputElement)
    expect(share.textContent).toContain("Share selected (2)")
    fireEvent.click(share)
    await waitFor(() => expect(onShared).toHaveBeenCalledTimes(1))
    const shareCalls = api.post.mock.calls.filter((c) => String(c[0]).endsWith("/share-many"))
    expect(shareCalls).toEqual([
      ["/nodes/n-1/folders/share-many", { candidateIds: ["c-a", "c-b"] }],
    ])
    expect(onShared.mock.calls[0]?.[1]).toEqual(["app", "lib"])
    await waitFor(() =>
      expect(
        screen.getAllByTestId("repo-scan-row").map((r) => r.getAttribute("data-shared")),
      ).toEqual(["true", "true", "true", "false"]),
    )
  })

  it("S2: a row the computer refused says why and stays unshared", async () => {
    renderSection((path) => {
      if (path.endsWith("/scan")) {
        return scan([
          candidate({ candidateId: "c-a", name: "app" }),
          candidate({ candidateId: "c-b", name: "lib", display: "~/code/lib" }),
        ])
      }
      return { ...list, refused: [{ candidateId: "c-b", code: "SharedRootsFull" }] }
    })
    fireEvent.click(screen.getByTestId("repo-scan-run"))
    const checks = (await screen.findAllByTestId("repo-scan-check")) as HTMLInputElement[]
    fireEvent.click(checks[0] as HTMLInputElement)
    fireEvent.click(checks[1] as HTMLInputElement)
    fireEvent.click(screen.getByTestId("repo-scan-share"))
    const refused = await screen.findByTestId("repo-scan-refused")
    expect(refused.textContent).toBe("refused SharedRootsFull lib")
    expect(screen.getAllByTestId("repo-scan-row").map((r) => r.dataset.shared)).toEqual([
      "true",
      "false",
    ])
  })

  it("edge: no place to look in says so", async () => {
    renderSection(() => scan([], { searchRoots: 0 }))
    fireEvent.click(screen.getByTestId("repo-scan-run"))
    expect((await screen.findByTestId("repo-scan-no-roots")).textContent).toContain(
      "Nowhere to look yet",
    )
  })

  it("S1: a scan that stopped early says there may be more", async () => {
    renderSection(() => scan([candidate({ candidateId: "c-a" })], { partial: true }))
    fireEvent.click(screen.getByTestId("repo-scan-run"))
    expect((await screen.findByTestId("repo-scan-partial")).textContent).toContain("stopped early")
  })

  it("S16: an older computer (failed) is told to update Liaison, with Retry", async () => {
    renderSection(() => {
      throw new ApiError("refused", 422, "failed")
    })
    fireEvent.click(screen.getByTestId("repo-scan-run"))
    const error = await screen.findByTestId("repo-scan-error")
    expect(error.textContent).toContain("Update Liaison on this computer to use this.")
    expect(screen.getByTestId("repo-scan-retry")).toBeTruthy()
  })

  it("a used id (ShareNotIssued) scans again quietly and shows the fresh state", async () => {
    let scans = 0
    renderSection((path) => {
      if (path.endsWith("/scan")) {
        scans++
        return scan([candidate({ candidateId: scans === 1 ? "c-a" : null, shared: scans > 1 })])
      }
      throw new ApiError("refused", 422, "ShareNotIssued")
    })
    fireEvent.click(screen.getByTestId("repo-scan-run"))
    fireEvent.click((await screen.findAllByTestId("repo-scan-check"))[0] as HTMLInputElement)
    fireEvent.click(screen.getByTestId("repo-scan-share"))
    await waitFor(() => expect(scans).toBe(2))
    await waitFor(() =>
      expect(screen.getByTestId("repo-scan-row").getAttribute("data-shared")).toBe("true"),
    )
    expect(screen.queryByTestId("repo-scan-share-error")).toBeNull()
  })
})
