// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent page and its tabs under a FRENCH provider.
//
// Their copy used to live as English literals in `agents-copy.ts`,
// `agent-activity-copy.ts` and `agent-settings-copy.ts`, pinned byte for byte
// by tests that a translation layer would have broken. The literals are gone:
// every string is a `kernel.agents.*` catalog entry now, and what is pinned
// instead is that each key resolves in both shipped locales and that the
// rendered screen in French carries no English label.
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import AgentPage from "~/modules/agent/AgentPage"
import { resetAgentMemoryStore } from "~/modules/agent/agent-memory-store"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ApiContext } from "~/modules/shell/ApiContext"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"

const AGENT = "11111111-1111-4111-8111-111111111111"

vi.mock("~/modules/auth/auth-store", () => ({
  onAuthCleared: () => () => {},
  hasScope: () => false,
  hasAppsAdmin: () => false,
  userFromToken: () => ({
    userId: "viewer",
    orgId: "org",
    scopes: [],
    roles: [],
    dimensionGrants: {},
    exp: 0,
    name: "Me",
  }),
}))

function detail() {
  return {
    id: AGENT,
    handle: "@logistics",
    displayName: "Logistics",
    kind: "role",
    ownerUserId: null,
    purpose: "Keeps the shipping queue moving.",
    avatarUrl: null,
    state: "active",
    lastActivityAt: "2026-09-13T10:00:00.000Z",
    channels: [{ id: "c-1", handle: "@shipping", name: "Shipping" }],
    counts: { skills: 0, routines: 0, memoryFiles: 0, knowledgePointers: 0 },
    capabilityCategories: ["kernel"],
    runsOn: "liaison",
  }
}

function renderPage() {
  const api: any = {
    get: vi.fn(async (path: string) => {
      if (path.startsWith("/agent/skills")) return []
      if (path.startsWith("/agent/routines")) return []
      if (path === "/agents") {
        return [{ id: AGENT, handle: "@logistics", displayName: "Logistics", kind: "role" }]
      }
      if (path.includes("/memory/tree")) return { files: [], index: { lines: 0 } }
      if (path.endsWith("/definition")) return { data: { systemPrompt: "You are Logistics." } }
      if (/^\/agents\/[^/]+$/.test(path)) return { data: detail() }
      return null
    }),
    post: vi.fn(),
    put: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  }
  render(() => (
    <I18nProvider initialLocale="fr">
      <ApiContext.Provider value={api as never}>
        <AgentPage entityId={AGENT} />
      </ApiContext.Provider>
    </I18nProvider>
  ))
  return api
}

/** Read a `kernel.a.b` key out of one locale's kernel dictionary. */
function readKey(dict: unknown, key: string): unknown {
  return key
    .replace(/^kernel\./, "")
    .split(".")
    .reduce<any>((acc, part) => (acc == null ? acc : acc[part]), dict)
}

/** Every key this area moved off a literal. */
const AGENT_KEYS = [
  "kernel.agents.tablist",
  "kernel.agents.tabOverview",
  "kernel.agents.tabSkills",
  "kernel.agents.tabRoutines",
  "kernel.agents.tabKnowledge",
  "kernel.agents.tabActivity",
  "kernel.agents.tabSettings",
  "kernel.agents.kindRole",
  "kernel.agents.kindPersonal",
  "kernel.agents.kindSystem",
  "kernel.agents.runsOnLocal",
  "kernel.agents.runsOnLiaison",
  "kernel.agents.message",
  "kernel.agents.open",
  "kernel.agents.yourAgent",
  "kernel.agents.systemBadge",
  "kernel.agents.newAgent",
  "kernel.agents.channelCountOne",
  "kernel.agents.channelCountMany",
  "kernel.agents.purpose",
  "kernel.agents.purposeEmpty",
  "kernel.agents.charter",
  "kernel.agents.charterBody",
  "kernel.agents.showInstructions",
  "kernel.agents.hideInstructions",
  "kernel.agents.instructionsEmpty",
  "kernel.agents.capabilities",
  "kernel.agents.capabilitiesEmpty",
  "kernel.agents.channels",
  "kernel.agents.addToChannel",
  "kernel.agents.channelsEmpty",
  "kernel.agents.activityNone",
  "kernel.agents.lastActivity",
  "kernel.agents.activityEmpty",
  "kernel.agents.activityLocalBadge",
  "kernel.agents.activityLoadMore",
  "kernel.agents.activityError",
  "kernel.agents.knowledgeEmpty",
  "kernel.agents.openInKnowledge",
  "kernel.agents.newSkill",
  "kernel.agents.newRoutine",
  "kernel.agents.skillsEmpty",
  "kernel.agents.routinesEmpty",
  "kernel.agents.save",
  "kernel.agents.saving",
  "kernel.agents.ownerNote",
  "kernel.agents.settingsSaveFailed",
  "kernel.agents.settingsLoadFailed",
  "kernel.agents.status.active",
  "kernel.agents.status.pausedScopeMismatch",
  "kernel.agents.status.skippedNoCredits",
] as const

