// SPDX-License-Identifier: FSL-1.1-ALv2
import { rootLogger } from "~/lib/logger"

const log = rootLogger.child({ module: "navigation-tool" })

/**
 * `open_app` — let the agent drive the user's UI, e.g. to show where an app
 * lives. The EFFECT is client-side: the web app already receives every
 * agent `tool_call` (with args) over the `agent_stream` WebSocket channel and,
 * when it sees `toolName === "open_app"`, resolves `args.app` to that app's
 * registered tab action and opens it. The backend handler therefore holds no
 * server state — it only returns a short acknowledgement for the model's benefit
 * (and so the tool call has a result). An app id the UI doesn't recognise is a
 * harmless client-side no-op.
 */
export async function handleOpenApp(
  params: { app: string; view?: string },
  _ctx: { userId: string; orgId: string },
): Promise<{ ok: true; app: string; view?: string }> {
  const app = String(params.app ?? "").trim()
  const view = params.view ? String(params.view).trim() : undefined
  log.info({ app, view }, "open_app requested")
  return view ? { ok: true, app, view } : { ok: true, app }
}
