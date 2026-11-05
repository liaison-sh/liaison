// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pure UI-logic tests for the social surfaces (bun:test, no jsdom). Pins that
// each manifest-named component imports cleanly under the host shim and that the
// extracted pure helpers cover their branches — including the two states the B9
// checkpoint calls out: the closed-window compose replacement and the greyed
// (unsupported) Like.

import { describe, expect, test } from "bun:test"
import { ConversationDetailPanel, Messages, messageBubbleText, windowPillState } from "./Messages"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  canReply,
  FindingDetailPanel,
  gatedResultNote,
  Findings,
  splitPaneClasses,
  likeDisabled,
  findingStatusTone,
  authorLabel,
  isVideoMatch,
  matchedTermsOf,
  platformLabel,
  postExcerptOf,
  shortTime,
} from "./Findings"
import { cadenceLabel, Watched } from "./Watched"
import { decidePath, denyPendingApproval, rejectNote, SOCIAL_DECIDABLE_APPROVALS_PATH } from "./pending-approval"
import { SocialQuota } from "./Quota"
import { SocialAppIcon } from "./icon"
import { SocialSidebar } from "./sidebar"
import { stripExternalFence } from "./kit"

describe("manifest-named surfaces import cleanly as components", () => {
  test("every surface/panel/icon/sidebar is a function component", () => {
    for (const c of [
      Findings,
      FindingDetailPanel,
      Messages,
      ConversationDetailPanel,
      Watched,
      SocialQuota,
      SocialAppIcon,
      SocialSidebar,
    ]) {
      expect(typeof c).toBe("function")
    }
  })
})

describe("windowPillState (B9 — closed-window compose replacement)", () => {
  test("open window (≤24h) → compose enabled, no fallback", () => {
    const now = new Date("2026-06-01T12:00:00Z")
    const s = windowPillState("2026-06-01T06:00:00Z", now)
    expect(s.tag).toBe("none")
    expect(s.composeEnabled).toBe(true)
    expect(s.showFallback).toBe(false)
  })
  test("human-agent window (≤7d) → compose enabled, tagged human_agent", () => {
    const now = new Date("2026-06-04T12:00:00Z")
    const s = windowPillState("2026-06-01T12:00:00Z", now)
    expect(s.tag).toBe("human_agent")
    expect(s.composeEnabled).toBe(true)
  })
  test("closed window (>7d) → compose REPLACED by native-app fallback", () => {
    const now = new Date("2026-06-10T12:00:00Z")
    const s = windowPillState("2026-06-01T12:00:00Z", now)
    expect(s.tag).toBe("closed")
    expect(s.composeEnabled).toBe(false)
    expect(s.showFallback).toBe(true)
  })
  test("no inbound at all → closed (fallback)", () => {
    const s = windowPillState(null, new Date())
    expect(s.tag).toBe("closed")
    expect(s.showFallback).toBe(true)
  })
})

describe("messageBubbleText (B: snippet/thread honesty for empty-body attachments)", () => {
  test("empty-string body (Graph API omits `message` on attachments/stickers) → muted '[attachment]'", () => {
    const b = messageBubbleText("")
    expect(b.text).toBe("[attachment]")
    expect(b.muted).toBe(true)
  })
  test("a real non-empty body renders as-is, not muted", () => {
    const b = messageBubbleText("hello there")
    expect(b.text).toBe("hello there")
    expect(b.muted).toBe(false)
  })
  test("null/undefined body → muted '(no text)' (defensive, distinct from the attachment case)", () => {
    expect(messageBubbleText(null)).toEqual({ text: "(no text)", muted: true })
    expect(messageBubbleText(undefined)).toEqual({ text: "(no text)", muted: true })
  })
})

describe("likeDisabled (B9 — greyed Like for unsupported relation)", () => {
  test("enabled for own-Page FB / own-media IG comments", () => {
    expect(likeDisabled("facebook", "comment_on_our_content")).toBe(false)
    expect(likeDisabled("instagram", "comment_on_our_content")).toBe(false)
  })
  test("disabled (greyed) for unsupported targets", () => {
    expect(likeDisabled("instagram", "mention_in_post")).toBe(true)
    expect(likeDisabled("youtube", "comment_on_our_content")).toBe(true)
    expect(likeDisabled("facebook", "mention")).toBe(true)
  })
})

describe("findingStatusTone", () => {
  test("maps lifecycle statuses to tones", () => {
    expect(findingStatusTone("awaiting_approval").tone).toBe("warning")
    expect(findingStatusTone("handled").tone).toBe("success")
    expect(findingStatusTone("dismissed").tone).toBe("neutral")
    expect(findingStatusTone("new").tone).toBe("accent")
  })
})

