// SPDX-License-Identifier: FSL-1.1-ALv2
// Test-only API double: every call is recorded, and each answer comes from a
// handler keyed by method and path (tools by tool name through run-tool).
import { vi } from "vitest"
import { ApiError } from "~/lib/api-error"

type Handler = (body: unknown) => unknown

export interface FakeApi {
  get: ReturnType<typeof vi.fn>
  post: ReturnType<typeof vi.fn>
  put: ReturnType<typeof vi.fn>
  patch: ReturnType<typeof vi.fn>
  delete: ReturnType<typeof vi.fn>
  /** `GET /path` etc. */
  on: (method: "get" | "post" | "put" | "patch" | "delete", path: string, h: Handler) => void
  /** A tool through `POST /apps/run-tool` (full name `app:tool`). */
  tool: (toolName: string, h: Handler) => void
  /** Tool calls made, in order. */
  toolCalls: () => Array<{ toolName: string; params: unknown }>
}

/** Throw this from a handler to answer an HTTP error. */
export function apiError(status: number, code: string, message = code): ApiError {
  return new ApiError(message, status, code)
}

export function createFakeApi(): FakeApi {
  const handlers = new Map<string, Handler>()
  const tools = new Map<string, Handler>()
  const calls: Array<{ toolName: string; params: unknown }> = []
  const answer = async (method: string, path: string, body?: unknown) => {
    if (method === "post" && path === "/apps/run-tool") {
      const b = body as { toolName: string; params: unknown }
      calls.push({ toolName: b.toolName, params: b.params })
      const h = tools.get(b.toolName)
      if (!h) throw apiError(404, "tool_not_found", `no handler for ${b.toolName}`)
      return h(b.params)
    }
    const h = handlers.get(`${method} ${path}`)
    if (!h) throw apiError(404, "not_found", `no handler for ${method} ${path}`)
    return h(body)
  }
  const api: FakeApi = {
    get: vi.fn((path: string) => answer("get", path)),
    post: vi.fn((path: string, body?: unknown) => answer("post", path, body)),
    put: vi.fn((path: string, body?: unknown) => answer("put", path, body)),
    patch: vi.fn((path: string, body?: unknown) => answer("patch", path, body)),
    delete: vi.fn((path: string, body?: unknown) => answer("delete", path, body)),
    on: (method, path, h) => handlers.set(`${method} ${path}`, h),
    tool: (toolName, h) => tools.set(toolName, h),
    toolCalls: () => calls,
  }
  return api
}
