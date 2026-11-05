// SPDX-License-Identifier: FSL-1.1-ALv2
// The accounts behind one app connection, as the viewer may see them: the
// org's own and the viewer's personal ones, with owner, health and whether the
// access renews by itself (the kernel's `describeConnectionAccounts` rule,
// connections/service.ts, the one bundled apps read through the bridge).
//
// Read through `GET /api/connections/:app/:connection/accounts`; the generic
// `GET /api/connections/:app` leaves org-owned app accounts out.
import type { ApiClient } from "~/lib/api-client"

export interface ConnectionAccount {
  id: string
  identifier: string
  displayName: string | null
  /** The name the account is shown by (S7), or null: shown by its connection's name. */
  label: string | null
  ownerType: "org" | "user"
  isMine: boolean
  status: "active" | "error"
  statusMessage: string | null
  tokenExpiresAt: string | null
  hasRefreshToken: boolean
  connectedByName: string | null
}

/** The accounts of one connection. */
export async function loadConnectionAccounts(
  api: ApiClient,
  app: string,
  connection: string,
): Promise<ConnectionAccount[]> {
  const rows = await api.get<ConnectionAccount[]>(`/connections/${app}/${connection}/accounts`, {
    suppressGlobalError: true,
  })
  return Array.isArray(rows) ? rows : []
}

/**
 * The name an account is shown by: the kernel's label (S7, never a bare
 * numeric id or a UUID), else `fallback`, the connection's own name ("Google
 * account (YouTube)", "Facebook Page").
 */
export function accountLabel(a: Pick<ConnectionAccount, "label">, fallback: string): string {
  return a.label ?? fallback
}
