// SPDX-License-Identifier: FSL-1.1-ALv2
// The workspace's roles (`GET /admin/roles`), read once per session for the
// access summaries ("Support + 2 people") and the Who can use it dialog.
import { type Accessor, createSignal } from "solid-js"
import { onSessionTeardown } from "~/lib/session-lifecycle"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useApi } from "~/modules/shell/ApiContext"

/** `GET /admin/roles` answers holders of this scope only; anyone else gets a 403. */
export const ROLES_READ_SCOPE = "kernel:users:admin"

export interface WorkspaceRole {
  id: string
  name: string
}

const [roles, setRoles] = createSignal<WorkspaceRole[] | undefined>(undefined)
let loading: Promise<void> | null = null

/** Forget the roles read so far (session teardown; tests). */
export function resetWorkspaceRoles(): void {
  setRoles(undefined)
  loading = null
}

onSessionTeardown(resetWorkspaceRoles)

/**
 * Reactive roles; the first caller loads them. A failed read leaves them
 * unknown. A viewer who may not list roles never asks: they stay unknown.
 */
export function useWorkspaceRoles(): Accessor<WorkspaceRole[] | undefined> {
  const api = useApi()
  if (!roles() && !loading && canAccessScope(ROLES_READ_SCOPE)) {
    loading = api
      .get<WorkspaceRole[] | { data?: WorkspaceRole[] }>("/admin/roles", {
        suppressGlobalError: true,
      })
      .then((res) => {
        setRoles(Array.isArray(res) ? res : (res?.data ?? []))
      })
      .catch(() => {
        loading = null
      })
  }
  return roles
}
