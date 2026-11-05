// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Pins the deliberate-sandbox-error classifier: an untrusted sandboxed handler's
// thrown message crosses the worker IPC as a bare STRING (no code/status), so
// execute-tool decides from the message SHAPE whether it is the app's own
// agent-facing typed error (`some_code: guidance…` — preserved, typed 422) or an
// incidental crash (redacted to "Tool execution failed" per the no-leak rule).
// Without this, a weak model that never sees WHY a write failed crash-loops the
// same doomed call for dozens of full-context steps.
import { describe, expect, it } from "bun:test"
import { classifyDeliberateSandboxError } from "~/modules/apps/execute-tool"

describe("classifyDeliberateSandboxError", () => {
  it("classifies snake_case-prefixed deliberate errors (the bundled-app convention)", () => {
    expect(
      classifyDeliberateSandboxError(
        "no_issuer_profile: no issuer profile configured for this org: create one in invoicing settings (settings_issuer_profile_create) before issuing any document",
      ),
    ).toBe("no_issuer_profile")
    expect(classifyDeliberateSandboxError("issuer_not_found: issuer_profile 6ce6… not found")).toBe(
      "issuer_not_found",
    )
    expect(classifyDeliberateSandboxError("duplicate: already in flight")).toBe("duplicate")
  })

  it("classifies tool-reference-prefixed guidance messages (colon, no space)", () => {
    // Boxtal's cross-app guidance: `invoicing:documents_get found no invoice for
    // "#1846" — shipment_draft_create needs the invoice's id (a UUID)…`. The
    // extracted code is imprecise ("invoicing") but the MESSAGE reaches the agent.
    expect(
      classifyDeliberateSandboxError(
        'invoicing:documents_get found no invoice for "#1846" — shipment_draft_create needs the invoice\'s id (a UUID), not its number/reference "#1846"; find the invoice with invoicing:documents_search and pass its id.',
      ),
    ).toBe("invoicing")
  })

  it("does NOT classify incidental crash shapes — they stay redacted", () => {
    // JS engine errors start uppercase.
    expect(classifyDeliberateSandboxError("TypeError: undefined is not a function")).toBeUndefined()
    expect(classifyDeliberateSandboxError("ReferenceError: x is not defined")).toBeUndefined()
    // Host-labeled sandbox failures carry no colon-terminated snake_case prefix.
    expect(classifyDeliberateSandboxError("App execution timed out")).toBeUndefined()
    expect(classifyDeliberateSandboxError("Unknown sandbox error")).toBeUndefined()
    // A space before the colon breaks the prefix shape.
    expect(classifyDeliberateSandboxError("unexpected token: '}'")).toBeUndefined()
    // Node/system error codes are uppercase.
    expect(classifyDeliberateSandboxError("ENOENT: no such file or directory")).toBeUndefined()
    // Bare or colon-less messages.
    expect(classifyDeliberateSandboxError("boom")).toBeUndefined()
    expect(classifyDeliberateSandboxError("")).toBeUndefined()
    // Colon with nothing after it — no payload to surface.
    expect(classifyDeliberateSandboxError("some_code:")).toBeUndefined()
    // Prefix too short (min 3 chars) — avoids matching stray "x: y" shapes.
    expect(classifyDeliberateSandboxError("ab: too short")).toBeUndefined()
  })
})
