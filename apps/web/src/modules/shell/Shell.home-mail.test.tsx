// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S9: a Home "new email" card opens that email, on every tier. Reported
// 2026-10-05 on desktop and mobile as "Type d'onglet inconnu « mail:new_email »"
// and fixed in c7cc048e6; the tests that fix added mock the opener, so nothing
// drove the whole chain. This one does, through the real Shell, the real
// AttentionRow and openers, and the mail app's real manifest: click the card,
// and the active tab is `mail:conversation` for the linked conversation and the
// route is `/mail/<id>`. The phone tier is the path the mobile app (the
// Capacitor shell wrapping this web app unmodified) runs.
import type { AttentionItem } from "@liaison/shared"
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

vi.hoisted(() => {
  const store = new Map<string, string>()
  globalThis.localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    length: 0,
    key: () => null,
  } as any
})

vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: () => true,
    userFromToken: () => ({
      userId: "u1",
      orgId: "o1",
      name: "Tester",
      roles: [],
      scopes: [],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  }
})

import { readFileSync } from "node:fs"
import { resolve as resolvePath } from "node:path"
import { resetRegistry } from "~/framework/app-registry"
import { bootstrapKernelApps, resetBootstrap } from "~/framework/bootstrap"
import { registerAppFromManifest, resetAppIndex } from "~/framework/define-app"
import { clearAuth } from "~/modules/auth/auth-store"
import { attentionStore } from "~/modules/shell/attention-store"
import { resetDockStore } from "~/modules/shell/dock-store"
import { resetHomeCardLayout } from "~/modules/shell/home-card-layout"
import { Shell } from "~/modules/shell/Shell"
import {
  DESKTOP_QUERY,
  PHONE_QUERY,
  type ShellTier,
  syncShellTier,
  TABLET_QUERY,
} from "~/modules/shell/shell-tier"
import { resetTabStore, tabStore } from "~/modules/shell/tab-store"

function setTier(next: ShellTier) {
  const answer = next === "phone" ? PHONE_QUERY : next === "tablet" ? TABLET_QUERY : DESKTOP_QUERY
  Object.defineProperty(globalThis, "matchMedia", {
    configurable: true,
    writable: true,
    value: (query: string) => ({
      matches: query === answer,
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    }),
  })
  syncShellTier()
}

/** One new email, as the mail producer writes it: keyed mail/new_email, linking its conversation. */
const NEW_EMAIL: AttentionItem = {
  id: "mail:new_email:msg-1",
  app: "mail",
  entity: "new_email",
  entityId: "msg-1",
  kind: "new_email" as AttentionItem["kind"],
  summary: "Nouvel e-mail de Elodie",
  urgency: 40,
  occurredAt: new Date().toISOString(),
  action: { type: "open_entity", tabType: "mail:conversation", entityId: "conv-1" },
  metadata: {
    count: 1,
    messageIds: ["msg-1"],
    accountId: "acc-1",
    conversationId: "conv-1",
    link: { tabType: "mail:conversation", entityId: "conv-1" },
  },
}

function jsonResponse(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  })
}

globalThis.fetch = vi.fn(async (input: string | URL | Request) => {
  const url = String(typeof input === "object" && "url" in input ? input.url : input)
  if (url.includes("/attention-items")) {
    return jsonResponse({ data: { items: [NEW_EMAIL], errors: [] } })
  }
  return jsonResponse({ data: [] })
}) as unknown as typeof fetch

/** Every component the manifest names resolves to an inert stub. */
const stubExports = new Proxy({} as Record<string, unknown>, {
  get: () => () => null,
  has: () => true,
})

const MAIL_MANIFEST = resolvePath(__dirname, "../../../../api/src/apps/mail/app.manifest.json")

function installMail(): void {
  const manifest = JSON.parse(readFileSync(MAIL_MANIFEST, "utf8"))
  registerAppFromManifest(manifest as never, stubExports as never)
}

describe("a Home new-email card opens that email (S9)", () => {
  beforeEach(() => {
    resetDockStore()
    resetTabStore()
    resetRegistry()
    resetAppIndex()
    resetBootstrap()
    resetHomeCardLayout()
    bootstrapKernelApps()
    installMail()
    attentionStore._setForTest({ items: [NEW_EMAIL], errors: [], loading: false })
    window.history.pushState({}, "", "/")
  })

  afterEach(() => {
    vi.clearAllMocks()
    resetDockStore()
    clearAuth()
    setTier("desktop")
  })

  for (const tier of ["desktop", "phone"] as const) {
    it(`${tier}: the click lands on mail:conversation for the linked conversation`, async () => {
      setTier(tier)
      render(() => (
        <Router>
          <Route path="*" component={Shell} />
        </Router>
      ))
      const row = await screen.findByTestId("attention-row-mail-new_email-msg-1")
      fireEvent.click(row)

      await waitFor(() => expect(tabStore.activeTabId).toBe("mail:conversation:conv-1"))
      const active = tabStore.tabs.find((t) => t.id === tabStore.activeTabId)
      expect(active?.type).toBe("mail:conversation")
      expect(active?.entityId).toBe("conv-1")
      await waitFor(() => expect(window.location.pathname).toBe("/mail/conv-1"))
      // Never the tab type no component renders.
      expect(tabStore.tabs.some((t) => t.type === "mail:new_email")).toBe(false)
    })
  }
})
