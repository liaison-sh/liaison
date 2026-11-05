// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const state = vi.hoisted(() => ({
  available: true,
  teamOnly: false,
  drafts: [] as Array<Record<string, unknown>>,
  previews: [] as Array<Record<string, unknown>>,
  posts: [] as Array<{ path: string; body: Record<string, any> }>,
  refuseSend: false,
  // The operator switched forwarding off: every forward call is refused, as the server does.
  forwardingOff: false,
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: vi.fn(async (path: string) => {
      if (path === "/bug-reports/forwarding")
        return { available: state.available, teamOnly: state.teamOnly }
      if (path === "/bug-reports/drafts") return state.drafts
      if (path.startsWith("/bug-reports/drafts/"))
        return state.drafts.find((d) => path.endsWith(String(d.draftId)))
      return {}
    }),
    post: vi.fn(
      async (path: string, body: Record<string, any>, init?: { suppressGlobalError?: boolean }) => {
        state.posts.push({ path, body })
        if (
          (state.refuseSend && path === "/bug-reports") ||
          (state.forwardingOff && path === "/bug-reports/forward-preview")
        ) {
          // Like the real client: a non-suppressed failure raises the global toast too.
          if (!init?.suppressGlobalError)
            addToast({ message: "Sending is unavailable", type: "error" })
          throw new ApiError("unavailable", 409, "FORWARDING_UNAVAILABLE")
        }
        if (path === "/bug-reports/forward-preview") {
          const data = {
            version: "v1.0.0",
            edition: "self_hosted",
            report: {
              description: body.description,
              page: "/",
              userAgent: "UA",
              logs: [],
              logsTruncated: false,
              attachments: (body.attachmentIndexes as number[]).map((index) => ({ index })),
            },
            ...(body.includeEmail ? { reporter: { email: "reporter@example.test" } } : {}),
          }
          const preview = {
            snapshotId: "11111111-1111-4111-8111-111111111111",
            data,
            attachments: (body.attachments ?? []).map((a: { filename: string }, index: number) => ({
              index,
              filename: a.filename,
              mimeType: "image/png",
              sizeBytes: 1,
              tooLarge: false,
              blocked: false,
            })),
            digest: `digest-${state.previews.length + 1}`,
          }
          state.previews.push(preview)
          return preview
        }
        if (body.forward?.teamOnly) {
          return { teamOnly: true, forwarded: "queued", messageId: "m-1", attachmentsSkipped: [] }
        }
        return { ticketId: "t", forwarded: body.forward ? "queued" : undefined }
      },
    ),
  }),
}))

vi.mock("~/lib/logger", () => ({ getRecentLogs: () => ["log line"] }))

import { ApiError } from "~/lib/api-error"
import { addToast, resetToastStore, toasts } from "~/modules/shell/toast-store"
import { BugReportDialog } from "./BugReportDialog"

const previewPosts = () => state.posts.filter((p) => p.path === "/bug-reports/forward-preview")

function pickFiles(files: File[]): void {
  const input = screen.getByTestId("bug-report-attach-input") as HTMLInputElement
  Object.defineProperty(input, "files", { value: files, configurable: true })
  fireEvent.change(input)
}

