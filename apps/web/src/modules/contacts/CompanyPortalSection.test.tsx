// SPDX-License-Identifier: FSL-1.1-ALv2
// The company page's client portal section: who has access, its three states,
// the merge sentence with its one way out, a restricted share's named readers,
// the log only for its named readers, the preview through the portal's reads,
// and End access saying what was kept.
import { fireEvent, render, waitFor } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  get: vi.fn(),
  post: vi.fn(),
  scopes: [] as string[],
}))

vi.mock("~/modules/shell/ApiContext", () => ({
  useApi: () => ({ get: mocks.get, post: mocks.post }),
}))
vi.mock("~/modules/auth/auth-store", () => ({
  hasScope: (scope: string) => mocks.scopes.includes(scope),
}))

import { CompanyPortalSection, logAction, portalState } from "./CompanyPortalSection"

const CO = "co-1"
const BASE = `/contacts/companies/${CO}/portal`

const PAUL = {
  userId: "u-paul",
  name: "Paul Garnier",
  email: "paul@client.example",
  title: null,
  invitedAt: "2026-11-01",
  lastSignInAt: "2026-11-02",
  status: "active",
  totpEnabled: false,
  keepsWhatTheySawBefore: false,
}
const ANNE = {
  ...PAUL,
  userId: "u-anne",
  name: "Anne Morel",
  email: "anne@client.example",
  lastSignInAt: null,
}

function serve(routes: Record<string, unknown>) {
  mocks.get.mockImplementation(async (path: string) => {
    const key = Object.keys(routes).find((k) => path === k)
    if (key === undefined) throw new Error(`unexpected GET ${path}`)
    const v = routes[key]
    if (v instanceof Error) throw v
    return v
  })
}

beforeEach(() => {
  mocks.get.mockReset()
  mocks.post.mockReset()
  mocks.post.mockResolvedValue({})
  mocks.scopes = ["kernel:portal:admin"]
})

