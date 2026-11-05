// SPDX-License-Identifier: FSL-1.1-ALv2
import { Route, Router } from "@solidjs/router"
import { fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, describe, expect, it, vi } from "vitest"
import ImportsSettings, { type ImportRunRow } from "~/modules/settings/imports/ImportsSettings"
import { ApiProvider } from "~/modules/shell/ApiContext"

function jsonResp(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

function run(over: Partial<ImportRunRow>): ImportRunRow {
  return {
    id: "00000000-0000-4000-8000-000000000001",
    kindSet: ["tickets.ticket"],
    sourceLabel: "jira",
    status: "done",
    counts: { "tickets.ticket": { created: 3, skipped: 1, failed: 0 } },
    startedBy: null,
    createdAt: "2026-10-01T10:00:00Z",
    ...over,
  }
}

function renderView() {
  window.history.pushState({}, "", "/settings/org")
  return render(() => (
    <Router>
      <Route
        path="*"
        component={() => (
          <ApiProvider>
            <ImportsSettings />
          </ApiProvider>
        )}
      />
    </Router>
  ))
}

afterEach(() => vi.unstubAllGlobals())

describe("ImportsSettings", () => {
  it("lists runs with status and counts; Undo only on a finished run", async () => {
    const done = run({})
    const running = run({ id: "00000000-0000-4000-8000-000000000002", status: "running" })
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) =>
        jsonResp({ data: String(url).endsWith("/imports/transforms") ? [] : [done, running] }),
      ),
    )
    renderView()
    expect(await screen.findByTestId(`import-run-${done.id}`)).toBeInTheDocument()
    expect(screen.getByTestId(`import-run-counts-${done.id}`).textContent).toContain("3")
    expect(screen.getByTestId(`import-run-undo-${done.id}`)).toBeInTheDocument()
    expect(screen.queryByTestId(`import-run-undo-${running.id}`)).toBeNull()
  })

  it("Undo posts to the run's undo route and reloads the list", async () => {
    const done = run({})
    const calls: Array<{ url: string; method: string }> = []
    let undone = false
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push({ url: String(url), method: init?.method ?? "GET" })
        if (String(url).endsWith(`/imports/${done.id}/undo`)) {
          undone = true
          return jsonResp({ data: { deleted: 4, refused: [] } })
        }
        if (String(url).endsWith("/imports/transforms")) return jsonResp({ data: [] })
        return jsonResp({ data: [undone ? { ...done, status: "undone" } : done] })
      }),
    )
    renderView()
    fireEvent.click(await screen.findByTestId(`import-run-undo-${done.id}`))
    await waitFor(() =>
      expect(
        calls.some((c) => c.method === "POST" && c.url.endsWith(`/imports/${done.id}/undo`)),
      ).toBe(true),
    )
    await waitFor(() => expect(screen.queryByTestId(`import-run-undo-${done.id}`)).toBeNull())
  })

  it("shows the empty state", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResp({ data: [] })),
    )
    renderView()
    expect(await screen.findByTestId("imports-empty")).toBeInTheDocument()
  })

  it("a person uploads an export, picks a transform, previews it and starts it", async () => {
    const calls: Array<{ url: string; method: string; body?: unknown }> = []
    const puts: Array<{ url: string; size: number }> = []
    const previewId = "00000000-0000-4000-8000-0000000000aa"
    const runId = "00000000-0000-4000-8000-0000000000bb"
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input)
        const method = init?.method ?? "GET"
        if (method === "PUT" && init?.body instanceof Blob) {
          puts.push({ url, size: init.body.size })
          return new Response(null, { status: 200, headers: { etag: '"e1"' } })
        }
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : undefined
        calls.push({ url, method, body })
        if (url.endsWith("/imports/transforms")) {
          return jsonResp({
            data: [
              {
                id: "t1",
                name: "helpscout-csv",
                version: 2,
                kinds: ["tickets.ticket"],
                sourceType: "upload",
                connection: null,
              },
            ],
          })
        }
        if (url.endsWith("/imports/uploads") && method === "POST") {
          return jsonResp({
            data: {
              id: "up1",
              mode: "multipart",
              partSize: 8388608,
              partCount: 1,
              parts: [{ partNumber: 1, url: "https://store.example.com/part1" }],
            },
          })
        }
        if (url.endsWith("/imports/uploads/up1/complete")) {
          return jsonResp({
            data: { id: "up1", status: "complete", fileId: "11111111-1111-4111-8111-111111111111" },
          })
        }
        if (url.endsWith("/imports/previews")) {
          return jsonResp({
            data: {
              previewId,
              transform: "helpscout-csv v2",
              counts: { "tickets.ticket": { created: 12, skipped: 0, failed: 0 } },
              errorRate: 0,
              errors: [],
              report: { cutAtLimit: false },
              samples:
                '<external-content source="untrusted">{"tickets.ticket":[{"subject":"Refund"}]}</external-content>',
            },
          })
        }
        if (url.endsWith(`/imports/previews/${previewId}/start`))
          return jsonResp({ data: { runId, status: "queued" } }, 202)
        if (url.endsWith(`/imports/${runId}`)) {
          return jsonResp({
            data: {
              ...run({ id: runId, status: "queued" }),
              dryRun: false,
              errors: [],
              report: {},
              finishedAt: null,
            },
          })
        }
        return jsonResp({ data: [] })
      }),
    )
    renderView()
    const fileInput = (await screen.findByTestId("imports-new-files")) as HTMLInputElement
    const file = new File(["id,subject\n1,Refund\n"], "conversations.csv", { type: "text/csv" })
    fireEvent.change(fileInput, { target: { files: [file] } })
    await waitFor(() =>
      expect(screen.getByTestId("imports-new-files-ready")).toHaveTextContent("conversations.csv"),
    )
    expect(puts).toEqual([{ url: "https://store.example.com/part1", size: file.size }])
    const select = (await screen.findByTestId("imports-new-transform")) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
    fireEvent.change(select, { target: { value: "helpscout-csv" } })
    fireEvent.click(screen.getByTestId("imports-new-preview"))
    await waitFor(() =>
      expect(screen.getByTestId("imports-new-preview-result")).toHaveTextContent("12"),
    )
    const preview = calls.find((c) => c.url.endsWith("/imports/previews"))
    expect(preview?.body).toMatchObject({
      transform: "helpscout-csv",
      fileIds: ["11111111-1111-4111-8111-111111111111"],
      sourceLabel: "helpscout-csv",
    })
    // The samples are shown as text, never as markup.
    expect(screen.getByTestId("imports-new-samples").textContent).toContain("Refund")
    fireEvent.click(screen.getByTestId("imports-new-start"))
    expect(await screen.findByTestId(`import-run-card-${runId}`)).toBeInTheDocument()
  })

  it("a preview with too many refused records cannot be started", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string, init?: RequestInit) => {
        const url = String(input)
        if (url.endsWith("/imports/transforms")) {
          return jsonResp({
            data: [
              {
                id: "t1",
                name: "jira-sm",
                version: 1,
                kinds: ["tickets.ticket"],
                sourceType: "api",
                connection: "jira",
              },
            ],
          })
        }
        if (url.endsWith("/imports/previews") && init?.method === "POST") {
          return jsonResp({
            data: {
              previewId: "p",
              counts: { "tickets.ticket": { created: 8, skipped: 0, failed: 2 } },
              errorRate: 0.2,
              errors: [{ error: "bad", at: "page 1" }],
              report: {},
              samples: "",
            },
          })
        }
        return jsonResp({ data: [] })
      }),
    )
    renderView()
    const select = (await screen.findByTestId("imports-new-transform")) as HTMLSelectElement
    await waitFor(() => expect(select.options.length).toBeGreaterThan(1))
    fireEvent.change(select, { target: { value: "jira-sm" } })
    // An API transform needs no file.
    fireEvent.click(screen.getByTestId("imports-new-preview"))
    expect(await screen.findByTestId("imports-new-too-many-refused")).toBeInTheDocument()
    expect((screen.getByTestId("imports-new-start") as HTMLButtonElement).disabled).toBe(true)
  })
})
