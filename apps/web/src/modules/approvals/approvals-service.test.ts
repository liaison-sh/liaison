// SPDX-License-Identifier: FSL-1.1-ALv2
import { describe, expect, it, vi } from "vitest"
import { decideApproval, getApproval, listDecidableByMe, updatePayload } from "./approvals-service"

const summary = { id: "ar-1", handle: "request-0001", status: "pending" } as any

describe("approvals service", () => {
  it("listDecidableByMe builds the correct query string and returns the array", async () => {
    const get = vi.fn().mockResolvedValue([summary])
    const api: any = { get }
    const result = await listDecidableByMe(api)
    expect(get).toHaveBeenCalledWith("/approvals?status=pending&decidableByMe=true")
    expect(result).toEqual([summary])
  })

  it("listDecidableByMe returns [] when api returns undefined", async () => {
    const get = vi.fn().mockResolvedValue(undefined)
    const api: any = { get }
    expect(await listDecidableByMe(api)).toEqual([])
  })

  it("getApproval fetches the request by id", async () => {
    const get = vi.fn().mockResolvedValue(summary)
    const api: any = { get }
    const result = await getApproval(api, "ar-1")
    expect(get).toHaveBeenCalledWith("/approvals/ar-1")
    expect(result).toEqual(summary)
  })

  it("decideApproval posts approve without a reason", async () => {
    const post = vi.fn().mockResolvedValue({ id: "ar-1", status: "approved" })
    const api: any = { post }
    await decideApproval(api, "ar-1", { decision: "approve" })
    expect(post).toHaveBeenCalledWith(
      "/approvals/ar-1/decide",
      { decision: "approve" },
      { suppressGlobalError: true },
    )
  })

  it("decideApproval posts deny with a reason", async () => {
    const post = vi.fn().mockResolvedValue({ id: "ar-1", status: "denied" })
    const api: any = { post }
    await decideApproval(api, "ar-1", { decision: "deny", reason: "no" })
    expect(post).toHaveBeenCalledWith(
      "/approvals/ar-1/decide",
      { decision: "deny", reason: "no" },
      { suppressGlobalError: true },
    )
  })

  it("updatePayload posts the fields object", async () => {
    const post = vi.fn().mockResolvedValue({ id: "ar-1", currentPayload: { subject: "x" } })
    const api: any = { post }
    await updatePayload(api, "ar-1", { subject: "x" })
    expect(post).toHaveBeenCalledWith("/approvals/ar-1/payload", { fields: { subject: "x" } })
  })
})
