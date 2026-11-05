// SPDX-License-Identifier: FSL-1.1-ALv2
import { type Component, Show } from "solid-js"
import { hasScope } from "~/modules/auth/auth-store"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { ACCESS_GRANT_SCOPE } from "~/modules/shell/home-action-count"
import { ScopeRequestItem } from "./AdminScopeRequests"
import { scopeRequestsStore } from "./scope-requests-store"

/**
 * The access request an agent just filed, decided where it was asked. A person who may grant
 * access answers it in the conversation, the way they answer an approval card there, instead of
 * leaving for Home. Shown only while it waits: the decision line the conversation receives says
 * the rest. Nobody else sees it (the agent's own words already say it waits on an admin).
 */
const ScopeRequestToolCard: Component<{ requestId: string }> = (props) => {
  const api = useOptionalApi()
  const canGrant = () => hasScope(ACCESS_GRANT_SCOPE)
  if (api && canGrant()) {
    void scopeRequestsStore.ensureLoaded(api, props.requestId).catch(() => undefined)
  }
  const row = () => scopeRequestsStore.getById(props.requestId)
  return (
    <Show when={canGrant() && row()?.status === "pending" ? row() : undefined}>
      {(r) => (
        <ul class="mt-1" data-testid="scope-request-tool-card">
          <ScopeRequestItem row={r()} />
        </ul>
      )}
    </Show>
  )
}

export default ScopeRequestToolCard
