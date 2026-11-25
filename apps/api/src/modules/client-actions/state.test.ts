// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it } from "bun:test"
import { type ClientActionStateRow, clientActionState } from "./state"

const NOW = new Date(Date.UTC(2026, 10, 9, 10))
const later = new Date(NOW.getTime() + 60_000)
const earlier = new Date(NOW.getTime() - 60_000)

const open: ClientActionStateRow = {
  revokedAt: null,
  decidedAt: null,
  decision: null,
  expiresAt: later,
  codeLockedAt: null,
  hasToken: true,
}

describe("clientActionState", () => {
  it("an action with a token, not expired, locked, decided or revoked is open", () => {
    expect(clientActionState(open, NOW)).toBe("open")
  })
  it("without a token it waits for its turn", () => {
    expect(clientActionState({ ...open, hasToken: false }, NOW)).toBe("waiting_turn")
  })
  it("a lock wins over waiting and over open", () => {
    expect(clientActionState({ ...open, codeLockedAt: earlier, hasToken: false }, NOW)).toBe(
      "locked",
    )
  })
  it("expiry at the exact instant counts as expired, and wins over a lock", () => {
    expect(clientActionState({ ...open, expiresAt: NOW }, NOW)).toBe("expired")
    expect(clientActionState({ ...open, expiresAt: earlier, codeLockedAt: earlier }, NOW)).toBe(
      "expired",
    )
  })
  it("a decision wins over expiry: a signed action stays signed after its date", () => {
    expect(
      clientActionState(
        { ...open, decidedAt: earlier, decision: "signed", expiresAt: earlier },
        NOW,
      ),
    ).toBe("signed")
    expect(clientActionState({ ...open, decidedAt: earlier, decision: "declined" }, NOW)).toBe(
      "declined",
    )
  })
  it("revoked wins over everything else", () => {
    expect(clientActionState({ ...open, revokedAt: earlier, expiresAt: earlier }, NOW)).toBe(
      "revoked",
    )
  })
  it("a decided row without its decision is a broken row, not a state", () => {
    expect(() => clientActionState({ ...open, decidedAt: earlier }, NOW)).toThrow()
  })
})
