// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ToolsTab } from "~/modules/mcp-manager/tabs/ToolsTab"
import { renderInApp } from "~/modules/mcp-manager/test-render"
import { mockApiClient } from "~/tests/helpers/mock-api"

const ID = "conn-1"

describe("ToolsTab", () => {
  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it("Empty: shows the empty-state copy when no tools discovered", async () => {
    mockApiClient({ [`/apps/mcp-manager/connections/${ID}/policy`]: [] })
    renderInApp(() => <ToolsTab connectionId={ID} tools={[]} />)
    expect(await screen.findByTestId("mcp-tools-empty")).toBeInTheDocument()
  })

  it("Populated: a row per tool with Allowed / Needs approval / Off; an override shows as set for the tool", async () => {
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/policy`]: [
        { toolName: "search", overrideDecision: "gate", roleOverrides: null },
      ],
    })
    renderInApp(() => (
      <ToolsTab
        connectionId={ID}
        tools={[
          { name: "echo", description: "echo back" },
          { name: "search", description: "search docs" },
        ]}
      />
    ))
    expect(await screen.findByTestId("mcp-tool-row-echo")).toBeInTheDocument()
    await waitFor(() =>
      expect(screen.getByTestId("mcp-tool-policy-search-gate").getAttribute("aria-pressed")).toBe(
        "true",
      ),
    )
    expect(screen.getByTestId("mcp-tool-policy-search-auto").getAttribute("aria-pressed")).toBe(
      "false",
    )
    // An override is explicit: marked as set for this tool, with its own reset.
    const search = screen.getByTestId("mcp-tool-effective-search")
    expect(search.dataset.source).toBe("override")
    expect(search).toHaveTextContent("Needs approval · set for this tool")
    expect(screen.getByTestId("mcp-tool-policy-search-gate").dataset.source).toBe("override")
    expect(screen.getByTestId("mcp-tool-reset-search")).toBeInTheDocument()
    // No override and no known default decision: it follows the server's default.
    expect(screen.getByTestId("mcp-tool-effective-echo")).toHaveTextContent(
      "Follows the server's default",
    )
    expect(screen.queryByTestId("mcp-tool-reset-echo")).toBeNull()
  })

  it("rows show the effective decision under the given default, marked default unless overridden", async () => {
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/policy`]: [
        { toolName: "create_page", overrideDecision: "auto", roleOverrides: null },
      ],
    })
    const both = { auto: "auto", gate_writes: "gate", gate_all: "gate" } as const
    renderInApp(() => (
      <ToolsTab
        connectionId={ID}
        defaultPolicy="gate_writes"
        tools={[
          {
            name: "search",
            readOnly: true,
            defaultDecisions: { auto: "auto", gate_writes: "auto", gate_all: "gate" },
          },
          { name: "delete_page", readOnly: false, defaultDecisions: both },
          { name: "create_page", readOnly: false, defaultDecisions: both },
        ]}
      />
    ))
    await waitFor(() =>
      expect(screen.getByTestId("mcp-tool-effective-create_page").dataset.source).toBe("override"),
    )
    expect(screen.getByTestId("mcp-tool-effective-search")).toHaveTextContent("Allowed · default")
    expect(screen.getByTestId("mcp-tool-effective-delete_page")).toHaveTextContent(
      "Needs approval · default",
    )
    expect(screen.getByTestId("mcp-tool-effective-create_page")).toHaveTextContent(
      "Allowed · set for this tool",
    )
    expect(screen.getByTestId("mcp-tool-policy-search-auto").getAttribute("aria-pressed")).toBe(
      "true",
    )
  })

  it("without a given default (the server page) a row uses the decision the API computed", async () => {
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/tools`]: [
        { name: "search", readOnly: true, effectiveDecision: "auto", source: "default" },
      ],
      [`/apps/mcp-manager/connections/${ID}/policy`]: [],
    })
    renderInApp(() => <ToolsTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-tool-effective-search")).toHaveTextContent(
      "Allowed · default",
    )
  })

  it("without given tools it shows the ones the server holds for the connection", async () => {
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/tools`]: [{ name: "fetch_page", description: "Reads" }],
      [`/apps/mcp-manager/connections/${ID}/policy`]: [],
    })
    renderInApp(() => <ToolsTab connectionId={ID} />)
    expect(await screen.findByTestId("mcp-tool-row-fetch_page")).toHaveTextContent("Reads")
  })

  it("a choice PUTs the decision; Reset to default clears it back to the default", async () => {
    const bodies: unknown[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("/policy") && init?.method === "PUT") {
        bodies.push(init.body ? JSON.parse(init.body as string) : null)
        return new Response(JSON.stringify({ data: { ok: true } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      const rows =
        bodies.length === 1
          ? [{ toolName: "echo", overrideDecision: "gate", roleOverrides: [] }]
          : []
      return new Response(JSON.stringify({ data: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    renderInApp(() => <ToolsTab connectionId={ID} tools={[{ name: "echo" }]} />)
    fireEvent.click(await screen.findByTestId("mcp-tool-policy-echo-gate"))
    await waitFor(() => expect(bodies).toEqual([{ toolName: "echo", overrideDecision: "gate" }]))
    await waitFor(() =>
      expect(screen.getByTestId("mcp-tool-policy-echo-gate").getAttribute("aria-pressed")).toBe(
        "true",
      ),
    )
    // Picking it again writes nothing; the per-tool reset clears it.
    fireEvent.click(screen.getByTestId("mcp-tool-policy-echo-gate"))
    fireEvent.click(screen.getByTestId("mcp-tool-reset-echo"))
    await waitFor(() => expect(bodies[1]).toEqual({ toolName: "echo", overrideDecision: null }))
    expect(bodies).toHaveLength(2)
  })

  it("a tool Liaison could not register shows as Unavailable with the reason, and no choices", async () => {
    mockApiClient({
      [`/apps/mcp-manager/connections/${ID}/policy`]: [],
      [`/apps/mcp-manager/connections/${ID}/tools`]: [
        {
          name: "search",
          readOnly: true,
          effectiveDecision: "auto",
          source: "default",
        },
        {
          name: "remote_shape",
          description: "Refers to a remote schema",
          readOnly: false,
          unavailableReason: "unsupported remote $ref: https://schemas.example.com/q.json",
        },
      ],
    })
    renderInApp(() => <ToolsTab connectionId={ID} />)
    const row = await screen.findByTestId("mcp-tool-row-remote_shape")
    expect(row.dataset.unavailable).toBe("true")
    expect(screen.getByTestId("mcp-tool-unavailable-remote_shape")).toHaveTextContent("Unavailable")
    expect(screen.getByTestId("mcp-tool-unavailable-reason-remote_shape")).toHaveTextContent(
      "unsupported remote $ref: https://schemas.example.com/q.json",
    )
    // Never callable, so nothing to choose: no decision buttons, no Read / Write badge.
    expect(screen.queryByTestId("mcp-tool-policy-remote_shape-auto")).toBeNull()
    expect(screen.queryByTestId("mcp-tool-kind-remote_shape")).toBeNull()
    // The usable tool next to it is unaffected.
    expect(screen.getByTestId("mcp-tool-policy-search-auto")).toBeInTheDocument()
  })

  it("badges each tool Read or Write from the server's annotations", async () => {
    mockApiClient({ [`/apps/mcp-manager/connections/${ID}/policy`]: [] })
    renderInApp(() => (
      <ToolsTab
        connectionId={ID}
        tools={[
          { name: "search", readOnly: true },
          { name: "create_page", readOnly: false },
        ]}
      />
    ))
    expect((await screen.findByTestId("mcp-tool-kind-search")).dataset.kind).toBe("read")
    expect(screen.getByTestId("mcp-tool-kind-create_page").dataset.kind).toBe("write")
  })

  it('"Reset all to default" clears every override in ONE request; there are no per-tool bulk writes', async () => {
    const puts: Array<{ url: string; body: unknown }> = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (init?.method === "PUT") {
        puts.push({ url, body: init.body ? JSON.parse(init.body as string) : null })
        return new Response(JSON.stringify({ data: { ok: true, count: 2 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }
      const rows =
        puts.length === 0
          ? [
              { toolName: "search", overrideDecision: "auto", roleOverrides: null },
              { toolName: "create_page", overrideDecision: "deny", roleOverrides: null },
            ]
          : []
      return new Response(JSON.stringify({ data: rows }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    })
    renderInApp(() => (
      <ToolsTab
        connectionId={ID}
        tools={[
          { name: "search", readOnly: true },
          { name: "list_pages", readOnly: true },
          { name: "create_page", readOnly: false },
        ]}
      />
    ))
    expect(screen.queryByTestId("mcp-tools-bulk-allow-reads")).toBeNull()
    expect(screen.queryByTestId("mcp-tools-bulk-approve-all")).toBeNull()
    fireEvent.click(await screen.findByTestId("mcp-tools-bulk-reset"))
    await waitFor(() => expect(puts).toHaveLength(1))
    expect(puts[0]?.url).toContain(`/connections/${ID}/policy/bulk`)
    expect(puts[0]?.body).toEqual({
      decisions: [
        { toolName: "search", overrideDecision: null },
        { toolName: "create_page", overrideDecision: null },
      ],
    })
    await waitFor(() => expect(screen.queryByTestId("mcp-tools-bulk")).toBeNull())
  })

  it("not editable: no per-tool choices and no bulk choices", async () => {
    mockApiClient({ [`/apps/mcp-manager/connections/${ID}/policy`]: [] })
    renderInApp(() => (
      <ToolsTab connectionId={ID} tools={[{ name: "search", readOnly: true }]} editable={false} />
    ))
    expect(await screen.findByTestId("mcp-tool-row-search")).toBeInTheDocument()
    expect(screen.queryByTestId("mcp-tool-policy-search-auto")).toBeNull()
    expect(screen.queryByTestId("mcp-tools-bulk")).toBeNull()
  })
})
