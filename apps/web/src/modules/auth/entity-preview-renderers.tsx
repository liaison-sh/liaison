// SPDX-License-Identifier: FSL-1.1-ALv2
import { useI18n } from "~/modules/i18n/i18n-context"
import { registerEntityPreview } from "~/modules/shell/entity-preview/registry"

interface UserPreviewData {
  id: string
  name: string | null
  email: string | null
  avatarUrl: string | null
  status: "active" | "suspended" | "deactivated"
}

/**
 * Renders a compact user preview card. `useI18n()` is called inside the
 * render function (inside the reactive SolidJS tree) so translations are
 * read reactively — the locale is not captured once at bootstrap time.
 */
function UserPreview(props: { user: UserPreviewData }) {
  const i18n = useI18n()
  return (
    <div data-testid={`user-preview-${props.user.id}`}>
      <div class="font-medium text-text">
        {props.user.name ?? props.user.email ?? i18n.t("kernel.auth.unknownUser")}
      </div>
      {props.user.email && props.user.name ? (
        <div class="text-text-secondary text-[12px]">{props.user.email}</div>
      ) : null}
      {props.user.status === "deactivated" ? (
        <div class="mt-1 text-text-tertiary text-[11px]">{i18n.t("kernel.deactivated")}</div>
      ) : null}
    </div>
  )
}

export function registerEntityPreviews(): void {
  registerEntityPreview<UserPreviewData>({
    app: "kernel",
    entityType: "user",
    fetch: async (id, api) => {
      const res = await api.getEnvelope<UserPreviewData>(`/users/${id}/preview`)
      return res.data
    },
    render: (user) => <UserPreview user={user} />,
  })
}
