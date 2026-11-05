// SPDX-License-Identifier: FSL-1.1-ALv2
// A gated tool's preflight may PIN server-derived params onto the staged call
// (`pinnedParams`): they overwrite whatever the caller passed under those
// keys, so the approval card and the execution both read the server's value.
import { describe, expect, it } from "bun:test"
import { applyPreflightCanonicalParams } from "~/modules/apps/execute-tool"

describe("applyPreflightCanonicalParams: pinnedParams", () => {
  it("sets a pinned param, overwriting a caller-supplied one", () => {
    const params = { connection: "crm", target: { host: "forged.example" } }
    const pinned = { method: "POST", host: "crm.example.com", path: "/notes", adapterHash: "h" }
    const out = applyPreflightCanonicalParams(params, {
      ok: true,
      pinnedParams: { target: pinned },
    })
    expect(out).toEqual({ connection: "crm", target: pinned })
    expect(params.target).toEqual({ host: "forged.example" })
  })

  it("adds a pinned param the caller left out", () => {
    const out = applyPreflightCanonicalParams(
      { connection: "crm" },
      { ok: true, pinnedParams: { target: { host: "crm.example.com" } } },
    )
    expect(out).toEqual({ connection: "crm", target: { host: "crm.example.com" } })
  })

  it("ignores pinnedParams on a result that is not ok, or that is not an object", () => {
    const params = { connection: "crm" }
    expect(applyPreflightCanonicalParams(params, { pinnedParams: { target: { x: 1 } } })).toBe(
      params,
    )
    expect(applyPreflightCanonicalParams(params, { ok: true, pinnedParams: ["x"] })).toBe(params)
  })
})
