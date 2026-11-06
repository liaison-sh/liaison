// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Regression (prod, ticket-10197 / ticket-10200): three approvals sat wedged at
// `approving`, and pressing Approve on them returned a bare 409 that the UI
// rendered as "This request was just decided by someone else." That sentence is
// both wrong and actively misleading: the request was NOT decided by someone
// else, it was approved and its execution never reported back, and the way out
// is Reject. Told the wrong story, the operator presses Approve again. One row
// took that treatment for 22 days.
import { describe, expect, it } from "vitest"
import { ApiError } from "~/lib/api-error"
import { causeForSentence, decideErrorToast, postDecision } from "~/modules/approvals/decide-error"

describe("decideErrorToast: a handler cause that ends its own sentence", () => {
  const failed = (code: string, message: string) =>
    new ApiError(code, 422, code, undefined, { code: "DEMO_RESTRICTED", details: { message } })

  it("never prints a double period when the upstream message ends in one", () => {
    const handling = decideErrorToast(
      failed("handler_failed", "This is a demo, so nothing was sent to the outside world."),
    )
    expect(handling.toast.message).toBe(
      "Tool execution failed: This is a demo, so nothing was sent to the outside world.",
    )
    expect(handling.toast.message).not.toContain("..")
  })

  it("does the same on an ambiguous outcome", () => {
    const handling = decideErrorToast(failed("handler_ambiguous", "Upstream timed out."))
    expect(handling.toast.message).toBe(
      "Tool run failed: Upstream timed out. The request needs operator review.",
    )
  })

  it("keeps a cause without a period whole, and other end punctuation as written", () => {
    expect(decideErrorToast(failed("handler_failed", "quota exceeded")).toast.message).toBe(
      "Tool execution failed: quota exceeded.",
    )
    expect(causeForSentence("Is the store online?")).toBe("Is the store online?")
    expect(causeForSentence("Refused.  ")).toBe("Refused")
  })
})

describe("decideErrorToast: a two-approver request already signed off", () => {
  it("says it needs a different approver, keeps the row, never claims someone else decided it", () => {
    const handling = decideErrorToast(new ApiError("already signed off", 409, "already_signed_off"))
    expect(handling.toast.message).toBe(
      "You have already signed off on this request. It needs a second, different approver.",
    )
    expect(handling.refreshFeed).toBe(false)
    expect(handling.toast.message).not.toMatch(/someone else/i)
  })
})

describe("decideErrorToast — wedged execution", () => {
  const wedged = (details?: unknown) =>
    new ApiError(
      "execution_outcome_unknown",
      409,
      "execution_outcome_unknown",
      undefined,
      details as never,
    )

  it("does NOT claim someone else decided it", () => {
    const handling = decideErrorToast(wedged())
    expect(handling.toast.message).not.toMatch(/someone else/i)
  })

  it("names the way out (Reject), so Approve does not read as a dead button", () => {
    const handling = decideErrorToast(wedged())
    expect(handling.toast.message).toMatch(/reject/i)
    expect(handling.toast.type).toBe("error")
  })

  it("surfaces the server's own explanation when it sends one", () => {
    const handling = decideErrorToast(
      wedged({
        message: "Check whether the action landed, then Reject to close this request out.",
      }),
    )
    expect(handling.toast.message).toContain("Check whether the action landed")
  })

  it("keeps the cause ON the card, not only in a toast that fades", () => {
    expect(decideErrorToast(wedged()).inline).toBe(true)
  })

  it("does NOT drop the row from the feed — Reject is the only control that works on it", () => {
    // The sibling fix reloads the feed on failures that prove the row is gone.
    // This row is emphatically still there, and reloading it away would remove
    // the operator's only escape hatch.
    expect(decideErrorToast(wedged()).refreshFeed).toBe(false)
  })
})

describe("decideErrorToast — refreshFeed is set only for rows that are truly gone", () => {
  it("reloads for a plain 409 (decided by someone else) and a 404 (deleted)", () => {
    expect(decideErrorToast(new ApiError("conflict", 409, "stale_status")).refreshFeed).toBe(true)
    expect(decideErrorToast(new ApiError("not_found", 404, "not_found")).refreshFeed).toBe(true)
  })

  it("does NOT reload for failures that leave the row decidable", () => {
    // A 422 handler failure reverts the row to pending: it is live, it carries an
    // inline cause the operator is reading, and reloading would throw that away.
    for (const err of [
      new ApiError("handler_failed", 422, "handler_failed"),
      new ApiError("handler_ambiguous", 422, "handler_ambiguous"),
      new ApiError("forbidden", 403, "forbidden"),
      new ApiError("invalid_reason", 400, "invalid_reason"),
      new ApiError("boom", 500, "server_error"),
    ]) {
      expect(decideErrorToast(err).refreshFeed).toBe(false)
    }
  })
})

