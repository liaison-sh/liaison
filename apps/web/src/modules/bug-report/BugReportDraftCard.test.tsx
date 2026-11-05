// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"

const state = vi.hoisted(() => ({
  draft: null as Record<string, unknown> | null,
  sendError: null as unknown,
  posts: [] as Array<{ path: string; body: unknown }>,
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({
    get: vi.fn(async () => {
      if (!state.draft) throw new Error("404")
      return state.draft
    }),
    post: vi.fn(async (path: string, body: unknown) => {
      state.posts.push({ path, body })
      if (state.sendError) throw state.sendError
      return { forwarded: "queued", messageId: "msg-42" }
    }),
  }),
}))

import { BugReportDraftCard } from "./BugReportDraftCard"

const DIGEST = "b".repeat(64)

describe("BugReportDraftCard", () => {
  beforeEach(() => {
    state.draft = {
      draftId: "d-1",
      data: { report: { description: "Save spins" }, reporter: { email: "me@example.test" } },
      digest: DIGEST,
      createdAt: "2026-11-03T10:00:00.000Z",
      sentMessageId: null,
    }
    state.sendError = null
    state.posts = []
  })

  it("shows the exact payload and sends it with its digest only on the click", async () => {
    render(() => <BugReportDraftCard draftId="d-1" />)
    expect(await screen.findByTestId("bug-report-draft-payload")).toHaveTextContent(
      "me@example.test",
    )
    expect(state.posts).toHaveLength(0)
    fireEvent.click(screen.getByTestId("bug-report-draft-send"))
    expect(await screen.findByTestId("bug-report-draft-sent")).toHaveTextContent("msg-42")
    expect(state.posts).toEqual([
      { path: "/bug-reports/drafts/d-1/send", body: { digest: DIGEST } },
    ])
  })

  it("an expired or foreign draft shows that it is gone", async () => {
    state.draft = null
    render(() => <BugReportDraftCard draftId="d-1" />)
    expect(await screen.findByTestId("bug-report-draft-gone")).toBeInTheDocument()
    expect(screen.queryByTestId("bug-report-draft-send")).toBeNull()
  })

  it("the hourly cap is said in words", async () => {
    state.sendError = new ApiError("limit", 429, "FORWARD_RATE_LIMITED")
    render(() => <BugReportDraftCard draftId="d-1" />)
    fireEvent.click(await screen.findByTestId("bug-report-draft-send"))
    await waitFor(() =>
      expect(screen.getByTestId("bug-report-draft-error")).toHaveTextContent(
        "Too many prepared reports",
      ),
    )
  })

  it("an already sent draft shows its reference", async () => {
    state.draft = { ...(state.draft ?? {}), sentMessageId: "msg-7" }
    render(() => <BugReportDraftCard draftId="d-1" />)
    expect(await screen.findByTestId("bug-report-draft-sent")).toHaveTextContent("msg-7")
  })

  it("shows the whole report as readable text at full height, with its extra fields listed", async () => {
    const description = `Save spins\n\n${"The save button spins forever. ".repeat(500)}END-OF-REPORT\n\nAdditional context:\nrequest-42`
    state.draft = {
      ...(state.draft ?? {}),
      data: {
        version: "1.0.0",
        edition: "self_hosted",
        report: {
          description,
          page: "/threads",
          userAgent: "Filed through: Liaison agent",
          logs: ["log line one", "log line two"],
          logsTruncated: false,
          serverErrors: [{ signature: "TypeError at save", count1h: 3 }],
          attachments: [
            { index: 0, filename: "shot.png", mimeType: "image/png", sizeBytes: 10, sha256: "a" },
          ],
        },
        reporter: { email: "me@example.test" },
      },
    }
    render(() => <BugReportDraftCard draftId="d-1" />)
    const text = await screen.findByTestId("bug-report-draft-description")
    expect(text).toHaveTextContent("END-OF-REPORT")
    expect(text).toHaveTextContent("Additional context:")
    expect(text.textContent).toBe(description)
    // Not a capped, scrolling box: nothing hides part of what is about to be sent.
    for (const id of ["bug-report-draft-payload", "bug-report-draft-description"]) {
      const cls = screen.getByTestId(id).className
      expect(cls).not.toMatch(/max-h-/)
      expect(cls).not.toMatch(/overflow-(auto|scroll|hidden)/)
    }
    expect(screen.getByTestId("bug-report-draft-page")).toHaveTextContent("/threads")
    expect(screen.getByTestId("bug-report-draft-reporter")).toHaveTextContent("me@example.test")
    expect(screen.getByTestId("bug-report-draft-attachments")).toHaveTextContent("shot.png")
    expect(screen.getByTestId("bug-report-draft-logs")).toHaveTextContent("log line two")
    expect(screen.getByTestId("bug-report-draft-server-errors")).toHaveTextContent(
      "TypeError at save",
    )
  })

  it("a payload of an unknown shape is still shown whole, uncapped", async () => {
    state.draft = { ...(state.draft ?? {}), data: { surprise: "x".repeat(50), other: 1 } }
    render(() => <BugReportDraftCard draftId="d-1" />)
    const box = await screen.findByTestId("bug-report-draft-payload")
    expect(box).toHaveTextContent("surprise")
    expect(box.className).not.toMatch(/max-h-/)
  })
})