describe("BugReportDialog: forwarding to the Liaison team", () => {
  beforeEach(() => {
    state.available = true
    state.teamOnly = false
    state.drafts = []
    state.previews = []
    state.posts = []
    state.refuseSend = false
    state.forwardingOff = false
    resetToastStore()
  })

  it("HQ-only switched off before send: exactly one accurate message", async () => {
    state.teamOnly = true
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.input(await screen.findByTestId("bug-report-description"), {
      target: { value: "Broken" },
    })
    await waitFor(() =>
      expect(screen.getByTestId("bug-report-forward-preview").textContent).toContain("Broken"),
    )
    state.refuseSend = true
    fireEvent.click(screen.getByTestId("bug-report-send"))
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 50))
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].message).toContain("Sending only to the Liaison team is no longer available")
  })

  it("HQ-only switched off before send: the refusal fires no further preview request", async () => {
    state.teamOnly = true
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.input(await screen.findByTestId("bug-report-description"), {
      target: { value: "Broken" },
    })
    await waitFor(() =>
      expect(screen.getByTestId("bug-report-forward-preview").textContent).toContain("Broken"),
    )
    // Switched off on the server: the send and any later preview are both refused.
    state.refuseSend = true
    state.forwardingOff = true
    const previewsBefore = previewPosts().length
    fireEvent.click(screen.getByTestId("bug-report-send"))
    await waitFor(() => expect(toasts().length).toBeGreaterThan(0))
    await new Promise((r) => setTimeout(r, 600))
    expect(previewPosts()).toHaveLength(previewsBefore)
    expect(toasts()).toHaveLength(1)
    expect(toasts()[0].message).toContain("Sending only to the Liaison team is no longer available")
  })

  it("the forward box is hidden when forwarding is unavailable", async () => {
    state.available = false
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    await screen.findByTestId("bug-report-description")
    await new Promise((r) => setTimeout(r, 0))
    expect(screen.queryByTestId("bug-report-forward")).toBeNull()
  })

  it("the forward box is unticked; the email box appears only after the first tick", async () => {
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    const forward = (await screen.findByTestId("bug-report-forward")) as HTMLInputElement
    expect(forward.checked).toBe(false)
    expect(screen.queryByTestId("bug-report-forward-email")).toBeNull()
    fireEvent.click(forward)
    const email = (await screen.findByTestId("bug-report-forward-email")) as HTMLInputElement
    expect(email.checked).toBe(false)
  })

  it("the preview shows reporter.email only after the second tick", async () => {
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.input(await screen.findByTestId("bug-report-description"), {
      target: { value: "Broken" },
    })
    fireEvent.click(await screen.findByTestId("bug-report-forward"))
    const panel = await screen.findByTestId("bug-report-forward-preview")
    await waitFor(() => expect(panel.textContent).toContain('"description": "Broken"'))
    expect(panel.textContent).not.toContain("reporter@example.test")
    fireEvent.click(await screen.findByTestId("bug-report-forward-email"))
    await waitFor(() =>
      expect(screen.getByTestId("bug-report-forward-preview").textContent).toContain(
        "reporter@example.test",
      ),
    )
    // The second preview reuses the first one's snapshot.
    expect(previewPosts()[1]?.body.snapshotId).toBe("11111111-1111-4111-8111-111111111111")
  })

  it("files are listed with name and size, unticked, and a too-large one is disabled with the message", async () => {
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    await screen.findByTestId("bug-report-forward")
    const small = new File(["abc"], "shot.png", { type: "image/png" })
    const big = new File(["x"], "screen.mp4", { type: "video/mp4" })
    Object.defineProperty(big, "size", { value: 8 * 1024 * 1024 })
    pickFiles([small, big])
    fireEvent.click(screen.getByTestId("bug-report-forward"))
    const first = (await screen.findByTestId("bug-report-forward-file-0")) as HTMLInputElement
    const second = screen.getByTestId("bug-report-forward-file-1") as HTMLInputElement
    expect(first.checked).toBe(false)
    expect(first.disabled).toBe(false)
    expect(second.checked).toBe(false)
    expect(second.disabled).toBe(true)
    const list = screen.getByTestId("bug-report-forward-files")
    expect(list.textContent).toContain("shot.png")
    expect(list.textContent).toContain("3 B")
    expect(list.textContent).toContain(
      "Too large to send to the Liaison team (max 7 MB); it stays on your local report",
    )
  })

  it("submit sends the previewed digest, snapshotId and ticked indexes", async () => {
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.input(await screen.findByTestId("bug-report-description"), {
      target: { value: "Broken" },
    })
    await screen.findByTestId("bug-report-forward")
    pickFiles([new File(["abc"], "shot.png", { type: "image/png" })])
    fireEvent.click(screen.getByTestId("bug-report-forward"))
    fireEvent.click(await screen.findByTestId("bug-report-forward-file-0"))
    await waitFor(() => expect(previewPosts()).toHaveLength(2))
    await waitFor(() =>
      expect(screen.getByTestId("bug-report-forward-preview").textContent).toContain('"index": 0'),
    )
    fireEvent.click(screen.getByTestId("bug-report-send"))
    await waitFor(() => expect(state.posts.some((p) => p.path === "/bug-reports")).toBe(true))
    const sent = state.posts.find((p) => p.path === "/bug-reports")?.body
    expect(sent?.forward).toEqual({
      includeEmail: false,
      snapshotId: "11111111-1111-4111-8111-111111111111",
      digest: "digest-2",
      attachmentIndexes: [0],
    })
    expect(sent?.clientLogs).toEqual(["log line"])
  })
})

describe("BugReportDialog: reports go only to the Liaison team", () => {
  beforeEach(() => {
    state.available = true
    state.teamOnly = true
    state.drafts = []
    state.previews = []
    state.posts = []
  })

  it("shows the fixed line instead of the box, the preview, and the email ticked by default", async () => {
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    expect(await screen.findByTestId("bug-report-team-only-line")).toHaveTextContent(
      "This report goes only to the Liaison team.",
    )
    expect(screen.queryByTestId("bug-report-forward")).toBeNull()
    const email = (await screen.findByTestId("bug-report-forward-email")) as HTMLInputElement
    expect(email.checked).toBe(true)
    await waitFor(() =>
      expect(screen.getByTestId("bug-report-forward-preview").textContent).toContain(
        "reporter@example.test",
      ),
    )
    // The email can be unticked.
    fireEvent.click(email)
    await waitFor(() =>
      expect(screen.getByTestId("bug-report-forward-preview").textContent).not.toContain(
        "reporter@example.test",
      ),
    )
  })

  it("submit carries teamOnly and the previewed digest", async () => {
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    fireEvent.input(await screen.findByTestId("bug-report-description"), {
      target: { value: "Broken" },
    })
    await waitFor(() =>
      expect(screen.getByTestId("bug-report-forward-preview").textContent).toContain(
        '"description": "Broken"',
      ),
    )
    const digest = state.previews[state.previews.length - 1]?.digest
    fireEvent.click(screen.getByTestId("bug-report-send"))
    await waitFor(() => expect(state.posts.some((p) => p.path === "/bug-reports")).toBe(true))
    const sent = state.posts.find((p) => p.path === "/bug-reports")?.body
    expect(sent?.forward).toMatchObject({ includeEmail: true, teamOnly: true, digest })
  })

  it("lists a report the agent prepared, with its own Send card", async () => {
    state.drafts = [
      {
        draftId: "d-1",
        data: { report: { description: "Prepared by the agent" } },
        digest: "a".repeat(64),
        createdAt: "2026-11-03T10:00:00.000Z",
        sentMessageId: null,
      },
    ]
    render(() => <BugReportDialog open={true} onOpenChange={() => {}} />)
    expect(await screen.findByTestId("bug-report-drafts")).toBeInTheDocument()
    expect(await screen.findByTestId("bug-report-draft-payload")).toHaveTextContent(
      "Prepared by the agent",
    )
  })
})
