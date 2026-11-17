// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A staff signer's "Read and sign" (Home, kind client_action): the tab asks the
// server for this browser's own link (`POST /client-actions/:id/my-link`, REST
// only, the member's session), then shows the same reading and signing steps an
// outside signer gets, with the member's session on verify and decide, which a
// staff signer's signature requires. The link never leaves this tab.

import { type Component, createResource, Match, Switch } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { accessToken } from "~/modules/auth/auth-store"
import ClientActionPage from "~/modules/client-action/ClientActionPage"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"

type Link = { token: string } | { refused: "not_your_turn" | "session_restricted" | "gone" }

const StaffSignTab: Component<{ entityId: string }> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [link] = createResource(
    () => props.entityId,
    async (id): Promise<Link> => {
      try {
        const out = await api.post<{ token: string }>(
          `/client-actions/${encodeURIComponent(id)}/my-link`,
          {},
        )
        return out?.token ? { token: out.token } : { refused: "gone" }
      } catch (err) {
        const code = err instanceof ApiError ? err.code : undefined
        if (code === "not_your_turn" || code === "session_restricted") return { refused: code }
        return { refused: "gone" }
      }
    },
  )
  const refused = () => {
    const l = link()
    return l && "refused" in l ? l.refused : null
  }
  const token = () => {
    const l = link()
    return l && "token" in l ? l.token : null
  }
  return (
    <div data-testid="staff-sign-tab" class="h-full min-h-0 overflow-y-auto bg-bg">
      <Switch>
        <Match when={token()}>
          {(t) => <ClientActionPage token={t()} memberBearer={accessToken} />}
        </Match>
        <Match when={refused()}>
          {(r) => (
            <p data-testid="staff-sign-refused" class="px-6 py-10 text-[14px] text-text">
              {i18n.t(`kernel.staffSign.${r()}`)}
            </p>
          )}
        </Match>
      </Switch>
    </div>
  )
}

export default StaffSignTab
