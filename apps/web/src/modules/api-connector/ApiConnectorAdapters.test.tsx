// SPDX-License-Identifier: FSL-1.1-ALv2

import type {
  AdapterVersionList,
  ConnectionList,
  ConnectionSummary,
  TestOperationResult,
} from "@liaison/api-connector-core/contract"
import { fireEvent, render, screen, waitFor, within } from "@solidjs/testing-library"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ApiError } from "~/lib/api-error"

const state = vi.hoisted(() => ({
  api: {
    get: vi.fn(),
    put: vi.fn(),
    post: vi.fn(),
    delete: vi.fn(),
  } as Record<"get" | "put" | "post" | "delete", ReturnType<typeof vi.fn>>,
}))

vi.mock("~/modules/shell/ApiContext", () => ({ useApi: () => state.api }))
// A fresh store, as on a first visit: the branding fetch has not answered, so
// nothing about demo mode may come from it (P2-V1).
vi.mock("~/modules/shell/branding-store", () => ({ demoMode: () => false }))

import ApiConnectorAdapters from "./ApiConnectorAdapters"

const crm: ConnectionSummary = {
  identifier: "crm",
  name: "Fixture CRM",
  adapterId: "fixture-crm",
  adapterVersion: "1.0.0",
  baseUrl: "https://crm.example.com",
  roles: ["customer.lookup", "customer.orders"],
  status: "ok",
  auth: { type: "apiKey", in: "header", name: "X-Api-Key" },
  operations: [
    {
      name: "find_contact",
      kind: "read",
      role: "customer.lookup",
      description: "Find a contact.",
      params: {
        type: "object",
        properties: { email: { type: "string" }, limit: { type: "integer" } },
        required: ["email"],
      },
      fields: ["id", "name", "company.name"],
    },
    {
      name: "list_orders",
      kind: "read",
      role: "customer.orders",
      description: "List orders.",
      params: { type: "object", properties: {} },
      fields: ["id"],
    },
    {
      name: "create_note",
      kind: "write",
      description: "Create a note.",
      params: { type: "object", properties: {} },
      fields: ["id"],
    },
  ],
}

const erp: ConnectionSummary = {
  identifier: "erp",
  name: "Warehouse ERP",
  adapterId: "erp",
  adapterVersion: "2.1.0",
  baseUrl: "https://erp.example.com",
  roles: [],
  status: "needs_credentials",
  auth: { type: "oauth2ClientCredentials" },
  operations: [
    {
      name: "stock",
      kind: "read",
      description: "Stock levels.",
      params: { type: "object", properties: {} },
      fields: ["sku"],
    },
  ],
}

function listOf(connections: ConnectionSummary[], readOnly = false): ConnectionList {
  return readOnly ? { connections, readOnly, readOnlyReason: "demo" } : { connections, readOnly }
}

async function renderLoaded(list: ConnectionSummary[] = [crm], readOnly = false) {
  state.api.get.mockResolvedValue(listOf(list, readOnly))
  render(() => <ApiConnectorAdapters />)
  await waitFor(() => expect(screen.getByTestId("api-connector-settings-list")).toBeTruthy())
}

