// SPDX-License-Identifier: FSL-1.1-ALv2
//
// What the viewer may do in Invoicing, read once per page from the app's own
// `viewer_access` tool. The UI offers a write (a new document, the approval
// queue, the readiness fixes) only to a user who holds the scope the write
// tools require, instead of offering it and failing later.
import { app } from "@liaison/host"

export interface ViewerAccess {
  documents_write: boolean
  settings_read: boolean
  /** Holds the approver scope: may decide the approvals the gated tools raise. */
  approve: boolean
}

/** The answer when the tool cannot be read: nothing is offered (the safe side). */
export const NO_ACCESS: ViewerAccess = { documents_write: false, settings_read: false, approve: false }

/** Normalise a `viewer_access` result (or an error envelope) to flags. */
export function toViewerAccess(raw: unknown): ViewerAccess {
  if (!raw || typeof raw !== "object" || (raw as { status?: unknown }).status === "error") return NO_ACCESS
  const r = raw as Partial<Record<keyof ViewerAccess, unknown>>
  return {
    documents_write: r.documents_write === true,
    settings_read: r.settings_read === true,
    approve: r.approve === true,
  }
}

let pending: Promise<ViewerAccess> | null = null

/** The viewer's access, fetched once and shared by every Invoicing surface on the page. */
export function loadViewerAccess(): Promise<ViewerAccess> {
  if (!pending) {
    pending = app
      .invokeTool<unknown>("viewer_access", {})
      .then(toViewerAccess)
      .catch(() => {
        pending = null
        return NO_ACCESS
      })
  }
  return pending
}
