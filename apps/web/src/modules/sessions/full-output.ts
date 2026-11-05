// SPDX-License-Identifier: FSL-1.1-ALv2
//
// SHOW FULL OUTPUT, the web side (P3-T22; S7, D3, G12). A tool output the
// session event cut at 64 KiB is kept whole on the node (the sidecar's spill
// file). The owner asks for it; the server asks the node, which uploads it:
//
//   POST /api/me/node-sessions/:id/full-output {toolUseId}   asks (404: node offline)
//   GET  /api/me/node-sessions/:id/full-output/:toolUseId     200 text, 202 pending,
//                                                             404 offline or gone
//
// The read polls every 2 s for 60 s at most. P2's tool row calls it through
// the session action registry (`fullOutput`): a string is the output, null
// means it is not reachable now (the row says the output is on the computer).

import { TOOL_USE_ID_RE } from "@liaison/shared"
import type { ApiClient } from "~/lib/api-client"
import { ApiError } from "~/lib/api-error"
import { getAttentionApi } from "~/modules/shell/attention-store"

type Api = Pick<ApiClient, "rawPost" | "rawGet">
let apiOf: () => Api | null = getAttentionApi

/** Where the reads go (the kernel API client by default; tests set their own). */
export function setFullOutputApi(getter: () => Api | null): void {
  apiOf = getter
}

export const FULL_OUTPUT_ROUTES = {
  ask: (id: string) => `/me/node-sessions/${encodeURIComponent(id)}/full-output`,
  read: (id: string, toolUseId: string) =>
    `/me/node-sessions/${encodeURIComponent(id)}/full-output/${encodeURIComponent(toolUseId)}`,
} as const

export interface FullOutputTiming {
  pollMs?: number
  maxMs?: number
  sleep?: (ms: number) => Promise<void>
}

const quiet = { suppressGlobalError: true } as const

async function refused(res: Response): Promise<ApiError> {
  let message = `HTTP ${res.status}`
  try {
    const body = (await res.json()) as { error?: { message?: string } | string }
    const m = typeof body.error === "string" ? body.error : body.error?.message
    if (m) message = m
  } catch {
    // not JSON
  }
  return new ApiError(message, res.status)
}

/** The whole output of a cut tool result, or null when the node cannot give it now. */
export async function fullOutput(
  sessionId: string,
  toolUseId: string,
  timing: FullOutputTiming = {},
): Promise<string | null> {
  if (!TOOL_USE_ID_RE.test(toolUseId)) return null
  const api = apiOf()
  if (!api) throw new ApiError("Not signed in.", 401, "UNAUTHORIZED")
  const pollMs = timing.pollMs ?? 2_000
  const maxMs = timing.maxMs ?? 60_000
  const sleep = timing.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const asked = await api.rawPost(FULL_OUTPUT_ROUTES.ask(sessionId), { toolUseId }, quiet)
  if (asked.status === 404) return null
  if (!asked.ok) throw await refused(asked)
  for (let waited = 0; ; waited += pollMs) {
    const res = await api.rawGet(FULL_OUTPUT_ROUTES.read(sessionId, toolUseId), quiet)
    if (res.status === 200) return await res.text()
    if (res.status === 404) return null
    if (res.status !== 202) throw await refused(res)
    if (waited + pollMs >= maxMs) return null
    await sleep(pollMs)
  }
}