describe("canReply (reply composer gate — humans can always reply on live findings)", () => {
  test("shows for any non-terminal finding, triaged or not", () => {
    expect(canReply({ status: "awaiting_approval" })).toBe(true)
    expect(canReply({ status: "drafted" })).toBe(true)
    expect(canReply({ status: "triaged", suggested_reply: "Thanks!" })).toBe(true)
    expect(canReply({ status: "triaged", should_reply: true })).toBe(true)
    // A human must be able to comment directly without waiting for agent
    // triage — brand-new and not-flagged findings are repliable too.
    expect(canReply({ status: "new" })).toBe(true)
    expect(canReply({ status: "new", should_reply: false })).toBe(true)
    expect(canReply({ status: "triaged", should_reply: false })).toBe(true)
  })
  test("hides only for terminal findings", () => {
    expect(canReply({ status: "handled", suggested_reply: "x" })).toBe(false)
    expect(canReply({ status: "dismissed" })).toBe(false)
    expect(canReply({ status: "failed", should_reply: true })).toBe(false)
    expect(canReply(null)).toBe(false)
  })
})

describe("cadenceLabel (B9 — watch cadence pills)", () => {
  test("maps cadence seconds + status to HOT/WARM/COOL/DECAYED", () => {
    expect(cadenceLabel("active", 300)).toBe("HOT")
    expect(cadenceLabel("active", 3600)).toBe("WARM")
    expect(cadenceLabel("active", 86400)).toBe("COOL")
    expect(cadenceLabel("decayed", 86400)).toBe("DECAYED")
  })
})

describe("stripExternalFence (untrusted-content fence — display, not the agent)", () => {
  test("strips the <external-content source=\"untrusted\"> wrapper", () => {
    const fenced = '<external-content source="untrusted">\nIs this in stock?\n</external-content>'
    expect(stripExternalFence(fenced)).toBe("Is this in stock?")
  })
  test("tolerant: unfenced content is returned unchanged", () => {
    expect(stripExternalFence("plain text")).toBe("plain text")
  })
  test("null/undefined → empty string", () => {
    expect(stripExternalFence(null)).toBe("")
    expect(stripExternalFence(undefined)).toBe("")
  })
})

describe("platformLabel / postExcerptOf / shortTime (Findings UX — comment stream)", () => {
  test("authorLabel falls back to '<Platform> user' when the API withholds identity", () => {
    expect(authorLabel("facebook", null)).toBe("Facebook user")
    expect(authorLabel("facebook", "")).toBe("Facebook user")
    expect(authorLabel("youtube", undefined)).toBe("YouTube user")
    expect(authorLabel("instagram", "someone")).toBe("someone")
  })

  test("platformLabel maps platform ids to display names", () => {
    expect(platformLabel("facebook")).toBe("Facebook")
    expect(platformLabel("instagram")).toBe("Instagram")
    expect(platformLabel("youtube")).toBe("YouTube")
  })
  test("postExcerptOf reads metadata.postExcerpt when present", () => {
    expect(postExcerptOf({ metadata: { postExcerpt: "Check out our new arrivals!" } })).toBe(
      "Check out our new arrivals!",
    )
    expect(postExcerptOf({ metadata: {} })).toBeNull()
    expect(postExcerptOf(null)).toBeNull()
  })
  test("shortTime renders compact relative time", () => {
    const now = new Date("2026-06-10T12:00:00Z")
    expect(shortTime("2026-06-10T11:59:30Z", now)).toBe("now")
    expect(shortTime("2026-06-10T11:30:00Z", now)).toBe("30m")
    expect(shortTime("2026-06-10T06:00:00Z", now)).toBe("6h")
    expect(shortTime("2026-06-05T12:00:00Z", now)).toBe("5d")
    expect(shortTime(null, now)).toBe("")
  })
})

