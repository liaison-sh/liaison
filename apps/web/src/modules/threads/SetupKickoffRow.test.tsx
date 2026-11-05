// SPDX-License-Identifier: FSL-1.1-ALv2
import { render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"

vi.mock("~/modules/secret-request/SecretRequestToolCard", () => ({
  default: (props: { requestId: string }) => (
    <div data-testid="secret-request-card-stub" data-request-id={props.requestId} />
  ),
}))

import { I18nProvider } from "~/modules/i18n/i18n-context"
import { SetupKickoffRow, setupKickoffOf } from "./SetupKickoffRow"

const META = {
  type: "setup-kickoff",
  agentId: "agent-1",
  demoUrl: "https://demo.liaison.sh",
  secretRequestId: "sec-1",
  state: {
    items: [{ key: "aiKey", done: false, optional: false, detail: "no usable model key" }],
    next: "aiKey",
    asOf: "2026-10-26T10:00:00.000Z",
  },
}

describe("SetupKickoffRow", () => {
  it("heads the card, shows the checklist, the key card and the demo offer once", () => {
    const view = setupKickoffOf(META)
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-1" view={view} />)
    expect(screen.getByTestId("setup-kickoff-row").textContent).toContain("Set up your space")
    expect(screen.getByTestId("setup-item-aiKey").getAttribute("data-done")).toBe("false")
    expect(screen.getByTestId("secret-request-card-stub").getAttribute("data-request-id")).toBe(
      "sec-1",
    )
    const links = screen.getAllByTestId("setup-demo-link")
    expect(links).toHaveLength(1)
    expect(links[0]!.getAttribute("href")).toBe("https://demo.liaison.sh")
    expect(links[0]!.getAttribute("target")).toBe("_blank")
    expect(links[0]!.getAttribute("rel")).toContain("noopener")
    expect(screen.getByTestId("setup-kickoff-row").textContent).toContain("demo.liaison.sh")
  })

  it("mounts no key card without a request, and no demo block when the offer is off", () => {
    const view = setupKickoffOf({ ...META, secretRequestId: undefined, demoUrl: null })
    if (!view) throw new Error("not read")
    render(() => <SetupKickoffRow messageId="m-2" view={view} />)
    expect(screen.queryByTestId("secret-request-card-stub")).toBeNull()
    expect(screen.queryByTestId("setup-demo-link")).toBeNull()
  })

  it("speaks French", () => {
    const view = setupKickoffOf(META)
    if (!view) throw new Error("not read")
    render(() => (
      <I18nProvider initialLocale="fr">
        <SetupKickoffRow messageId="m-3" view={view} />
      </I18nProvider>
    ))
    expect(screen.getByTestId("setup-kickoff-row").textContent).toContain("Configurez votre espace")
    expect(screen.getByTestId("setup-demo-link").textContent).toContain("Ouvrir la démo")
  })

  it("reads only a setup-kickoff row with a checklist", () => {
    expect(setupKickoffOf({ type: "approval-result" })).toBeNull()
    expect(setupKickoffOf({ type: "setup-kickoff" })).toBeNull()
    expect(setupKickoffOf(null)).toBeNull()
  })
})