describe("company portal section", () => {
  it("names its state from the people: nobody yet, open, or ended", () => {
    expect(portalState([])).toBe("empty")
    expect(portalState([PAUL])).toBe("active")
    expect(portalState([{ ...PAUL, status: "deactivated" }])).toBe("ended")
  })

  it("with nobody invited yet it says so and offers the invitation, not End access", async () => {
    serve({ [`${BASE}/people`]: [] })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    expect(await r.findByTestId("company-portal.empty")).toBeTruthy()
    expect(r.getByTestId("company-portal.invite")).toBeTruthy()
    expect(r.queryByTestId("company-portal.end")).toBeNull()
  })

  it("lists each person with their address, invited or signed in, and no ranking or seat count", async () => {
    serve({ [`${BASE}/people`]: [PAUL, ANNE] })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    const paul = await r.findByTestId("company-portal.person-u-paul")
    expect(paul.textContent).toContain("paul@client.example")
    expect(paul.textContent).toContain("Has signed in")
    expect(r.getByTestId("company-portal.person-u-anne").textContent).toContain("Invited")
    expect(r.getByTestId("company-portal").textContent).not.toMatch(/seat|score|last seen/i)
  })

  it("after a merge it says nobody sees more, and only a click asks to show the whole company", async () => {
    serve({ [`${BASE}/people`]: [{ ...PAUL, keepsWhatTheySawBefore: true }] })
    mocks.post.mockResolvedValue({
      message: "Paul Garnier now sees everything the company shares.",
    })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    const kept = await r.findByTestId("company-portal.merge-kept")
    expect(kept.textContent).toContain(
      "Nobody on the portal sees more: Paul Garnier keeps what they saw before",
    )
    expect(mocks.post).not.toHaveBeenCalled()
    fireEvent.click(r.getByTestId("company-portal.show-whole-company"))
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(`${BASE}/people/u-paul/show-whole-company`, {}),
    )
    expect((await r.findByTestId("company-portal.message")).textContent).toContain(
      "now sees everything",
    )
  })

  it("names who reads a restricted share, and the hours switch asks first", async () => {
    mocks.scopes = ["kernel:portal:admin", "kernel:portal:share"]
    serve({
      [`${BASE}/people`]: [PAUL, ANNE],
      [`${BASE}/shares`]: [
        { id: "sh-1", kind: "agreement", objectId: "ag-1", onlyUserIds: ["u-anne"] },
      ],
    })
    mocks.post.mockImplementation(async (path: string) =>
      path === "/apps/run-tool" ? { projects: [{ id: "p-1", name: "Website" }] } : {},
    )
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    expect((await r.findByTestId("company-portal.restricted-row")).textContent).toBe(
      "Only Anne Morel see it",
    )
    expect(r.getByTestId("company-portal.never-shared").textContent).toContain("margin")
    const hours = await r.findByTestId("company-portal.share-project_hours-p-1")
    fireEvent.click(hours.querySelector("[data-testid='company-portal.share-toggle']") as Element)
    expect(await r.findByTestId("company-portal.share-warning")).toBeTruthy()
    expect(mocks.post).not.toHaveBeenCalledWith(`${BASE}/shares`, expect.anything())
    fireEvent.click(r.getByTestId("company-portal.share-confirm"))
    await waitFor(() =>
      expect(mocks.post).toHaveBeenCalledWith(`${BASE}/shares`, {
        kind: "project_hours",
        open: true,
        objectId: "p-1",
      }),
    )
  })

  it("shows the access log only to its named readers", async () => {
    serve({
      [`${BASE}/people`]: [PAUL],
      [`${BASE}/log`]: [
        {
          id: "l1",
          at: "2026-11-03",
          user_id: "u-paul",
          action: "portal.sign_in",
          entity_type: null,
        },
      ],
    })
    const without = render(() => <CompanyPortalSection companyId={CO} />)
    await without.findByTestId("company-portal.person-u-paul")
    expect(without.queryByTestId("company-portal.log")).toBeNull()
    expect(mocks.get).not.toHaveBeenCalledWith(`${BASE}/log`)
    without.unmount()

    mocks.scopes = ["kernel:portal:admin", "kernel:portal:logs"]
    const withLog = render(() => <CompanyPortalSection companyId={CO} />)
    const row = await withLog.findByTestId("company-portal.log-l1")
    expect(row.textContent).toContain("Paul Garnier")
    expect(row.textContent).toContain("Signed in")
    expect(logAction("portal.something_new")).toBe("other")
  })

  it("reads its people and access log again when the window comes back, so a client's sign-in shows", async () => {
    mocks.scopes = ["kernel:portal:admin", "kernel:portal:logs"]
    const log: unknown[] = []
    const people = [{ ...PAUL, lastSignInAt: null }]
    serve({ [`${BASE}/people`]: people, [`${BASE}/log`]: log })
    mocks.get.mockImplementation(async (path: string) => {
      if (path === `${BASE}/people`) return people.map((p) => ({ ...p }))
      if (path === `${BASE}/log`) return [...log]
      throw new Error(`unexpected GET ${path}`)
    })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    await r.findByTestId("company-portal.person-u-paul")
    // Meanwhile the client signed in, from their own browser.
    log.push({
      id: "l9",
      at: "2026-11-03",
      user_id: "u-paul",
      action: "portal.sign_in",
      entity_type: null,
    })
    people[0] = { ...PAUL }
    window.dispatchEvent(new Event("focus"))
    expect((await r.findByTestId("company-portal.log-l9")).textContent).toContain("Signed in")
  })

  it("names the people who can read the access log", async () => {
    mocks.scopes = ["kernel:portal:admin", "kernel:portal:logs"]
    serve({
      [`${BASE}/people`]: [PAUL],
      [`${BASE}/log`]: [],
      [`${BASE}/log/readers`]: {
        company: "Maison Alpha",
        readers: [
          { userId: "m-1", name: "Léa Roux" },
          { userId: "m-2", name: "Marc Petit" },
        ],
      },
    })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    await waitFor(() =>
      expect(r.getByTestId("company-portal.log-readers").textContent).toBe(
        "Only Léa Roux, Marc Petit can read it.",
      ),
    )
  })

  it("marks the second step's current setting, and a change marks the new one", async () => {
    let required = true
    mocks.get.mockImplementation(async (path: string) => {
      if (path === `${BASE}/people`) return [PAUL]
      if (path === `${BASE}/sign-in`) return { company: "Maison Alpha", required }
      throw new Error(`unexpected GET ${path}`)
    })
    mocks.post.mockImplementation(async (_path: string, body: { requireTotp: boolean }) => {
      required = body.requireTotp
      return { required }
    })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    await waitFor(() =>
      expect(r.getByTestId("company-portal.require-totp").getAttribute("aria-pressed")).toBe(
        "true",
      ),
    )
    expect(r.getByTestId("company-portal.optional-totp").getAttribute("aria-pressed")).toBe("false")
    fireEvent.click(r.getByTestId("company-portal.optional-totp"))
    await waitFor(() =>
      expect(r.getByTestId("company-portal.optional-totp").getAttribute("aria-pressed")).toBe(
        "true",
      ),
    )
    expect(mocks.post).toHaveBeenCalledWith(`${BASE}/sign-in`, { requireTotp: false })
    expect(r.getByTestId("company-portal.require-totp").getAttribute("aria-pressed")).toBe("false")
  })

  it("previews what a person sees through the portal's own reads", async () => {
    serve({
      [`${BASE}/people`]: [PAUL],
      [`${BASE}/preview/u-paul`]: {
        userId: "u-paul",
        signedInWouldSee: {
          me: [],
          projects: [{ id: "p-1", name: "Website" }],
          invoices: null,
          upcoming: [],
          requests: [],
        },
      },
    })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    await r.findByTestId("company-portal.person-u-paul")
    fireEvent.click(r.getByTestId("company-portal.view-preview"))
    expect((await r.findByTestId("company-portal.preview-projects")).textContent).toContain(
      "Website",
    )
    expect(r.getByTestId("company-portal.preview-invoices").textContent).toContain(
      "could not be shown",
    )
    expect(r.getByTestId("company-portal.preview-requests").textContent).toContain("Nothing shared")
  })

  it("End access asks first, then says what it did and what was kept", async () => {
    serve({ [`${BASE}/people`]: [PAUL] })
    mocks.post.mockResolvedValue({ signedOut: 1, cancelledLinks: 2, closedShares: 3 })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    fireEvent.click(await r.findByTestId("company-portal.end"))
    expect(mocks.post).not.toHaveBeenCalled()
    expect(r.getByTestId("company-portal.end-confirm").textContent).toContain("are kept")
    fireEvent.click(r.getByTestId("company-portal.end-confirm-button"))
    const msg = await r.findByTestId("company-portal.message")
    expect(msg.textContent).toContain("1 signed out, 2 links cancelled, 3 shares closed")
    expect(msg.textContent).toContain("Invoices and signed documents are kept")
  })

  it("after access ended it says so and offers to give access again", async () => {
    serve({ [`${BASE}/people`]: [{ ...PAUL, status: "deactivated" }] })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    expect((await r.findByTestId("company-portal.ended")).textContent).toContain("kept")
    expect(r.getByTestId("company-portal.restore")).toBeTruthy()
    expect(r.queryByTestId("company-portal.end")).toBeNull()
  })

  it("renders a client-typed name with markup as plain text", async () => {
    const payload = `<img src=x onerror="alert(1)">Évil</b>`
    serve({ [`${BASE}/people`]: [{ ...PAUL, name: payload }] })
    const r = render(() => <CompanyPortalSection companyId={CO} />)
    const row = await r.findByTestId("company-portal.person-u-paul")
    expect(row.textContent).toContain(payload)
    expect(row.querySelector("img")).toBeNull()
  })
})
