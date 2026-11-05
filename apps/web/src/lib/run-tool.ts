// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApiClient } from "~/lib/api-client"

export interface RunToolOptions {
  threadId?: string
  signal?: AbortSignal
  /**
   * Skip the global error toast for this call. For background calls the
   * person did not ask for (a mark-read on focus): their failure is logged
   * by the caller, never toasted.
   */
  suppressGlobalError?: boolean
}

/**
 * Invoke a manifest-registered app tool through the standard
 * `POST /api/apps/run-tool` endpoint. Returns the unwrapped tool data
 * (or `{ blocked }` for approval-gated tools).
 */
export async function runTool<T = unknown>(
  api: ApiClient,
  toolName: string,
  params: Record<string, unknown> = {},
  options: RunToolOptions = {},
): Promise<T> {
  const body: Record<string, unknown> = { toolName, params }
  if (options.threadId) body.threadId = options.threadId
  if (!options.signal && !options.suppressGlobalError) return api.post<T>("/apps/run-tool", body)
  return api.post<T>("/apps/run-tool", body, {
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.suppressGlobalError ? { suppressGlobalError: true } : {}),
  })
}
