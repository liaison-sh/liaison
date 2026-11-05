// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A managed workspace suspended or closed for billing while a tab is open in it.
//
// The server refuses the org's user credentials with a 403 whose `error` is
// `{ code: "org_suspended", accessUntil, contact }` (REST, token refresh, the
// websocket ticket) and closes a live socket with ORG_SUSPENDED_WS_CLOSE. The
// API client, both token refreshes and the socket report it here, and this is
// the one place that reacts: the first report puts the page on the suspended
// view (modules/shell/OrgSuspendedPage.tsx, the router root in App.tsx), once, and
// later reports neither toast nor send the person to the login page.
//
// `accessUntil` (admins may still export and pay until then; null once closed)
// and `contact` (the billing contact) come from the control plane through the
// body; this app holds no contact address of its own.
import { ORG_SUSPENDED_CODE, orgSuspendedErrorSchema } from "@liaison/shared"
import { createSignal } from "solid-js"

export interface OrgSuspension {
  accessUntil: string | null
  contact: string | null
}

const [suspension, setSuspension] = createSignal<OrgSuspension | null>(null)

/** Is this refusal the suspension of the org? */
export function isOrgSuspendedRefusal(status: number, code: string | undefined): boolean {
  return status === 403 && code === ORG_SUSPENDED_CODE
}

/** The suspension this page has learnt of, or null while the org is served. */
export const orgSuspension = suspension

/** True once this page has learnt its org is suspended or closed. */
export function orgSuspended(): boolean {
  return suspension() !== null
}

/** Read the fields of a refusal's `error` object; unknown shapes give nulls. */
export function suspensionFromError(error: unknown): OrgSuspension {
  const parsed = orgSuspendedErrorSchema.safeParse(error)
  if (parsed.success) {
    return { accessUntil: parsed.data.accessUntil, contact: parsed.data.contact }
  }
  const e = (error && typeof error === "object" ? error : {}) as Record<string, unknown>
  return {
    accessUntil: typeof e.accessUntil === "string" ? e.accessUntil : null,
    contact: typeof e.contact === "string" ? e.contact : null,
  }
}

/** The org is suspended: show the suspended page, once, however many answers say so. */
export function noteOrgSuspended(details: OrgSuspension): void {
  if (suspension() !== null) return
  setSuspension(details)
}

/**
 * A refused fetch made outside the API client (a token refresh, the websocket
 * ticket): note the suspension when that is what it says.
 */
export async function noteIfOrgSuspended(res: Response): Promise<boolean> {
  if (res.status !== 403) return false
  let error: unknown
  try {
    const json = (await res.clone().json()) as { error?: unknown }
    error = json?.error
  } catch {
    return false
  }
  const code = (error as { code?: unknown } | undefined)?.code
  if (!isOrgSuspendedRefusal(res.status, typeof code === "string" ? code : undefined)) {
    return false
  }
  noteOrgSuspended(suspensionFromError(error))
  return true
}

/** Tests only: back to a page that has seen nothing. */
export function _resetOrgSuspended(): void {
  setSuspension(null)
}
