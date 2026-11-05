// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import {
  AGENT_NOTICE_DETAIL_MAX,
  AGENT_NOTICE_STORED_LINES,
  agentNoticeCode,
  agentNoticeDetail,
  agentNoticeStoredText,
  classifyProviderError,
  localizeAgentNotice,
  safeAgentNoticeDetail,
} from "./agent-notice"

const GEMINI_CAP =
  "Your project has exceeded its monthly spending cap. Please go to AI Studio at https://ai.studio/spend to manage your project spend cap."
const LEGACY = `⚠️ I couldn't complete that response — the AI provider returned an error:\n\n${GEMINI_CAP}`

describe("agent notice", () => {
  it("classifies the provider's text", () => {
    expect(classifyProviderError(GEMINI_CAP)).toBe("provider_quota")
    expect(classifyProviderError("insufficient_quota")).toBe("provider_quota")
    expect(classifyProviderError("429 Too Many Requests")).toBe("provider_rate_limited")
    expect(classifyProviderError("Request contains an invalid argument.")).toBe("provider_error")
    expect(classifyProviderError(null)).toBe("provider_error")
  })

  it("no stored line quotes the provider", () => {
    for (const line of Object.values(AGENT_NOTICE_STORED_LINES)) {
      expect(line).not.toContain("AI Studio")
      expect(agentNoticeCode(line)).not.toBeNull()
    }
  })

  it("reads the persisted code first, then the stored line, then an older row's prefix", () => {
    expect(agentNoticeCode("anything", { agentNotice: "provider_rate_limited" })).toBe(
      "provider_rate_limited",
    )
    expect(agentNoticeCode("x", { agentNotice: "constructor" })).toBeNull()
    expect(agentNoticeCode(AGENT_NOTICE_STORED_LINES.provider_error)).toBe("provider_error")
    expect(agentNoticeCode(AGENT_NOTICE_STORED_LINES.provider_quota)).toBe("provider_quota")
    expect(agentNoticeCode(LEGACY)).toBe("provider_quota")
    expect(agentNoticeCode("⚠️ Credits ran out before I could finish this response. Add")).toBe(
      "credits_exhausted",
    )
    expect(agentNoticeCode("Voici un aperçu")).toBeNull()
  })

  it("reads the failure's own detail from a row written now and from an older row", () => {
    expect(agentNoticeDetail(LEGACY)).toBe(GEMINI_CAP)
    expect(agentNoticeDetail(AGENT_NOTICE_STORED_LINES.provider_quota)).toBeNull()
    const stored = agentNoticeStoredText("Upstream returned 400: context too long")
    expect(stored).toBe(
      `${AGENT_NOTICE_STORED_LINES.provider_error}\n\nUpstream returned 400: context too long`,
    )
    expect(agentNoticeCode(stored)).toBe("provider_error")
    expect(agentNoticeDetail(stored)).toBe("Upstream returned 400: context too long")
    expect(agentNoticeStoredText(null)).toBe(AGENT_NOTICE_STORED_LINES.provider_error)
    expect(
      agentNoticeDetail(
        "⚠️ I stopped before writing a final answer (stop reason: tool-calls). I completed 3 tool calls before stopping; that work is preserved above. Ask me to continue.",
      ),
    ).toBe("stop reason: tool-calls; I completed 3 tool calls before stopping.")
  })

  it("shows a detail without its stack or a secret, and bounded", () => {
    const err = "Incorrect API key provided: sk-proj-abcd1234efgh\n    at call (provider.ts:10:3)"
    expect(safeAgentNoticeDetail(err)).toBe("Incorrect API key provided: [redacted]")
    expect(safeAgentNoticeDetail("x".repeat(5_000))?.length).toBe(AGENT_NOTICE_DETAIL_MAX + 1)
    expect(safeAgentNoticeDetail("   ")).toBeNull()
  })

  it("localizes through the surface's translator", () => {
    const t = (key: string) => `<${key}>`
    expect(localizeAgentNotice(LEGACY, t)).toBe("⚠️ <kernel.agentNotice.providerSpendCap>")
    expect(localizeAgentNotice("plain", t)).toBe("plain")
  })

  it("puts the failure's detail under the line in the conversation, never in a summary", () => {
    const t = (key: string) => `<${key}>`
    const detail = "This demo budget is used up for this email."
    const stored = agentNoticeStoredText(detail)
    const meta = { agentNotice: "provider_error" }
    expect(localizeAgentNotice(stored, t, meta, { withDetail: true })).toBe(
      `⚠️ <kernel.agentNotice.providerError>\n\n${detail}`,
    )
    expect(localizeAgentNotice(stored, t, meta)).toBe("⚠️ <kernel.agentNotice.providerError>")
    // An older row that kept its detail only in metadata.error.
    expect(
      localizeAgentNotice(
        AGENT_NOTICE_STORED_LINES.provider_error,
        t,
        { agentNotice: "provider_error", error: "Upstream 502" },
        { withDetail: true },
      ),
    ).toBe("⚠️ <kernel.agentNotice.providerError>\n\nUpstream 502")
    expect(localizeAgentNotice(LEGACY, t, null, { withDetail: true })).toBe(
      `⚠️ <kernel.agentNotice.providerSpendCap>\n\n${GEMINI_CAP}`,
    )
  })
})
