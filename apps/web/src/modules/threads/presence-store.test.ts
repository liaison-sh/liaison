// SPDX-License-Identifier: FSL-1.1-ALv2
//
// HUMAN TYPING PRESENCE. The chain is: composer input -> `{type:"typing"}` on
// the socket -> server throttle -> `broadcastEphemeral` -> the `kernel:typing`
// websocket handler -> this store -> TypingIndicator.
//
// The store's entry has to OUTLIVE the gap between two broadcasts or someone
// who never stops typing still blinks out of the indicator. The server allows
// one broadcast per user per thread per 4 s and the composer offers one every
// 3 s, so the worst case gap between two delivered frames is 6 s: an entry
// that expired after 4 s left the indicator dark for a third of the time
// somebody was typing.
import { beforeEach, describe, expect, it } from "vitest"
import {
  getTypingUsers,
  handleTypingStart,
  resetPresenceStore,
} from "~/modules/threads/presence-store"

/** The server's own throttle window (WebSocketManager.TYPING_THROTTLE_MS). */
const SERVER_THROTTLE_MS = 4000
/** The composer's own offer interval (ComposeBar.handleInput). */
const COMPOSER_OFFER_MS = 3000
/**
 * The worst case gap between two DELIVERED frames. Offers land at 0, 3, 6, 9 s;
 * the server accepts one and drops every offer inside the next 4 s, so the one
 * at 3 s is dropped and the one at 6 s gets through: the first offer at or past
 * the throttle window is the next delivery.
 */
const WORST_CASE_GAP_MS = Math.ceil(SERVER_THROTTLE_MS / COMPOSER_OFFER_MS) * COMPOSER_OFFER_MS

describe("typing presence", () => {
  beforeEach(() => {
    resetPresenceStore()
  })

  it("a typing frame puts the other person's name in the thread", () => {
    handleTypingStart("t1", "elodie", "Elodie Vasseur")
    expect(getTypingUsers("t1", "me")).toEqual([
      { userId: "elodie", userName: "Elodie Vasseur", expiresAt: expect.any(Number) },
    ])
  })

  it("the viewer never sees their own typing", () => {
    handleTypingStart("t1", "me", "Me")
    expect(getTypingUsers("t1", "me")).toEqual([])
  })

  it("an entry outlives the worst case gap between two delivered frames", () => {
    handleTypingStart("t1", "elodie", "Elodie Vasseur")
    const entry = getTypingUsers("t1", "me")[0]
    expect(entry).toBeDefined()
    // Someone typing without pause is still typing when the next frame lands.
    expect(entry.expiresAt - Date.now()).toBeGreaterThan(WORST_CASE_GAP_MS)
  })

  it("a second frame from the same person extends rather than duplicates", () => {
    handleTypingStart("t1", "elodie", "Elodie Vasseur")
    const first = getTypingUsers("t1", "me")[0].expiresAt
    handleTypingStart("t1", "elodie", "Elodie Vasseur")
    const users = getTypingUsers("t1", "me")
    expect(users).toHaveLength(1)
    expect(users[0].expiresAt).toBeGreaterThanOrEqual(first)
  })

  it("two people typing in one thread are both named, and other threads are untouched", () => {
    handleTypingStart("t1", "elodie", "Elodie Vasseur")
    handleTypingStart("t1", "amina", "Amina Cherif")
    handleTypingStart("t2", "giulia", "Giulia Rossi")
    expect(
      getTypingUsers("t1", "me")
        .map((u) => u.userName)
        .sort(),
    ).toEqual(["Amina Cherif", "Elodie Vasseur"])
    expect(getTypingUsers("t2", "me")).toHaveLength(1)
  })

  it("an expired entry is gone", () => {
    handleTypingStart("t1", "elodie", "Elodie Vasseur")
    const entry = getTypingUsers("t1", "me")[0]
    // Reading past its expiry drops it without waiting on the sweep timer.
    const realNow = Date.now
    try {
      Date.now = () => entry.expiresAt + 1
      expect(getTypingUsers("t1", "me")).toEqual([])
    } finally {
      Date.now = realNow
    }
  })
})
