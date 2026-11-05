// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The home UI strings slice 4b shipped as English literals now come from the
// shared kernel dictionary. Two assertions per string: the English rendering is
// unchanged byte for byte, and the same surface under a French provider renders
// the French entry, which is what a literal cannot do.

import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"
import AgentArchiveAdmin from "~/modules/agent/AgentArchiveAdmin"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import { loadAgentDirectory, resetAgentDirectory } from "~/modules/threads/agent-directory"
import { WithheldCapabilityCard } from "~/modules/threads/WithheldCapabilityCard"

const AGENT = "11111111-1111-4111-8111-111111111111"
const OTHER = "22222222-2222-4222-8222-222222222222"

const api = {
  get: vi.fn(async () => ({ data: [] })),
  post: vi.fn(async () => ({ data: {} })),
  patch: vi.fn(async () => ({ data: {} })),
}

function renderIn(locale: "en" | "fr", node: () => unknown) {
  return render(() => <I18nProvider initialLocale={locale}>{node() as never}</I18nProvider>)
}

const card = (locale: "en" | "fr", items: Array<Record<string, unknown>>) =>
  renderIn(locale, () => (
    <WithheldCapabilityCard
      api={api as never}
      threadId="t-1"
      messageId="m-1"
      agentId="a-1"
      items={items as never}
    />
  ))

describe("withheld card copy comes from the kernel dictionary (P4b-E1)", () => {
  beforeEach(() => {
    api.get.mockClear()
    api.post.mockClear()
  })
  afterEach(() => cleanup())

  it("renders the English title, body and both actions byte for byte", () => {
    card("en", [{ label: "finance data" }])
    expect(screen.getByTestId("withheld-card-title").textContent).toBe(
      "Some capabilities are unavailable here",
    )
    expect(screen.getByTestId("withheld-card-body").textContent).toBe(
      "Not everyone in this room has access to what I would need, so I left some capabilities out.",
    )
    expect(screen.getByTestId("withheld-card-continue-in-dm").textContent).toBe("Continue in a DM")
    expect(screen.getByTestId("withheld-card-share-anyway").textContent).toBe("Share anyway")
  })

  it("renders the French title, body and actions when the provider is French", () => {
    card("fr", [{ label: "finance data" }])
    expect(screen.getByTestId("withheld-card-title").textContent).toBe(
      "Certaines capacités ne sont pas disponibles ici",
    )
    expect(screen.getByTestId("withheld-card-body").textContent).toBe(
      "Certaines personnes de cette discussion n'ont pas accès à ce dont j'aurais besoin : j'ai donc laissé de côté certaines capacités.",
    )
    expect(screen.getByTestId("withheld-card-continue-in-dm").textContent).toBe(
      "Continuer en message privé",
    )
    expect(screen.getByTestId("withheld-card-share-anyway").textContent).toBe("Partager quand même")
  })

  it("appends the French not shareable line to a non disclosable set", () => {
    card("fr", [{ label: "finance data", nonDisclosable: true }])
    expect(screen.getByTestId("withheld-card-body").textContent).toBe(
      "Certaines personnes de cette discussion n'ont pas accès à ce dont j'aurais besoin : j'ai donc laissé de côté certaines capacités. Celle-ci ne peut pas être partagée ici.",
    )
  })
})

describe("agent archive copy comes from the kernel dictionary (P4b-E1)", () => {
  beforeEach(async () => {
    resetAgentDirectory()
    await loadAgentDirectory({
      get: async () => ({
        data: [
          { id: AGENT, handle: "@old", displayName: "Old", avatarUrl: null },
          { id: OTHER, handle: "@support", displayName: "Support", avatarUrl: null },
        ],
      }),
    })
  })
  afterEach(() => cleanup())

  async function blockedArchive(locale: "en" | "fr") {
    const post = vi.fn(async () => {
      throw new ApiError("blocked", 409, "archive_blocked", undefined, {
        blocked: true,
        routines: [{ id: "r1", name: "Weekly digest" }],
        skills: [],
      })
    })
    renderIn(locale, () => (
      <ApiContext.Provider value={{ post, patch: vi.fn() } as never}>
        <AgentArchiveAdmin agentId={AGENT} />
      </ApiContext.Provider>
    ))
    fireEvent.click(screen.getByTestId("agent-archive"))
    await waitFor(() => expect(screen.getByTestId("agent-archive-blocked")).toBeInTheDocument())
  }

  it("renders the English blocked string byte for byte", async () => {
    await blockedArchive("en")
    expect(screen.getByTestId("agent-archive-blocked").textContent).toBe(
      "This agent still owns skills or routines. Reassign them first.",
    )
  })

  it("renders the French blocked string", async () => {
    await blockedArchive("fr")
    expect(screen.getByTestId("agent-archive-blocked").textContent).toBe(
      "Cet agent possède encore des compétences ou des routines. Réattribuez-les d'abord.",
    )
  })
})
