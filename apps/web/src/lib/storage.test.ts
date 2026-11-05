// SPDX-License-Identifier: FSL-1.1-ALv2
import { beforeEach, describe, expect, it } from "vitest"
import { clearLiaisonStorage } from "./storage"

beforeEach(() => localStorage.clear())

describe("clearLiaisonStorage", () => {
  it("removes all liaison:-prefixed keys", () => {
    localStorage.setItem("liaison:tabs", '{"tabs":[]}')
    localStorage.setItem("liaison:agentPanelOpen", "true")
    localStorage.setItem("liaison:lastEventId:org1:user1", "42")
    localStorage.setItem("liaison:session", "1")
    localStorage.setItem("unrelated-key", "keep")

    clearLiaisonStorage()

    expect(localStorage.getItem("liaison:tabs")).toBeNull()
    expect(localStorage.getItem("liaison:agentPanelOpen")).toBeNull()
    expect(localStorage.getItem("liaison:lastEventId:org1:user1")).toBeNull()
    expect(localStorage.getItem("liaison:session")).toBeNull()
    expect(localStorage.getItem("unrelated-key")).toBe("keep")
  })

  it("handles empty localStorage", () => {
    clearLiaisonStorage()
    expect(localStorage.length).toBe(0)
  })

  it("handles localStorage with only non-liaison keys", () => {
    localStorage.setItem("other", "value")
    clearLiaisonStorage()
    expect(localStorage.getItem("other")).toBe("value")
  })

  it("does not remove 'liaison' key without colon prefix", () => {
    localStorage.setItem("liaison", "keep")
    localStorage.setItem("liaison:session", "1")
    clearLiaisonStorage()
    expect(localStorage.getItem("liaison")).toBe("keep")
    expect(localStorage.getItem("liaison:session")).toBeNull()
  })
})
