// SPDX-License-Identifier: FSL-1.1-ALv2
import { fireEvent, render, screen } from "@solidjs/testing-library"
import { describe, expect, it, vi } from "vitest"
import { InstallAppDialog } from "./InstallAppDialog"

describe("InstallAppDialog", () => {
  it("after preflight, shows requested scopes as checkboxes (all on by default)", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({
      name: "shopify",
      version: "1.0.0",
      scopes: ["shopify:orders:read", "shopify:orders:write", "shopify:customers:read"],
      connections: [{ name: "shopify", type: "oauth2" }],
    })
    render(() => <InstallAppDialog onClose={() => {}} fetchManifest={fetchManifest} />)
    fireEvent.input(screen.getByTestId("install-app-url"), {
      target: { value: "https://example.com/shopify.liaisonapp" },
    })
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    await screen.findByTestId("install-app-scope-shopify:orders:read")
    expect(screen.getByTestId("install-app-scope-shopify:orders:write")).toBeChecked()
    expect(screen.getByTestId("install-app-connection-shopify")).toBeInTheDocument()
  })

  it("starts from a registry listing's package URL and shows the listing as plain text", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({
      name: "acme-pay",
      version: "1.4.0",
      scopes: [],
      license: "MIT",
      listing: {
        category: "Finance",
        icon: "credit-card",
        summary: "<b>Payments</b> from Acme Pay.",
        publisher: "Tidewater Labs",
        sourceRepository: "https://git.example.org/liaison-payments",
      },
    })
    render(() => (
      <InstallAppDialog
        onClose={() => {}}
        initialUrl="https://registry.example/acme-pay.liaisonapp"
        fetchManifest={fetchManifest}
      />
    ))
    expect((screen.getByTestId("install-app-url") as HTMLInputElement).value).toBe(
      "https://registry.example/acme-pay.liaisonapp",
    )
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    const listing = await screen.findByTestId("install-app-listing")
    expect(fetchManifest).toHaveBeenCalledWith("https://registry.example/acme-pay.liaisonapp")
    // Plain text: markup in a listing is shown, never rendered.
    expect(listing.textContent).toContain("<b>Payments</b> from Acme Pay.")
    expect(listing.querySelector("b")).toBeNull()
    expect(listing.textContent).toContain("Tidewater Labs")
    expect(listing.textContent).toContain("MIT")
  })

  it("a package without a listing reads Unlisted", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({ name: "parts", version: "0.3.1", scopes: [] })
    render(() => <InstallAppDialog onClose={() => {}} fetchManifest={fetchManifest} />)
    fireEvent.input(screen.getByTestId("install-app-url"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    expect((await screen.findByTestId("install-app-listing")).textContent).toContain("Unlisted")
  })

  it("trust copy is always 'sandboxed worker (process-isolated)' — never 'in-process'", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({
      name: "shopify",
      version: "1.0.0",
      scopes: [],
      connections: [],
      trusted: true as never,
    })
    render(() => <InstallAppDialog onClose={() => {}} fetchManifest={fetchManifest} />)
    fireEvent.input(screen.getByTestId("install-app-url"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    const trustCopy = await screen.findByTestId("install-app-trust-posture")
    expect(trustCopy.textContent).toMatch(/sandbox|process-isolated/i)
    expect(trustCopy.textContent).not.toMatch(/in-process/i)
  })

  it("deselecting scopes shows which tools become unavailable", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({
      name: "shopify",
      version: "1.0.0",
      scopes: ["shopify:items:read", "shopify:items:write"],
      tools: {
        items_list: { requiredScopes: ["shopify:items:read"] },
        items_create: { requiredScopes: ["shopify:items:write"] },
      },
      connections: [],
    })
    render(() => <InstallAppDialog onClose={() => {}} fetchManifest={fetchManifest} />)
    fireEvent.input(screen.getByTestId("install-app-url"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    await screen.findByTestId("install-app-scope-shopify:items:write")
    fireEvent.click(screen.getByTestId("install-app-scope-shopify:items:write"))
    const summary = await screen.findByTestId("install-app-disabled-tools-summary")
    // The deselected scope's tool is listed; the still-granted tool is NOT —
    // an inverted filter would list `items_list` instead and this would catch it.
    expect(summary.textContent).toMatch(/items_create/)
    expect(summary.textContent).not.toMatch(/items_list/)
    expect(summary.textContent).toMatch(/1 of 2/)
  })

  it("flips install button to browse-only when all scopes deselected", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({
      name: "shopify",
      version: "1.0.0",
      scopes: ["shopify:items:read"],
      tools: { items_list: { requiredScopes: ["shopify:items:read"] } },
      connections: [],
    })
    render(() => <InstallAppDialog onClose={() => {}} fetchManifest={fetchManifest} />)
    fireEvent.input(screen.getByTestId("install-app-url"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    await screen.findByTestId("install-app-scope-shopify:items:read")
    fireEvent.click(screen.getByTestId("install-app-scope-shopify:items:read"))
    const confirm = screen.getByTestId("install-app-confirm")
    expect(confirm.textContent).toMatch(/browse-only/i)
  })

  it("upgrade mode pre-checks granted scopes and highlights new ones", async () => {
    const onInstall = vi.fn().mockResolvedValue({ ok: true })
    render(() => (
      <InstallAppDialog
        mode="upgrade"
        preview={{
          manifest: {
            name: "shopify",
            version: "2.0.0",
            scopes: ["shopify:items:read", "shopify:items:write"],
            tools: {},
            connections: [],
          },
          newScopes: ["shopify:items:write"],
          removedScopes: [],
          previouslyGranted: ["shopify:items:read"],
        }}
        onClose={() => {}}
        onInstall={onInstall}
      />
    ))
    expect(screen.getByTestId("install-app-scope-shopify:items:read")).toBeChecked()
    const newScope = screen.getByTestId("install-app-scope-shopify:items:write")
    expect(newScope).toHaveAttribute("data-new", "true")
    expect(newScope).not.toBeChecked()
  })

  it("a tool needing several scopes is unavailable when any one of them is deselected", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({
      name: "boxtal",
      version: "1.0.0",
      scopes: ["boxtal:shipments:write", "boxtal:quotes:read"],
      tools: {
        create_shipment: { requiredScopes: ["boxtal:shipments:write", "boxtal:quotes:read"] },
        quote: { requiredScopes: ["boxtal:quotes:read"] },
      },
      connections: [],
    })
    render(() => <InstallAppDialog onClose={() => {}} fetchManifest={fetchManifest} />)
    fireEvent.input(screen.getByTestId("install-app-url"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    await screen.findByTestId("install-app-scope-boxtal:shipments:write")
    expect(screen.queryByTestId("install-app-disabled-tools-summary")).toBeNull()
    fireEvent.click(screen.getByTestId("install-app-scope-boxtal:shipments:write"))
    const summary = await screen.findByTestId("install-app-disabled-tools-summary")
    expect(summary.textContent).toMatch(/create_shipment/)
    expect(summary.textContent).not.toMatch(/quote\b/)
    expect(summary.textContent).toMatch(/1 of 2/)
  })

  it("admin can deselect a scope before confirming — submits only granted scopes", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({
      name: "shopify",
      version: "1.0.0",
      scopes: ["shopify:orders:read", "shopify:orders:write"],
      connections: [],
    })
    const onInstall = vi.fn().mockResolvedValue({ ok: true })
    render(() => (
      <InstallAppDialog onClose={() => {}} fetchManifest={fetchManifest} onInstall={onInstall} />
    ))
    fireEvent.input(screen.getByTestId("install-app-url"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    await screen.findByTestId("install-app-scope-shopify:orders:read")
    fireEvent.click(screen.getByTestId("install-app-scope-shopify:orders:write"))
    fireEvent.click(screen.getByTestId("install-app-confirm"))
    expect(onInstall).toHaveBeenCalledWith(
      expect.objectContaining({ grantedScopes: ["shopify:orders:read"] }),
    )
  })

  it("lists capabilities, cross-app calls (both forms) and the interface approval, and submits them", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({
      name: "acme",
      version: "1.0.0",
      scopes: [],
      connections: [],
      capabilities: ["messages.post"],
      cross_app_calls: [{ target: "mail:compose", reason: "send" }],
      dependencies: { tools: ["mail:compose", "tickets:create"] },
      hasUiBundle: true,
      signatureVerified: false,
    })
    const onInstall = vi.fn().mockResolvedValue({ ok: true })
    render(() => (
      <InstallAppDialog onClose={() => {}} fetchManifest={fetchManifest} onInstall={onInstall} />
    ))
    fireEvent.input(screen.getByTestId("install-app-url"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    await screen.findByTestId("install-app-capability-messages.post")
    expect(screen.getByTestId("install-app-cross-call-mail:compose")).toBeInTheDocument()
    expect(screen.getByTestId("install-app-cross-call-tickets:create")).toBeInTheDocument()
    fireEvent.click(screen.getByTestId("install-app-ui-approve"))
    fireEvent.click(screen.getByTestId("install-app-confirm"))
    expect(onInstall).toHaveBeenCalledWith(
      expect.objectContaining({
        grantedCapabilities: ["messages.post"],
        grantedCrossAppCalls: ["mail:compose", "tickets:create"],
        approveUiFullAccess: true,
      }),
    )
  })

  it("lists the outbound hosts an install consents to, and an upgrade's new ones only", async () => {
    const fetchManifest = vi.fn().mockResolvedValue({
      name: "acme",
      version: "1.0.0",
      scopes: [],
      outboundDomains: ["api.acme.example", "*.cdn.example"],
    })
    const onInstall = vi.fn().mockResolvedValue({ ok: true })
    render(() => (
      <InstallAppDialog onClose={() => {}} fetchManifest={fetchManifest} onInstall={onInstall} />
    ))
    fireEvent.input(screen.getByTestId("install-app-url"), { target: { value: "x" } })
    fireEvent.click(screen.getByTestId("install-app-preflight"))
    await screen.findByTestId("install-app-outbound-domain-api.acme.example")
    fireEvent.click(screen.getByTestId("install-app-confirm"))
    expect(onInstall).toHaveBeenCalledWith(
      expect.objectContaining({ grantedDomains: ["api.acme.example", "*.cdn.example"] }),
    )
  })

  it("an upgrade consents to its new outbound hosts only", async () => {
    const onInstall = vi.fn().mockResolvedValue({ ok: true })
    render(() => (
      <InstallAppDialog
        mode="upgrade"
        preview={{
          manifest: {
            name: "acme",
            version: "1.1.0",
            scopes: [],
            outboundDomains: ["a.example", "b.example"],
          },
          newScopes: [],
          removedScopes: [],
          previouslyGranted: [],
          newDomains: ["b.example"],
        }}
        onClose={() => {}}
        onInstall={onInstall}
      />
    ))
    expect(screen.getByTestId("install-app-outbound-domain-b.example")).toBeInTheDocument()
    expect(screen.queryByTestId("install-app-outbound-domain-a.example")).toBeNull()
    fireEvent.click(screen.getByTestId("install-app-confirm"))
    expect(onInstall).toHaveBeenCalledWith(
      expect.objectContaining({ grantedDomains: ["b.example"] }),
    )
  })
})
