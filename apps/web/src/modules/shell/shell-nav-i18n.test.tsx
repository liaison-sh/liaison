// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The shell's NAVIGATION labels under a French provider: the activity bar rail,
// the phone Work rows and the tab strip's fixed tab names. They came straight
// off the registry as English literals, so a French reader got an English rail
// next to translated pages. An installed app that ships no catalog key keeps
// its own label: that is asserted too, so the fallback cannot rot.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getActivityBarEntries,
  registerActivityBarEntry,
  registerTabType,
  registryLabel,
  resetRegistry,
} from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import { resetTabStore } from "~/modules/shell/tab-store"
import { Work } from "~/modules/shell/Work"
import { WsProvider } from "~/modules/shell/WsContext"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"

vi.stubGlobal("localStorage", {
  getItem: vi.fn(() => null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
})
vi.stubGlobal("fetch", vi.fn())

vi.mock("~/modules/shell/attention-store", () => ({
  attentionStore: {
    get items() {
      return [] as any[]
    },
    attentionForApp: () => [],
    attentionCount: () => 0,
    markStaleAndReload: () => {},
  },
  getAttentionApi: () => null,
}))

function renderIn(locale: "en" | "fr", node: () => unknown) {
  return render(() => <I18nProvider initialLocale={locale}>{node() as never}</I18nProvider>)
}

/** An installed app bundle: a label of its own and no catalog key. */
function registerForeignApp(): void {
  registerTabType("crm:home", {
    component: () => <div />,
    sidebar: null,
    icon: () => null,
    urlPattern: "/crm",
    defaultLabel: "Pipeline",
    singleton: true,
  })
  registerActivityBarEntry({
    id: "crm",
    icon: () => null,
    label: "Pipeline",
    order: 50,
    appId: "crm",
    external: true,
    tabAction: { type: "crm:home", entityId: "crm", label: "Pipeline" },
  })
}

describe("shell navigation speaks the reader's language", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    resetTabStore()
    bootstrapKernelApps()
  })
  afterEach(() => cleanup())

  it("the kernel activity bar entry carries a key that resolves in en and fr", () => {
    const home = getActivityBarEntries().find((e) => e.appId === "kernel")
    expect(home?.labelKey).toBe("kernel.nav.home")
    expect(typeof (en as any).nav.home).toBe("string")
    expect(typeof (fr as any).nav.home).toBe("string")
  })

  it("the activity bar rail is French and keeps its English test ids", () => {
    renderIn("fr", () => (
      <WsProvider send={() => {}} status={() => "connected"}>
        <ActivityBar />
      </WsProvider>
    ))

    expect(screen.getByLabelText("Accueil")).toBeInTheDocument()
    expect(screen.queryByLabelText("Home")).toBeNull()
    // The test id is derived from the English label on purpose: a locale
    // change must never move a selector.
    expect(screen.getByTestId("activity-home")).toBeInTheDocument()
    expect(screen.getByTestId("activity-agents")).toBeInTheDocument()
  })

  it("the Work rows are French, and an installed app keeps its own name", () => {
    registerForeignApp()

    renderIn("fr", () => <Work />)

    expect(screen.getByTestId("work-title").textContent).toBe("Travail")
    expect(screen.getByTestId("work-row-approvals").textContent).toContain("Approbations")
    // No catalog key: the app's own label survives rather than a bare key.
    expect(screen.getByTestId("work-row-crm").textContent).toContain("Pipeline")
    expect(screen.queryByText("Approvals")).toBeNull()
  })

  it("registryLabel falls back to the English label when a key is missing", () => {
    expect(registryLabel((k) => k, { label: "Pipeline" })).toBe("Pipeline")
    expect(registryLabel((k) => k, { label: "Pipeline", labelKey: "kernel.nav.nope" })).toBe(
      "Pipeline",
    )
    expect(registryLabel(() => "Accueil", { label: "Home", labelKey: "kernel.nav.home" })).toBe(
      "Accueil",
    )
  })
})
