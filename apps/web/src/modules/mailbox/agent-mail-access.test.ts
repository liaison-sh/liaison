// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The assistant-mail switch reaches the holder's other devices, and the relay
// (the server) cannot turn the assistant ON: an "on" applies only with a MAC
// under the mailbox key, an "off" applies as is, an older change never wins.
import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  agentMailAccessEnabled,
  agentMailAccessState,
  agentMailAccessStatement,
  applyRemoteAgentMailAccess,
  publishAgentMailAccess,
  setAgentMailAccessEnabled,
  signAgentMailAccess,
} from "~/modules/mailbox/agent-mail-access"

const USER = "user-1"
/** A stand-in for the worker's HMAC: deterministic, keyed by a secret the relay lacks. */
const crypto = {
  ledgerMac: vi.fn(async (statements: readonly string[]) =>
    statements.map((s) => btoa(`key:${s}`)),
  ),
}
const unlocked = { userId: USER, crypto }
const locked = { userId: USER, crypto: null }

beforeEach(() => {
  localStorage.clear()
  crypto.ledgerMac.mockClear()
  setAgentMailAccessEnabled(true, 1)
})

describe("applyRemoteAgentMailAccess", () => {
  it("applies a newer OFF with no proof, and the settings pane follows", async () => {
    expect(await applyRemoteAgentMailAccess({ enabled: false, at: 100 }, locked)).toBe(true)
    expect(agentMailAccessEnabled()).toBe(false)
    expect(agentMailAccessState()).toBe(false)
  })

  it("never applies an ON the relay could have forged", async () => {
    setAgentMailAccessEnabled(false, 10)
    expect(await applyRemoteAgentMailAccess({ enabled: true, at: 100 }, unlocked)).toBe(false)
    expect(
      await applyRemoteAgentMailAccess({ enabled: true, at: 100, mac: "Zm9yZ2Vk" }, unlocked),
    ).toBe(false)
    expect(agentMailAccessEnabled()).toBe(false)
  })

  it("applies an ON whose MAC verifies, only while the mailbox is unlocked", async () => {
    setAgentMailAccessEnabled(false, 10)
    const mac = btoa(`key:${agentMailAccessStatement(USER, true, 100)}`)
    expect(await applyRemoteAgentMailAccess({ enabled: true, at: 100, mac }, locked)).toBe(false)
    expect(agentMailAccessEnabled()).toBe(false)
    expect(await applyRemoteAgentMailAccess({ enabled: true, at: 100, mac }, unlocked)).toBe(true)
    expect(agentMailAccessEnabled()).toBe(true)
  })

  it("an ON signed for another time does not verify (no replay onto a newer choice)", async () => {
    setAgentMailAccessEnabled(false, 10)
    const macForOldTime = btoa(`key:${agentMailAccessStatement(USER, true, 50)}`)
    expect(
      await applyRemoteAgentMailAccess({ enabled: true, at: 100, mac: macForOldTime }, unlocked),
    ).toBe(false)
  })

  it("ignores a change older than this device's own", async () => {
    setAgentMailAccessEnabled(false, 500)
    const mac = btoa(`key:${agentMailAccessStatement(USER, true, 400)}`)
    expect(await applyRemoteAgentMailAccess({ enabled: true, at: 400, mac }, unlocked)).toBe(false)
    expect(agentMailAccessEnabled()).toBe(false)
  })

  it("reads the first storage format (a bare on/off) as a choice with no time", async () => {
    localStorage.setItem("liaison.mailbox.agentMailAccess", "off")
    expect(agentMailAccessEnabled()).toBe(false)
    expect(await applyRemoteAgentMailAccess({ enabled: false, at: 1 }, locked)).toBe(true)
  })
})

describe("relaying a local change", () => {
  it("an OFF is always relayed, an ON only when the unlocked mailbox signs it", async () => {
    const off = setAgentMailAccessEnabled(false, 1_000)
    expect(await signAgentMailAccess(off, locked)).toEqual({ enabled: false, at: off.at })
    const on = setAgentMailAccessEnabled(true, 2_000)
    expect(await signAgentMailAccess(on, locked)).toBeNull()
    const signed = await signAgentMailAccess(on, unlocked)
    expect(signed).toEqual({
      enabled: true,
      at: on.at,
      mac: btoa(`key:${agentMailAccessStatement(USER, true, on.at)}`),
    })

    const api = { get: vi.fn(), put: vi.fn() }
    await publishAgentMailAccess(api, on, locked)
    expect(api.put).not.toHaveBeenCalled()
    await publishAgentMailAccess(api, on, unlocked)
    expect(api.put).toHaveBeenCalledWith("/user/preferences/agent-mail-access", signed)
  })

  it("a local change is always newer than what this device holds, whatever the clock", () => {
    setAgentMailAccessEnabled(false, 5_000)
    const next = setAgentMailAccessEnabled(true, 10)
    expect(next.at).toBe(5_001)
  })
})