describe("decideErrorToast: already_decided names the real status", () => {
  // A click on a row that is no longer pending used to read "decided by someone
  // else" whatever had happened: the operator's own approval still executing
  // (then cut by a restart), or a draft their agent withdrew and replaced while
  // the card was open. Both were reported as someone else deciding.
  const conflict = (currentStatus: string) =>
    new ApiError(`already_decided: ${currentStatus}`, 409, "already_decided", undefined, {
      currentStatus,
    })
  const msg = (currentStatus: string) =>
    decideErrorToast(conflict(currentStatus), (k) => k).toast.message

  it("an approving row says it is already being carried out", () => {
    expect(msg("approving")).toBe("kernel.approvalsUi.err.alreadyRunning")
  })
  it("a withdrawn row says it was withdrawn", () => {
    expect(msg("withdrawn")).toBe("kernel.approvalsUi.err.alreadyWithdrawn")
  })
  it("expired and cancelled rows say so", () => {
    expect(msg("expired")).toBe("kernel.approvalsUi.err.alreadyExpired")
    expect(msg("cancelled")).toBe("kernel.approvalsUi.err.alreadyCancelled")
  })
  // Fabrikam, 2026-10-01: a sealed send approved without its decrypted draft
  // said "decided by someone else" on a request nobody had touched.
  it("a sealed mail send refused for its missing draft says so, and keeps the row", () => {
    const handled = decideErrorToast(
      new ApiError("sealed", 409, "mailbox_fulfilment_required"),
      (k) => k,
    )
    expect(handled.toast.message).toBe("kernel.approvalsUi.err.mailboxSealed")
    expect(handled.refreshFeed).toBe(false)
  })
  it("a mail send whose draft was purged says so, and keeps the row", () => {
    const handled = decideErrorToast(new ApiError("gone", 422, "mail_draft_removed"), (k) => k)
    expect(handled.toast.message).toBe("kernel.approvalsUi.err.mailDraftRemoved")
    expect(handled.refreshFeed).toBe(false)
  })
  it("only approved or denied rows read as decided by someone else", () => {
    expect(msg("approved")).toBe("kernel.approvalsUi.err.decidedElsewhere")
    expect(msg("denied")).toBe("kernel.approvalsUi.err.decidedElsewhere")
  })
})

// Prod: approving a scope request hit a server 500 and the operator got TWO
// toasts, "Something went wrong. Try again." from the api client and
// "Couldn't reach server." from this mapping. The server had been reached; the
// second toast sent the operator checking their connection instead of
// reporting the failure.
describe("decideErrorToast: server fault vs unreachable server", () => {
  it("a 5xx names the server's reference and never claims the server was unreachable", () => {
    const err = new ApiError("Internal server error", 500, "INTERNAL_ERROR")
    err.ref = "3f2a9c1b"
    const handling = decideErrorToast(err)
    expect(handling.toast.message).toContain("3f2a9c1b")
    expect(handling.toast.message).not.toMatch(/reach/i)
    expect(handling.toast.type).toBe("error")
  })

  it("a 5xx without a reference still says the server failed, not that it was unreachable", () => {
    const handling = decideErrorToast(new ApiError("Bad gateway", 502))
    expect(handling.toast.message).toMatch(/server hit an error/i)
    expect(handling.toast.message).not.toMatch(/reach/i)
  })

  it("status 0 (nothing reached) is still the offline message", () => {
    const handling = decideErrorToast(new ApiError("Network error", 0))
    expect(handling.toast.message).toMatch(/reach server/i)
  })
})

describe("decideErrorToast: an approve refused for its size", () => {
  // Prod: approving a sealed mail send with a PDF attached was refused 413 by
  // the API body cap, and the card said "could not be updated:
  // PAYLOAD_TOO_LARGE". The operator needs to know the attachments are the
  // problem and what to do about it.
  it("says the attachments are too large and how to get past it, on the card", () => {
    const handling = decideErrorToast(new ApiError("Payload Too Large", 413, "PAYLOAD_TOO_LARGE"))
    expect(handling.toast.message).toMatch(/too large/i)
    expect(handling.toast.message).toMatch(/attachment/i)
    expect(handling.toast.message).not.toMatch(/PAYLOAD_TOO_LARGE/)
    expect(handling.toast.type).toBe("error")
    expect(handling.inline).toBe(true)
  })
})

describe("the decision queue is the only way to send a decision", () => {
  // Every decide surface maps its own failure (decideErrorToast, inline
  // errors). A decide posted with plain api.post ALSO fires the global toast,
  // so the operator reads two different stories about one click.
  it("suppresses the global error toast", async () => {
    const calls: unknown[][] = []
    const api = {
      post: async (...args: unknown[]) => {
        calls.push(args)
        return { ok: true }
      },
    } as never
    await postDecision(api, "/approvals/x/decide", { decision: "approve" })
    expect(calls[0]?.[2]).toEqual({ suppressGlobalError: true })
  })

  // S15 / R1 (iPhone walk 2026-10-19): every approve and reject waits out the
  // Undo window, so the decision queue is the ONLY module that sends one. Home's
  // attention row used to post `/approvals/:id/decide` itself.
  it("no source file sends a decision except the decision queue", async () => {
    const { readdirSync, readFileSync, statSync } = await import("node:fs")
    const { join, relative } = await import("node:path")
    const root = join(__dirname, "..", "..")
    const allowed = new Set([
      join("modules", "approvals", "decide-error.ts"),
      join("modules", "approvals", "decision-queue.ts"),
    ])
    const offenders: string[] = []
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          if (name !== "node_modules" && name !== "tests") walk(full)
          continue
        }
        if (!/\.(ts|tsx)$/.test(name) || /\.test\.tsx?$/.test(name)) continue
        const rel = relative(root, full)
        if (allowed.has(rel)) continue
        const src = readFileSync(full, "utf8")
        const routesToDecide = /\/decide[`"']/.test(src)
        const sendsDecision = /postDecision\s*(<[^>]*>)?\s*\(/.test(src)
        if (routesToDecide || sendsDecision) offenders.push(rel)
      }
    }
    walk(root)
    expect(offenders).toEqual([])
  })
})
