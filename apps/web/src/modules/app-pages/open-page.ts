// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * Opening an app page from a handle (`ctx.pages.link` in the app's code): only
 * the person's own signed-in app turns the handle into a one-time link
 * (`POST /api/apps/:app/pages/open`), then the page opens on its own: a popup
 * on the web, the system browser in a desktop or phone shell.
 */
import { openExternal } from "~/modules/desktop/external-links"
import { shellRunsOAuth } from "~/modules/settings/oauth-connect"

export interface PageHandle {
  handle: string
  app: string
  page: string
}

const HANDLE_RE = /^lpg_[A-Za-z0-9_-]{32,64}$/
const NAME_RE = /^[a-z][a-z0-9-]{0,63}$/

function asHandle(value: unknown): PageHandle | null {
  if (!value || typeof value !== "object") return null
  const v = value as Record<string, unknown>
  if (typeof v.handle !== "string" || !HANDLE_RE.test(v.handle)) return null
  if (typeof v.app !== "string" || !NAME_RE.test(v.app)) return null
  if (typeof v.page !== "string" || !NAME_RE.test(v.page)) return null
  return { handle: v.handle, app: v.app, page: v.page }
}

/** The page handle a tool answered: the result itself, or its `page` field. */
export function pageHandleOf(toolCall: { status: string; result?: unknown }): PageHandle | null {
  if (toolCall.status === "error") return null
  const result = toolCall.result
  return asHandle(result) ?? asHandle((result as { page?: unknown } | null)?.page)
}

export type OpenPageOutcome = "opened" | "blocked" | "failed"

/**
 * Opens the page. Call it in the click itself: the popup is opened before any
 * await, or the browser blocks it.
 */
export async function openAppPage(
  api: { post<T>(path: string, body: unknown): Promise<T> },
  handle: PageHandle,
): Promise<OpenPageOutcome> {
  const shell = shellRunsOAuth()
  const popup = shell
    ? null
    : window.open("about:blank", `liaison-page-${handle.app}`, "popup,width=1050,height=720")
  if (popup) popup.opener = null
  if (!shell && !popup) return "blocked"
  try {
    const { url } = await api.post<{ url: string }>(
      `/apps/${encodeURIComponent(handle.app)}/pages/open`,
      { handle: handle.handle },
    )
    if (popup) {
      popup.location.href = url
      return "opened"
    }
    return (await openExternal(url)) ? "opened" : "failed"
  } catch {
    popup?.close()
    return "failed"
  }
}
