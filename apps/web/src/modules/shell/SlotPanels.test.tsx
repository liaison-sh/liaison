// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { cleanup, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  registerContribution,
  resetRegistry,
  unregisterContributions,
} from "~/framework/app-registry"
import { setTokens } from "~/modules/auth/auth-store"
import { ApiProvider } from "~/modules/shell/ApiContext"
import { SlotPanels } from "~/modules/shell/SlotPanels"
import { mockApiClient } from "~/tests/helpers/mock-api"

function makeJwt(): string {
  const header = btoa(JSON.stringify({ alg: "HS256", typ: "JWT" }))
  const body = btoa(
    JSON.stringify({
      userId: "u1",
      orgId: "o1",
      name: "U",
      roles: ["admin"],
      scopes: ["*"],
      dimensionGrants: {},
      exp: Math.floor(Date.now() / 1000) + 3600,
    }),
  )
  return `${header}.${body}.fake`
}

function renderSlotPanels(slot: string, entityId?: string) {
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <SlotPanels slot={slot} entityId={entityId} />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

describe("SlotPanels (B10)", () => {
  beforeEach(() => {
    setTokens(makeJwt(), "refresh")
    resetRegistry()
  })
  afterEach(() => {
    unregisterContributions("invoicing")
    unregisterContributions("ghost-app")
    cleanup()
  })

  it("renders panels returned by the server, looking up component from the local registry", async () => {
    // Server says: invoicing contributes a panel with id "invoicing-documents"
    // to the contact_detail slot.
    mockApiClient({
      "/api/v1/slots/contact_detail": {
        panels: [
          {
            id: "invoicing-documents",
            app: "invoicing",
            label: "Documents",
            component: "ContactDocumentsPanel",
          },
        ],
      },
    })
    // Local registry: the invoicing app already registered its contribution.
    registerContribution("contact_detail", {
      appId: "invoicing",
      id: "invoicing-documents",
      label: "Documents",
      component: (props) => (
        <div data-testid="invoicing-documents-panel">Documents for {props.entityId}</div>
      ),
    })

    renderSlotPanels("contact_detail", "contact-1")
    await waitFor(() => {
      expect(screen.getByTestId("invoicing-documents-panel")).toBeInTheDocument()
    })
    expect(screen.getByTestId("invoicing-documents-panel").textContent).toContain("contact-1")
  })

  it("shows 'Panel unavailable' placeholder when the local registry has no matching component", async () => {
    mockApiClient({
      "/api/v1/slots/contact_detail": {
        panels: [
          {
            id: "missing-panel",
            app: "ghost-app",
            label: "Ghost",
            component: "GhostPanel",
          },
        ],
      },
    })
    // No registerContribution() call — bundle load effectively failed,
    // so the contribution registry has nothing for (ghost-app, missing-panel).

    renderSlotPanels("contact_detail")
    await waitFor(() => {
      expect(
        screen.getByTestId("slot-panel-unavailable-ghost-app-missing-panel"),
      ).toBeInTheDocument()
    })
  })

  it("renders nothing when the server returns an empty panel list (no skeleton noise)", async () => {
    mockApiClient({
      "/api/v1/slots/contact_detail": { panels: [] },
    })

    renderSlotPanels("contact_detail")
    await waitFor(() => {
      // The wrapper div is omitted entirely when the list is empty.
      expect(screen.queryByTestId("slot-panels-contact_detail")).not.toBeInTheDocument()
    })
  })
})
