// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The activity rail names every KERNEL MODULE, and those names came off each
// module's manifest as English literals, so a French reader got "Mail",
// "Tickets", "Knowledge", "Calendar", "Projects", "Contacts" on an otherwise
// translated rail. The modules are registered here exactly the way the runtime
// registers them, from the real `app.manifest.json` files, so a manifest that
// loses its `labelKey` fails this test rather than shipping English.
//
// An INSTALLED app (the bundled five: Shopify, Invoicing, Shipping,
// Monitoring, Ads) ships no catalog key: the package format carries no
// localized name, so its own label survives. That fallback is asserted too.
import { cleanup, render, screen } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  getActivityBarEntries,
  registerActivityBarEntry,
  resetRegistry,
} from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppFromManifest } from "~/framework/define-app"
import { I18nProvider } from "~/modules/i18n/i18n-context"
import { ActivityBar } from "~/modules/shell/ActivityBar"
import { resetTabStore } from "~/modules/shell/tab-store"
import { WsProvider } from "~/modules/shell/WsContext"
import en from "../../../../../packages/shared/src/i18n/locales/en/kernel.json"
import fr from "../../../../../packages/shared/src/i18n/locales/fr/kernel.json"
import calendarManifest from "../../../../api/src/apps/calendar/app.manifest.json"
import contactsManifest from "../../../../api/src/apps/contacts/app.manifest.json"
import knowledgeManifest from "../../../../api/src/apps/knowledge/app.manifest.json"
import mailManifest from "../../../../api/src/apps/mail/app.manifest.json"
import projectsManifest from "../../../../api/src/apps/projects/app.manifest.json"
import ticketsManifest from "../../../../api/src/apps/tickets/app.manifest.json"

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

const KERNEL_MODULE_MANIFESTS = [
  mailManifest,
  ticketsManifest,
  knowledgeManifest,
  calendarManifest,
  projectsManifest,
  contactsManifest,
] as unknown as Parameters<typeof registerAppFromManifest>[0][]

/** Every component a manifest names, stubbed: this test renders the rail, not the apps. */
const stubExports = new Proxy({}, { get: () => () => null, has: () => true }) as Record<
  string,
  unknown
>

function registerKernelModules(): void {
  for (const manifest of KERNEL_MODULE_MANIFESTS) {
    registerAppFromManifest(manifest, stubExports)
  }
}

/** Read a flat `kernel.a.b` key out of one locale's kernel dictionary. */
function readKey(dict: unknown, key: string): unknown {
  return key
    .replace(/^kernel\./, "")
    .split(".")
    .reduce<any>((acc, part) => (acc == null ? acc : acc[part]), dict)
}

function renderRail(locale: "en" | "fr") {
  return render(() => (
    <I18nProvider initialLocale={locale}>
      <WsProvider send={() => {}} status={() => "connected"}>
        <ActivityBar />
      </WsProvider>
    </I18nProvider>
  ))
}

describe("the activity rail names every kernel module in the reader's language", () => {
  beforeEach(() => {
    resetRegistry()
    resetBootstrap()
    resetTabStore()
    bootstrapKernelApps()
    registerKernelModules()
  })
  afterEach(() => cleanup())

  it("every kernel rail entry carries a key that resolves in en and fr", () => {
    const kernelEntries = getActivityBarEntries().filter((e) => !e.external)
    expect(kernelEntries.length).toBeGreaterThanOrEqual(9)
    expect(kernelEntries.filter((e) => !e.labelKey).map((e) => e.id)).toEqual([])
    const unresolved = kernelEntries.filter(
      (e) =>
        typeof readKey(en, e.labelKey as string) !== "string" ||
        typeof readKey(fr, e.labelKey as string) !== "string",
    )
    expect(unresolved.map((e) => e.labelKey)).toEqual([])
  })

  it("the rail is French, with no English module label left on it", () => {
    renderRail("fr")

    expect(screen.getByLabelText("Mail")).toBeInTheDocument()
    expect(screen.getByLabelText("Connaissances")).toBeInTheDocument()
    expect(screen.getByLabelText("Agenda")).toBeInTheDocument()
    expect(screen.getByLabelText("Projets")).toBeInTheDocument()
    expect(screen.getByLabelText("Recherche")).toBeInTheDocument()
    expect(screen.getByLabelText("Paramètres")).toBeInTheDocument()

    for (const entry of getActivityBarEntries()) {
      if (!entry.labelKey) continue
      const french = readKey(fr, entry.labelKey)
      if (french === entry.label) continue // the same word in both locales
      expect(screen.queryByLabelText(entry.label)).toBeNull()
    }
  })

  it("keeps the English test ids, and an installed app keeps its own name", () => {
    registerActivityBarEntry({
      id: "crm",
      icon: () => null,
      label: "Pipeline",
      order: 50,
      appId: "crm",
      external: true,
      tabAction: { type: "crm:home", entityId: "crm", label: "Pipeline" },
    })

    renderRail("fr")

    expect(screen.getByTestId("activity-mail")).toBeInTheDocument()
    expect(screen.getByTestId("activity-tickets")).toBeInTheDocument()
    expect(screen.getByLabelText("Pipeline")).toBeInTheDocument()
  })

  it("English is unchanged, so the rail still reads Mail in en", () => {
    renderRail("en")

    expect(screen.getByLabelText("Mail")).toBeInTheDocument()
    expect(screen.getByLabelText("Knowledge")).toBeInTheDocument()
  })
})
