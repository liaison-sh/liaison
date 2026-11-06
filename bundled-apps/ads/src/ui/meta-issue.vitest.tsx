// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What a person sees when Meta throttles or refuses a read, rendered on the
// real ads screens. The rejection is built the way production builds it: a
// Meta Graph error envelope goes through metaFetch and the app's ToolError
// mapping, then crosses the host as the web client's ApiError (message, code,
// status). The screens must say what happened in plain words, never a generic
// failure, and never show the agent's "Next step" line.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { createResource } from "solid-js"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { metaUpstreamToolError } from "../lib/get-client"
import { metaFetch } from "../lib/meta-client"

type Answer = { reject: unknown } | { resolve: unknown }
const answers = new Map<string, Answer>()

vi.mock("@liaison/host", () => ({
  app: {
    invokeTool: (name: string) => {
      const a = answers.get(name)
      if (!a) return Promise.resolve({ data: [] })
      return "reject" in a ? Promise.reject(a.reject) : Promise.resolve(a.resolve)
    },
    createResource: (fetcher: () => unknown) => createResource(fetcher),
    openConnect: async () => {},
    trackOpenRecord: () => {},
  },
  navigate: () => {},
}))

class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message)
    this.name = "ApiError"
  }
}

/** The ApiError the ads UI receives for a given Meta Graph error answer. */
async function apiErrorFor(httpStatus: number, graphError: Record<string, unknown>): Promise<ApiError> {
  const fetch = async () => ({ status: httpStatus, headers: {}, body: JSON.stringify({ error: graphError }) })
  const err = await metaFetch(fetch, { path: "/act_1", accessToken: "t" }).catch((e) => e)
  const tool = metaUpstreamToolError(err)
  if (!tool) throw new Error("expected a ToolError mapping")
  return new ApiError(tool.message, tool.status, tool.code)
}

const THROTTLE = { code: 80000, error_subcode: 2446079, message: "There have been too many calls", fbtrace_id: "FB1" }
const DENIED = { code: 10, message: "(#10) Application does not have permission for this action", fbtrace_id: "FB2" }

const THROTTLE_TEXT = "Meta is limiting requests right now. Try again in a few minutes."
const DENIED_TEXT =
  "Meta did not allow this request: (#10) Application does not have permission for this action. " +
  "The Meta app may be missing a permission."

beforeEach(() => answers.clear())
afterEach(() => cleanup())

describe("Campaigns tab", () => {
  it("a Meta throttle reads as a throttle with a Retry, not as a missing connection", async () => {
    const err = await apiErrorFor(400, THROTTLE)
    answers.set("account_info", { reject: err })
    answers.set("campaigns_list", { reject: err })
    const { CampaignsTab } = await import("./Campaigns")
    render(() => <CampaignsTab />)
    const note = await screen.findByTestId("ads-campaigns-issue")
    expect(note.textContent).toBe(`${THROTTLE_TEXT}Retry`)
    expect(screen.queryByText(/No Meta Ads connection/)).toBeNull()
    expect(document.body.textContent).not.toMatch(/Next step|unknown error|Tool execution failed|Something went wrong/i)
  })

  it("a Meta permission refusal names Meta's reason and offers no Retry", async () => {
    const err = await apiErrorFor(403, DENIED)
    answers.set("account_info", { resolve: { id: "act_1", name: "Acct", currency: "EUR" } })
    answers.set("campaigns_list", { reject: err })
    const { CampaignsTab } = await import("./Campaigns")
    render(() => <CampaignsTab />)
    const note = await screen.findByTestId("ads-campaigns-issue")
    expect(note.textContent).toBe(DENIED_TEXT)
    expect(note.getAttribute("role")).toBe("alert")
  })
})

describe("Settings: account status, Meta card", () => {
  it("a permission refusal on the account read says so instead of 'Not connected'", async () => {
    answers.set("account_info", { reject: await apiErrorFor(403, DENIED) })
    answers.set("google_account_info", { resolve: { error: { code: "google_not_connected", message: "x" } } })
    answers.set("merchant_feed_status", { resolve: { error: { code: "google_not_connected", message: "x" } } })
    const { AdsAccountStatus } = await import("./AccountStatus")
    render(() => <AdsAccountStatus />)
    const card = await screen.findByTestId("ads-settings-status")
    await vi.waitFor(() => expect(card.textContent).toContain(DENIED_TEXT))
    expect(card.textContent).not.toContain("Not connected")
  })
})

describe("Settings: account status, Google and Merchant cards", () => {
  it("each arm reads its own status and offers no connect button (the connections block does)", async () => {
    answers.set("account_info", { resolve: { id: "act_1", name: "Studio", currency: "EUR", account_status: 1 } })
    answers.set("google_account_info", { resolve: { error: { code: "google_not_connected", message: "Google account not authorized yet" } } })
    answers.set("merchant_feed_status", { resolve: { error: { code: "merchant_not_configured", message: "x" } } })
    const { AdsAccountStatus } = await import("./AccountStatus")
    render(() => <AdsAccountStatus />)
    await vi.waitFor(() => expect(screen.getByTestId("ads-settings-status").textContent).toContain("Studio · EUR"))
    expect(screen.getByTestId("ads-settings-google").textContent).toContain("Not connected")
    expect(screen.getByTestId("ads-settings-merchant").textContent).toContain("Optional")
    expect(screen.queryByTestId("ads-settings-google-connect")).toBeNull()
    expect(screen.queryByTestId("ads-settings-meta-credentials")).toBeNull()
  })
})

describe("Ads tab", () => {
  it("a throttle on the ads list says Meta is limiting requests, with a Retry", async () => {
    answers.set("ads_list", { reject: await apiErrorFor(400, THROTTLE) })
    const { AdsTab } = await import("./Ads")
    render(() => <AdsTab />)
    const note = await screen.findByTestId("ads-list-issue")
    expect(note.textContent).toBe(`${THROTTLE_TEXT}Retry`)
    expect(document.body.textContent).not.toContain("Failed to load ads")
  })
})
