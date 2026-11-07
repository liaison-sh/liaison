// SPDX-License-Identifier: FSL-1.1-ALv2
import { cleanup, fireEvent, render, screen, waitFor } from "@solidjs/testing-library"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ApiClient } from "~/lib/api-client"
import { ApiContext } from "~/modules/shell/ApiContext"

const state = vi.hoisted(() => ({ scopes: [] as string[] }))
vi.mock("~/modules/auth/auth-store", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/modules/auth/auth-store")>()
  return {
    ...actual,
    hasScope: (s: string) => state.scopes.includes("*") || state.scopes.includes(s),
    inWrappedShell: () => false,
  }
})

import { BuilderView, buildState } from "./BuilderView"
import { draftTitle, resetBuilderStore } from "./builder-store"

const ID = "11111111-1111-4111-8111-111111111111"
const manifest = JSON.stringify({
  name: "tracker-oabcdef12",
  tools: { items_list: { handler: "items_list" } },
  views: { tabTypes: { main: { component: "TrackerMain" } } },
})

function draftBody(opts: { build?: unknown; preview?: boolean; status?: string } = {}) {
  return {
    draft: {
      id: ID,
      orgId: "o",
      baseName: "tracker",
      title: "Returns tracker",
      status: opts.status ?? "draft",
      publishedAppName: null,
      latestVersion: 2,
      createdAt: "",
      updatedAt: "",
    },
    appName: "tracker-oabcdef12",
    version: {
      draftId: ID,
      n: 2,
      files: { "app.manifest.json": manifest, "handlers.ts": "export const x = 1\n" },
      message: null,
      build: opts.build ?? null,
      createdAt: "",
    },
    preview: opts.preview
      ? {
          frameUrl: `/api/apps/builder/drafts/${ID}/2/frame?t=tok`,
          uiUrl: `/api/apps/builder/drafts/${ID}/2/ui.js`,
        }
      : null,
  }
}

const versions = [
  { n: 2, message: null, build: null, sizeBytes: 10, createdAt: "" },
  { n: 1, message: "Created", build: { ok: true, at: "" }, sizeBytes: 10, createdAt: "" },
]

function mount(opts: {
  draft?: ReturnType<typeof draftBody>
  post?: (path: string, body: any) => Promise<unknown>
}) {
  const api = {
    get: vi.fn(async (path: string) => {
      if (path.endsWith("/versions")) return versions
      return opts.draft ?? draftBody()
    }),
    post: vi.fn(async (path: string, body: any) => (opts.post ? opts.post(path, body) : {})),
    rawGet: vi.fn(async () => new Response("")),
  }
  render(() => (
    <ApiContext.Provider value={api as unknown as ApiClient}>
      <BuilderView entityId={ID} />
    </ApiContext.Provider>
  ))
  return api
}

beforeEach(() => {
  state.scopes = ["kernel:apps:build"]
  resetBuilderStore()
})
afterEach(cleanup)