describe("isVideoMatch / matchedTermsOf (keyword_match VIDEO presentation)", () => {
  test("isVideoMatch is true only for keyword_match relation", () => {
    expect(isVideoMatch("keyword_match")).toBe(true)
    expect(isVideoMatch("comment_on_our_content")).toBe(false)
    expect(isVideoMatch("mention")).toBe(false)
    expect(isVideoMatch("mention_in_post")).toBe(false)
  })
  test("matchedTermsOf reads metadata.matchedTerms (string array)", () => {
    expect(matchedTermsOf({ metadata: { matchedTerms: ["term-1", "term-2"] } })).toEqual([
      "term-1",
      "term-2",
    ])
    expect(matchedTermsOf({ metadata: {} })).toEqual([])
    expect(matchedTermsOf({ metadata: { matchedTerms: "not-an-array" } })).toEqual([])
    expect(matchedTermsOf(null)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────
// Phone width (spec-responsive.md): Findings is a master/detail split, and a
// 320 px list beside a detail pane leaves the detail 70 px at 390 px. On a
// phone the panes take turns: the list owns the viewport until a finding is
// picked, then the detail does, with a back control to return.
// ─────────────────────────────────────────────────────────────────────────
describe("findings split panes at phone width", () => {
  const findingsSource = readFileSync(join(import.meta.dir, "Findings.tsx"), "utf8")

  test("gives the list the phone viewport until a finding is picked", () => {
    expect(splitPaneClasses(false).list).toContain("flex")
    expect(splitPaneClasses(false).list).not.toContain("hidden")
    expect(splitPaneClasses(false).detail).toContain("hidden md:flex")
  })

  test("hands the phone viewport to the detail once a finding is picked", () => {
    expect(splitPaneClasses(true).list).toContain("hidden md:flex")
    expect(splitPaneClasses(true).detail).toContain("flex")
    expect(splitPaneClasses(true).detail).not.toContain("hidden")
  })

  test("keeps the list at its own width from md up in both states", () => {
    expect(splitPaneClasses(false).list).toContain("md:w-80")
    expect(splitPaneClasses(true).list).toContain("md:w-80")
  })

  test("wires the panes and a phone back control into the findings screen", () => {
    expect(findingsSource).toContain("splitPaneClasses(")
    expect(findingsSource).toContain("social-findings-back")
    expect(findingsSource).toContain("min-h-11")
  })
})

describe("gatedResultNote", () => {
  test("a reply that ran says it was posted, a parked one says it awaits approval", () => {
    expect(gatedResultNote({ ok: true }, "Reply posted.", "Reply submitted for approval.")).toBe(
      "Reply posted.",
    )
    expect(gatedResultNote(null, "Reply posted.", "Reply submitted for approval.")).toBe(
      "Reply posted.",
    )
    expect(
      gatedResultNote(
        { blocked: { reason: "approval_required", approvalRequestId: "a1" } },
        "Reply posted.",
        "Reply submitted for approval.",
      ),
    ).toBe("Reply submitted for approval.")
  })
})

describe("denyPendingApproval (Reject and a direct reply settle the agent's request)", () => {
  const recorder = (decidable: Array<{ id: string }>) => {
    const calls: Array<{ path: string; init?: RequestInit }> = []
    const fetch = (async (path: string, init?: RequestInit) => {
      calls.push({ path, init })
      return path === SOCIAL_DECIDABLE_APPROVALS_PATH ? decidable : { status: "denied" }
    }) as never
    return { calls, fetch }
  }

  test("denies the request when the caller may decide it", async () => {
    const { calls, fetch } = recorder([{ id: "other" }, { id: "a-1" }])
    expect(await denyPendingApproval(fetch, "a-1", "Rejected from the finding.")).toBe("denied")
    expect(calls).toHaveLength(2)
    expect(calls[1]?.path).toBe("/api/approvals/a-1/decide")
    expect(calls[1]?.init?.method).toBe("POST")
    expect(JSON.parse(String(calls[1]?.init?.body))).toEqual({ decision: "deny", reason: "Rejected from the finding." })
  })

  test("leaves a request the caller can't decide alone, posting no decision", async () => {
    const { calls, fetch } = recorder([{ id: "other" }])
    expect(await denyPendingApproval(fetch, "a-1", "x")).toBe("not_decidable")
    expect(calls.map((c) => c.path)).toEqual([SOCIAL_DECIDABLE_APPROVALS_PATH])
  })

  test("the decidable feed is narrowed to this app's pending requests", () => {
    expect(SOCIAL_DECIDABLE_APPROVALS_PATH).toContain("app=social")
    expect(SOCIAL_DECIDABLE_APPROVALS_PATH).toContain("decidableByMe=true")
    expect(decidePath("a/b")).toBe("/api/approvals/a%2Fb/decide")
  })

  test("rejectNote says what happened to the agent's draft", () => {
    expect(rejectNote(null)).toBe("Finding dismissed.")
    expect(rejectNote("denied")).toContain("draft rejected")
    expect(rejectNote("not_decidable")).toContain("still waiting in the approvals inbox")
  })
})