describe("ApiConnectorAdapters", () => {
  beforeEach(() => {
    for (const key of ["get", "put", "post", "delete"] as const) state.api[key] = vi.fn()
  })

  it("lists each connection with its system, status and the roles it fills", async () => {
    await renderLoaded([crm, erp])
    expect(state.api.get).toHaveBeenCalledWith("/api-connector/adapters", {
      suppressGlobalError: true,
    })
    const row = screen.getByTestId("api-connector-connection-crm")
    expect(row.textContent).toContain("Fixture CRM")
    expect(row.textContent).toContain("fixture-crm")
    expect(row.textContent).toContain("1.0.0")
    expect(row.textContent).toContain("customer.lookup")
    expect(screen.getByTestId("api-connector-status-crm").textContent).toBe("Connected")
    expect(screen.getByTestId("api-connector-status-erp").textContent).toBe("Needs credentials")
  })

  it("adds a connection from pasted YAML and shows each refusal at its path", async () => {
    await renderLoaded([])
    expect(screen.getByTestId("api-connector-empty")).toBeTruthy()
    fireEvent.click(screen.getByTestId("api-connector-add"))
    // An inline settings flow, never a modal.
    expect(screen.queryByRole("dialog")).toBeNull()
    const form = screen.getByTestId("api-connector-adapter-form")
    fireEvent.input(within(form).getByTestId("api-connector-slug"), { target: { value: "crm" } })
    fireEvent.input(within(form).getByTestId("api-connector-adapter-text"), {
      target: { value: "id: fixture-crm\noperations: []\n" },
    })
    const issues = [
      { path: "operations", message: "must have at least one operation" },
      { path: "baseUrl", message: "must be https" },
    ]
    state.api.put.mockRejectedValue(
      new ApiError("Invalid adapter", 422, "invalid_adapter", undefined, { issues }),
    )
    fireEvent.click(within(form).getByTestId("api-connector-adapter-save"))
    await waitFor(() => expect(screen.getAllByTestId("api-connector-issue").length).toBe(2))
    const [path, body] = state.api.put.mock.calls[0] as [string, unknown]
    expect(path).toBe("/api-connector/adapters/crm")
    expect(body).toBeInstanceOf(Blob)
    expect((body as Blob).type).toBe("text/yaml")
    const shown = screen.getAllByTestId("api-connector-issue")
    expect(shown[0]?.dataset.path).toBe("operations")
    expect(shown[0]?.textContent).toContain("must have at least one operation")
    expect(shown[1]?.dataset.path).toBe("baseUrl")
  })

  it("sends a JSON adapter as JSON, refreshes the list and asks for credentials next", async () => {
    await renderLoaded([])
    fireEvent.click(screen.getByTestId("api-connector-add"))
    fireEvent.input(screen.getByTestId("api-connector-slug"), { target: { value: "crm" } })
    fireEvent.input(screen.getByTestId("api-connector-adapter-text"), {
      target: { value: '{"id":"fixture-crm"}' },
    })
    state.api.put.mockResolvedValue({ ...crm, status: "needs_credentials" })
    state.api.get.mockResolvedValue(listOf([{ ...crm, status: "needs_credentials" }]))
    fireEvent.click(screen.getByTestId("api-connector-adapter-save"))
    await waitFor(() => expect(screen.getByTestId("api-connector-credentials-form")).toBeTruthy())
    expect(state.api.put.mock.calls[0]?.[1]).toEqual({ id: "fixture-crm" })
    expect(state.api.get).toHaveBeenCalledTimes(2)
  })

  it("refuses a slug the server would refuse, before sending anything", async () => {
    await renderLoaded([])
    fireEvent.click(screen.getByTestId("api-connector-add"))
    fireEvent.input(screen.getByTestId("api-connector-slug"), { target: { value: "My CRM" } })
    fireEvent.input(screen.getByTestId("api-connector-adapter-text"), {
      target: { value: "id: x" },
    })
    fireEvent.click(screen.getByTestId("api-connector-adapter-save"))
    expect(screen.getByTestId("api-connector-slug-error")).toBeTruthy()
    expect(state.api.put).not.toHaveBeenCalled()
  })

  it("derives the credentials form from the adapter's auth and posts it org-owned under the slug", async () => {
    await renderLoaded([crm, erp])
    fireEvent.click(screen.getByTestId("api-connector-credentials-crm"))
    const form = screen.getByTestId("api-connector-credentials-form")
    expect(within(form).getByTestId("api-connector-cred-apiKey")).toBeTruthy()
    expect(within(form).queryByTestId("api-connector-cred-clientId")).toBeNull()
    const input = within(form).getByTestId("api-connector-cred-apiKey") as HTMLInputElement
    expect(input.type).toBe("password")
    fireEvent.input(input, { target: { value: "sk-live-123" } })
    state.api.post.mockResolvedValue({ id: "acct-1" })
    fireEvent.click(within(form).getByTestId("api-connector-cred-save"))
    await waitFor(() => expect(screen.getByTestId("api-connector-cred-saved")).toBeTruthy())
    expect(state.api.post).toHaveBeenCalledWith(
      "/connections/api-connector/api/credentials",
      { mode: "org", credentials: { identifier: "crm", apiKey: "sk-live-123" } },
      { suppressGlobalError: true },
    )
    // The secret is never shown back once saved.
    expect(screen.getByTestId("api-connector-settings").innerHTML).not.toContain("sk-live-123")

    fireEvent.click(screen.getByTestId("api-connector-credentials-erp"))
    const oauth = screen.getByTestId("api-connector-credentials-form")
    expect(within(oauth).getByTestId("api-connector-cred-clientId")).toBeTruthy()
    expect(within(oauth).getByTestId("api-connector-cred-clientSecret")).toBeTruthy()
    // The token URL is the adapter's, never a credential field.
    expect(within(oauth).queryByTestId("api-connector-cred-tokenUrl")).toBeNull()
  })

  it("offers only read operations to test, with a params form from the schema", async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId("api-connector-test-crm"))
    const panel = screen.getByTestId("api-connector-test-panel")
    const select = within(panel).getByTestId("api-connector-test-operation") as HTMLSelectElement
    const names = Array.from(select.options).map((o) => o.value)
    expect(names).toEqual(["find_contact", "list_orders"])
    expect(within(panel).getByTestId("api-connector-param-email")).toBeTruthy()
    expect(within(panel).getByTestId("api-connector-param-limit")).toBeTruthy()

    // A missing required param is named, and nothing is sent.
    fireEvent.click(within(panel).getByTestId("api-connector-test-run"))
    expect(within(panel).getByTestId("api-connector-param-error-email")).toBeTruthy()
    expect(state.api.post).not.toHaveBeenCalled()

    fireEvent.input(within(panel).getByTestId("api-connector-param-email"), {
      target: { value: "buyer@acme.example" },
    })
    fireEvent.input(within(panel).getByTestId("api-connector-param-limit"), {
      target: { value: "3" },
    })
    state.api.post.mockResolvedValue({
      ok: true,
      status: 200,
      ms: 42,
      items: [
        { id: "c-1", name: "Ada", company: { name: "Acme Instruments" } },
        { id: "c-2", name: "Lin", company: { name: "Acme GmbH" } },
      ],
    })
    fireEvent.click(within(panel).getByTestId("api-connector-test-run"))
    await waitFor(() => expect(within(panel).getByTestId("api-connector-test-result")).toBeTruthy())
    expect(state.api.post).toHaveBeenCalledWith(
      "/api-connector/adapters/crm/test",
      { operation: "find_contact", params: { email: "buyer@acme.example", limit: 3 } },
      { suppressGlobalError: true },
    )
    expect(within(panel).getByTestId("api-connector-test-status").textContent).toContain("200")
    expect(within(panel).getByTestId("api-connector-test-ms").textContent).toContain("42")
    expect(within(panel).getByTestId("api-connector-test-count").textContent).toBe("2 items")
    const table = within(panel).getByTestId("api-connector-test-items")
    const headers = Array.from(table.querySelectorAll("th")).map((th) => th.textContent)
    expect(headers).toEqual(["id", "name", "company.name"])
    expect(table.querySelectorAll('[data-testid="api-connector-test-row"]').length).toBe(2)
    expect(table.textContent).toContain("Acme Instruments")
  })

  it("shows a refused test by its code, never a raw upstream body", async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId("api-connector-test-crm"))
    fireEvent.change(screen.getByTestId("api-connector-test-operation"), {
      target: { value: "list_orders" },
    })
    state.api.post.mockRejectedValue(
      new ApiError("upstream body: Bearer abc.def", 502, "upstream_status"),
    )
    fireEvent.click(screen.getByTestId("api-connector-test-run"))
    await waitFor(() => expect(screen.getByTestId("api-connector-test-error")).toBeTruthy())
    expect(screen.getByTestId("api-connector-test-error").textContent).not.toContain("Bearer")
    expect(screen.getByTestId("api-connector-test-error").textContent).toContain(
      "The system answered with an error",
    )
  })

  it("shows an upstream failure the route answered as a result by its code", async () => {
    // The route answers a failed upstream call with 200 {ok:false, code}: the
    // test request itself was fine, the system behind it was not.
    await renderLoaded()
    fireEvent.click(screen.getByTestId("api-connector-test-crm"))
    fireEvent.change(screen.getByTestId("api-connector-test-operation"), {
      target: { value: "list_orders" },
    })
    state.api.post.mockResolvedValue({
      ok: false,
      status: 401,
      code: "upstream_status",
      message: "The API answered HTTP 401 for list_orders.",
      ms: 12,
    } satisfies TestOperationResult)
    fireEvent.click(screen.getByTestId("api-connector-test-run"))
    await waitFor(() => expect(screen.getByTestId("api-connector-test-error")).toBeTruthy())
    // The admin Test panel names the upstream's HTTP code, and nothing of its body.
    expect(screen.getByTestId("api-connector-test-error").textContent).toBe(
      "The system answered HTTP 401.",
    )
    expect(screen.queryByTestId("api-connector-test-result")).toBeNull()
  })

  it("counts one item in the singular (P2-V6)", async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId("api-connector-test-crm"))
    fireEvent.change(screen.getByTestId("api-connector-test-operation"), {
      target: { value: "list_orders" },
    })
    state.api.post.mockResolvedValue({
      ok: true,
      status: 200,
      ms: 3,
      truncated: false,
      items: [{ id: "o-1" }],
    } satisfies TestOperationResult)
    fireEvent.click(screen.getByTestId("api-connector-test-run"))
    await waitFor(() => expect(screen.getByTestId("api-connector-test-count")).toBeTruthy())
    expect(screen.getByTestId("api-connector-test-count").textContent).toBe("1 item")
  })

  it("deletes only after an inline confirmation, and can be cancelled", async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId("api-connector-delete-crm"))
    expect(screen.queryByRole("dialog")).toBeNull()
    expect(screen.getByTestId("api-connector-delete-confirm-crm")).toBeTruthy()
    fireEvent.click(screen.getByTestId("api-connector-delete-no-crm"))
    expect(screen.queryByTestId("api-connector-delete-confirm-crm")).toBeNull()
    expect(state.api.delete).not.toHaveBeenCalled()

    fireEvent.click(screen.getByTestId("api-connector-delete-crm"))
    state.api.delete.mockResolvedValue(undefined)
    state.api.get.mockResolvedValue(listOf([]))
    fireEvent.click(screen.getByTestId("api-connector-delete-yes-crm"))
    await waitFor(() => expect(screen.getByTestId("api-connector-empty")).toBeTruthy())
    expect(state.api.delete).toHaveBeenCalledWith("/api-connector/adapters/crm", undefined, {
      suppressGlobalError: true,
    })
  })

  it("is read-only when the adapters list says so: no add, replace, delete or credentials, testing stays", async () => {
    await renderLoaded([crm], true)
    expect(screen.getByTestId("api-connector-demo-readonly")).toBeTruthy()
    expect(screen.queryByTestId("api-connector-add")).toBeNull()
    expect(screen.queryByTestId("api-connector-replace-crm")).toBeNull()
    expect(screen.queryByTestId("api-connector-delete-crm")).toBeNull()
    expect(screen.queryByTestId("api-connector-credentials-crm")).toBeNull()
    expect(screen.getByTestId("api-connector-test-crm")).toBeTruthy()
  })

  it("shows a load failure with a retry", async () => {
    state.api.get
      .mockRejectedValueOnce(new ApiError("boom", 500))
      .mockResolvedValueOnce(listOf([crm]))
    render(() => <ApiConnectorAdapters />)
    await waitFor(() => expect(screen.getByTestId("api-connector-settings-error")).toBeTruthy())
    fireEvent.click(screen.getByTestId("api-connector-settings-retry"))
    await waitFor(() => expect(screen.getByTestId("api-connector-connection-crm")).toBeTruthy())
  })
  it("a replacement that deletes the credentials shows both targets and saves only when confirmed", async () => {
    await renderLoaded()
    fireEvent.click(screen.getByTestId("api-connector-replace-crm"))
    const form = screen.getByTestId("api-connector-adapter-form")
    fireEvent.input(within(form).getByTestId("api-connector-adapter-text"), {
      target: { value: '{"id":"fixture-crm"}' },
    })
    state.api.put.mockRejectedValueOnce(
      new ApiError(
        "Saving this adapter moves the credential target",
        409,
        "confirm_credential_wipe",
        undefined,
        {
          priorTarget: "https://crm.example.com, apiKey",
          newTarget: "https://other-crm.example.com, apiKey",
        },
      ),
    )
    fireEvent.click(within(form).getByTestId("api-connector-adapter-save"))
    const warning = await waitFor(() => screen.getByTestId("api-connector-wipe-warning"))
    expect(warning.textContent).toContain("https://crm.example.com")
    expect(warning.textContent).toContain("https://other-crm.example.com")
    expect(state.api.put.mock.calls[0]?.[0]).toBe("/api-connector/adapters/crm")
    state.api.put.mockResolvedValueOnce({ ...crm, credentialsCleared: true })
    fireEvent.click(screen.getByTestId("api-connector-adapter-save-confirm"))
    await waitFor(() => expect(state.api.put).toHaveBeenCalledTimes(2))
    expect(state.api.put.mock.calls[1]?.[0]).toBe(
      "/api-connector/adapters/crm?confirmCredentialWipe=true",
    )
  })

  describe("history", () => {
    const history: AdapterVersionList = {
      identifier: "crm",
      current: { adapterVersion: "1.0.0", target: "https://crm.example.com, apiKey" },
      versions: [
        {
          id: "11111111-1111-4111-8111-111111111111",
          adapterVersion: "0.9.0",
          name: "Fixture CRM",
          savedBy: "u1",
          savedByName: "Dana Admin",
          savedAt: "2026-10-20T09:00:00.000Z",
          target: "https://crm.example.com, apiKey",
          targetDiffers: false,
        },
        {
          id: "22222222-2222-4222-8222-222222222222",
          adapterVersion: "0.5.0",
          name: "Old CRM",
          savedBy: null,
          savedByName: null,
          savedAt: "2026-10-01T09:00:00.000Z",
          target: "https://old-crm.example.com, bearer",
          targetDiffers: true,
        },
      ],
    }

    async function openHistory() {
      state.api.get.mockImplementation(async (path: string) =>
        path.endsWith("/versions") ? history : listOf([crm]),
      )
      render(() => <ApiConnectorAdapters />)
      await waitFor(() => expect(screen.getByTestId("api-connector-history-crm")).toBeTruthy())
      fireEvent.click(screen.getByTestId("api-connector-history-crm"))
      await waitFor(() => expect(screen.getAllByTestId(/^api-connector-version-/).length).toBe(2))
    }

    it("lists the kept versions with who saved them and when, beside Replace", async () => {
      await openHistory()
      expect(state.api.get).toHaveBeenCalledWith("/api-connector/adapters/crm/versions", {
        suppressGlobalError: true,
      })
      const first = screen.getByTestId(`api-connector-version-${history.versions[0]?.id}`)
      expect(first.textContent).toContain("0.9.0")
      expect(first.textContent).toContain("Dana Admin")
      expect(screen.queryByRole("dialog")).toBeNull()
    })

    it("restores a version on the same target at once", async () => {
      await openHistory()
      const id = history.versions[0]?.id ?? ""
      state.api.post.mockResolvedValue({ ...crm, credentialsCleared: false })
      fireEvent.click(screen.getByTestId(`api-connector-restore-${id}`))
      await waitFor(() =>
        expect(state.api.post).toHaveBeenCalledWith(
          "/api-connector/adapters/crm/restore",
          { versionId: id },
          { suppressGlobalError: true },
        ),
      )
      await waitFor(() => expect(screen.getByTestId("api-connector-restored")).toBeTruthy())
    })

    it("warns before restoring a version that deletes the credentials, and sends the confirmation", async () => {
      await openHistory()
      const id = history.versions[1]?.id ?? ""
      fireEvent.click(screen.getByTestId(`api-connector-restore-${id}`))
      const warning = screen.getByTestId(`api-connector-restore-warning-${id}`)
      expect(warning.textContent).toContain("https://old-crm.example.com")
      expect(state.api.post).not.toHaveBeenCalled()
      state.api.post.mockResolvedValue({ ...crm, credentialsCleared: true })
      fireEvent.click(screen.getByTestId(`api-connector-restore-confirm-${id}`))
      await waitFor(() =>
        expect(state.api.post).toHaveBeenCalledWith(
          "/api-connector/adapters/crm/restore",
          { versionId: id, confirmCredentialWipe: true },
          { suppressGlobalError: true },
        ),
      )
    })

    it("says when there is no earlier version", async () => {
      state.api.get.mockImplementation(async (path: string) =>
        path.endsWith("/versions") ? { ...history, versions: [] } : listOf([crm]),
      )
      render(() => <ApiConnectorAdapters />)
      await waitFor(() => expect(screen.getByTestId("api-connector-history-crm")).toBeTruthy())
      fireEvent.click(screen.getByTestId("api-connector-history-crm"))
      await waitFor(() => expect(screen.getByTestId("api-connector-history-empty")).toBeTruthy())
    })

    it("is not offered in a read-only workspace", async () => {
      await renderLoaded([crm], true)
      expect(screen.queryByTestId("api-connector-history-crm")).toBeNull()
    })
  })
})