describe("BuilderView", () => {
  it("shows the toolbar first, versions with build status, and no build yet", async () => {
    mount({})
    await waitFor(() =>
      expect(screen.getByTestId("builder-title").textContent).toBe("Returns tracker"),
    )
    expect(draftTitle(ID)).toBe("Returns tracker")
    const toolbar = screen.getByTestId("builder-toolbar")
    for (const id of ["builder-check", "builder-preview", "builder-publish", "builder-discard"]) {
      expect(toolbar.contains(screen.getByTestId(id))).toBe(true)
    }
    expect(screen.getByTestId("builder-no-build")).toBeTruthy()
    await waitFor(() => expect(screen.getByTestId("builder-version-1")).toBeTruthy())
    expect(screen.getByTestId("builder-version-2").dataset.build).toBe("none")
    expect(screen.getByTestId("builder-version-1").dataset.build).toBe("ok")
    // Restore is offered on older versions only.
    expect(screen.getByTestId("builder-restore-1")).toBeTruthy()
    expect(screen.queryByTestId("builder-restore-2")).toBeNull()
    // The files, one at a time, read-only.
    expect(screen.getByTestId("builder-code-view").dataset.file).toBe("app.manifest.json")
    fireEvent.click(screen.getByTestId("builder-file-handlers.ts"))
    expect(screen.getByTestId("builder-code-view").textContent).toContain("export const x = 1")
    // No interface built: no frame.
    expect(screen.queryByTestId("builder-ui-preview")).toBeNull()
  })

  it("lists build errors with file and line after Check", async () => {
    const api = mount({
      post: async () => ({
        draftId: ID,
        n: 2,
        ok: false,
        errors: [{ file: "handlers.ts", line: 7, message: "Unexpected token" }],
        typecheck: { ok: false, errors: [{ file: "ui.tsx", line: 3, message: "Type error" }] },
        appName: "tracker-oabcdef12",
        appVersion: "0.1.0",
        packageSha256: null,
        sizeBytes: null,
      }),
    })
    await waitFor(() => screen.getByTestId("builder-check"))
    fireEvent.click(screen.getByTestId("builder-check"))
    await waitFor(() => expect(screen.getAllByTestId("builder-error")).toHaveLength(2))
    expect(api.post).toHaveBeenCalledWith(
      `/apps/builder/drafts/${ID}/check`,
      { n: 2 },
      expect.anything(),
    )
    const at = screen.getAllByTestId("builder-error-at").map((e) => e.textContent)
    expect(at).toEqual(["handlers.ts:7", "ui.tsx:3"])
  })

  it("shows the stored build's errors when it failed", async () => {
    mount({
      draft: draftBody({ build: { ok: false, errors: [{ message: "bad manifest" }], at: "" } }),
    })
    await waitFor(() =>
      expect(screen.getByTestId("builder-build-errors").textContent).toContain("bad manifest"),
    )
  })

  it("runs a preview from the inline form and shows its result and logs", async () => {
    const api = mount({
      post: async () => ({
        draftId: ID,
        n: 2,
        entry: { kind: "tool", name: "items_list" },
        ok: true,
        result: { items: [{ title: "One" }] },
        logs: [{ level: "info", message: "listed 1", fields: {}, at: "" }],
        logsDropped: 0,
        runId: "r",
        durationMs: 12,
        storeNamespace: `draft:${ID}`,
        neverPublished: true,
      }),
    })
    await waitFor(() => screen.getByTestId("builder-preview"))
    fireEvent.click(screen.getByTestId("builder-preview"))
    const params = screen.getByTestId("builder-preview-params") as HTMLTextAreaElement
    fireEvent.input(params, { target: { value: "[1]" } })
    fireEvent.click(screen.getByTestId("builder-preview-run"))
    expect(screen.getByTestId("builder-params-invalid")).toBeTruthy()
    expect(api.post).not.toHaveBeenCalled()

    fireEvent.input(params, { target: { value: '{"limit":5}' } })
    fireEvent.click(screen.getByTestId("builder-preview-run"))
    await waitFor(() => screen.getByTestId("builder-preview-result"))
    expect(api.post).toHaveBeenCalledWith(
      `/apps/builder/drafts/${ID}/preview`,
      { entry: { kind: "tool", name: "items_list" }, n: 2, params: { limit: 5 } },
      expect.anything(),
    )
    expect(screen.getByTestId("builder-preview-outcome").dataset.ok).toBe("true")
    expect(screen.getByTestId("builder-preview-value").textContent).toContain('"One"')
    expect(screen.getByTestId("builder-preview-log").dataset.level).toBe("info")
  })

  it("explains approval to a builder without kernel:apps:admin, publishes nothing", async () => {
    const api = mount({})
    await waitFor(() => screen.getByTestId("builder-publish"))
    fireEvent.click(screen.getByTestId("builder-publish"))
    expect(screen.getByTestId("builder-publish-note").textContent).toContain("agent")
    expect(screen.queryByTestId("builder-confirm-publish")).toBeNull()
    expect(api.post).not.toHaveBeenCalled()
  })

  it("lets an apps admin publish after a confirm", async () => {
    state.scopes = ["kernel:apps:build", "kernel:apps:admin"]
    const api = mount({
      post: async () => ({
        appName: "tracker-oabcdef12",
        appVersion: "0.1.0",
        sha256: "abc",
        draftId: ID,
        n: 2,
        firstPublish: true,
      }),
    })
    await waitFor(() => screen.getByTestId("builder-publish"))
    fireEvent.click(screen.getByTestId("builder-publish"))
    expect(api.post).not.toHaveBeenCalled()
    fireEvent.click(screen.getByTestId("builder-confirm-publish-yes"))
    await waitFor(() =>
      expect(screen.getByTestId("builder-publish-note").textContent).toContain("0.1.0"),
    )
    expect(api.post).toHaveBeenCalledWith(
      `/apps/builder/drafts/${ID}/publish`,
      { n: 2 },
      expect.anything(),
    )
  })

  it("shows a refused publish calmly", async () => {
    state.scopes = ["*"]
    mount({
      post: async () => {
        throw new Error("the org already has its maximum of custom apps")
      },
    })
    await waitFor(() => screen.getByTestId("builder-publish"))
    fireEvent.click(screen.getByTestId("builder-publish"))
    fireEvent.click(screen.getByTestId("builder-confirm-publish-yes"))
    await waitFor(() =>
      expect(screen.getByTestId("builder-action-error").textContent).toContain("maximum"),
    )
  })

  it("restores a version and discards after a confirm", async () => {
    const api = mount({})
    await waitFor(() => screen.getByTestId("builder-restore-1"))
    fireEvent.click(screen.getByTestId("builder-restore-1"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/apps/builder/drafts/${ID}/restore`,
        { n: 1 },
        expect.anything(),
      ),
    )
    await waitFor(() =>
      expect((screen.getByTestId("builder-discard") as HTMLButtonElement).disabled).toBe(false),
    )
    fireEvent.click(screen.getByTestId("builder-discard"))
    fireEvent.click(screen.getByTestId("builder-confirm-discard-yes"))
    await waitFor(() =>
      expect(api.post).toHaveBeenCalledWith(
        `/apps/builder/drafts/${ID}/discard`,
        {},
        expect.anything(),
      ),
    )
  })

  it("embeds the interface only in the sandboxed frame of the draft's frame route", async () => {
    mount({ draft: draftBody({ build: { ok: true, uiSha256: "u", at: "" }, preview: true }) })
    const frame = (await screen.findByTestId("isolated-app-frame")) as HTMLIFrameElement
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts allow-forms")
    expect(frame.getAttribute("sandbox")).not.toContain("allow-same-origin")
    expect(frame.getAttribute("src")).toContain(`/api/apps/builder/drafts/${ID}/2/frame?t=tok`)
  })

  it("says so when the draft is gone", async () => {
    const api = {
      get: vi.fn(async () => {
        const { ApiError } = await import("~/lib/api-error")
        throw new ApiError("Not found", 404)
      }),
      post: vi.fn(),
      rawGet: vi.fn(),
    }
    render(() => (
      <ApiContext.Provider value={api as unknown as ApiClient}>
        <BuilderView entityId={ID} />
      </ApiContext.Provider>
    ))
    await waitFor(() => screen.getByTestId("builder-not-found"))
    expect(screen.queryByTestId("builder-check")).toBeNull()
  })

  it("derives a build state", () => {
    expect(buildState(null)).toBe("none")
    expect(buildState({ ok: true, at: "" })).toBe("ok")
    expect(buildState({ ok: true, typecheck: { ok: false, errors: [] }, at: "" })).toBe("failed")
    expect(buildState({ ok: false, at: "" })).toBe("failed")
  })
})