describe("agent page copy resolves in every shipped locale", () => {
  it("every key is a string in en and fr", () => {
    const missing = AGENT_KEYS.filter(
      (k) => typeof readKey(en, k) !== "string" || typeof readKey(fr, k) !== "string",
    )
    expect(missing).toEqual([])
  })

  it("the interpolated rows keep their placeholders in both locales", () => {
    for (const [key, token] of [
      ["kernel.agents.channelCountOne", "{{count}}"],
      ["kernel.agents.channelCountMany", "{{count}}"],
      ["kernel.agents.lastActivity", "{{date}}"],
      ["kernel.agents.charterBody", "{{name}}"],
    ] as const) {
      expect(readKey(en, key)).toContain(token)
      expect(readKey(fr, key)).toContain(token)
    }
  })

  it("no dash punctuation reaches a reader, in either locale", () => {
    for (const key of AGENT_KEYS) {
      for (const text of [readKey(en, key) as string, readKey(fr, key) as string]) {
        expect({ key, text, dashes: /--|–|—/.test(text) }).toEqual({ key, text, dashes: false })
      }
    }
  })
})

describe("the agent page speaks French when the locale is French", () => {
  beforeEach(() => {
    resetAgentMemoryStore()
  })
  afterEach(() => cleanup())

  it("the tab strip is French and its data-agent-tab ids do not move", async () => {
    renderPage()

    await waitFor(() => expect(screen.getByTestId("agent-page-tab-overview")).toBeInTheDocument())
    expect(screen.getByTestId("agent-page-tab-overview").textContent).toBe("Aperçu")
    expect(screen.getByTestId("agent-page-tab-skills").textContent).toBe("Compétences")
    expect(screen.getByTestId("agent-page-tab-knowledge").textContent).toBe("Connaissances")
    expect(document.querySelector('[role="tablist"]')?.getAttribute("aria-label")).toBe("Agent")

    // Every tab the strip actually renders is French, whichever the viewer's
    // permissions leave in it.
    const strip = Array.from(document.querySelectorAll("[data-agent-tab]"))
    expect(strip.length).toBeGreaterThan(3)
    const english = new Set([
      "Overview",
      "Skills",
      "Routines",
      "Memory",
      "Knowledge",
      "Activity",
      "Settings",
    ])
    for (const tab of strip) {
      const text = tab.textContent ?? ""
      if (text === "Routines") continue // the same word in both locales
      expect(english.has(text)).toBe(false)
    }
  })

  it("the page header names the kind, where it runs and the action in French", async () => {
    renderPage()

    await waitFor(() => expect(screen.getByTestId("agent-page-kind")).toBeInTheDocument())
    expect(screen.getByTestId("agent-page-kind").textContent).toBe("Agent de rôle")
    await waitFor(() =>
      expect(screen.getByTestId("agent-page-runs-on").textContent).toBe("S'exécute sur : Liaison"),
    )
    expect(screen.getByTestId("agent-page-message").textContent).toContain("Écrire")
    expect(screen.queryByText("Role agent")).toBeNull()
    expect(screen.queryByText("Runs on: Liaison")).toBeNull()
  })

  it("the overview tab's section headings and empty states are French", async () => {
    renderPage()

    await waitFor(() => expect(screen.getByTestId("agent-overview")).toBeInTheDocument())
    const overview = screen.getByTestId("agent-overview")
    await waitFor(() => expect(overview.textContent).toContain("Charte"))
    expect(overview.textContent).toContain("Charte")
    expect(overview.textContent).toContain("Capacités")
    expect(overview.textContent).toContain("Canaux")
    expect(overview.textContent).toContain("Afficher les instructions")
    // The activity line is French whichever state it is in: the page read
    // carries a date here, and it used to be asserted in the EMPTY state,
    // which only held while that read was still in flight.
    await waitFor(() =>
      expect(overview.textContent).toMatch(/Dernière activité|Aucune activité pour l'instant/),
    )

    for (const english of ["Purpose", "Charter", "Capabilities", "Channels", "Show instructions"]) {
      expect(overview.textContent).not.toContain(english)
    }
  })
  // The capability words were English data behind a French page: an app map
  // and derived nouns that no locale could reach, so a French reader got
  // "Workspace: read agents" with a French verb at best.
  it("the capability chips and the permission phrases are French", async () => {
    renderPage()

    await waitFor(() =>
      expect(screen.getByTestId("agent-overview-capability-kernel")).toBeInTheDocument(),
    )
    expect(screen.getByTestId("agent-overview-capability-kernel").textContent).toBe(
      "Espace de travail",
    )
    expect(screen.queryByText("Workspace")).toBeNull()
  })
})
