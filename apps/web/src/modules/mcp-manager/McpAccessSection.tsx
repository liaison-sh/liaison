// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Who can use an organization MCP server: every member (the default) or only
// the roles and people an admin picks. The same picker as an app's access
// (settings/app-management/AccessPicker). Two forms:
//   - McpAccessSection: the server page's section, with its own Save.
//   - McpAccessRow: the tools review's compact row; the dialog saves it on Done.
// Both link to Roles & access filtered to this server's permissions, for the
// per-tool grants the two-way choice does not cover.
import { type Component, createResource, createSignal, Show } from "solid-js"
import { ApiError } from "~/lib/api-error"
import { useI18n } from "~/modules/i18n/i18n-context"
import { getConnectionAccess, setConnectionAccess } from "~/modules/mcp-manager/api"
import type { McpConnectionAccess } from "~/modules/mcp-manager/types"
import { AccessPicker } from "~/modules/settings/app-management/AccessPicker"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"

/** Deciding who uses an org server is the MCP manager admin's (org admins hold `*`). */
export const MCP_ACCESS_ADMIN_SCOPE = "mcp_manager:connection:admin"

/** Roles & access, showing only the roles that hold a permission for this server. */
export function rolesPageHrefFor(slug: string): string {
  return `/settings/admin/roles?scope=${encodeURIComponent(`mcp:${slug}`)}`
}

export const EVERYONE: McpConnectionAccess = { mode: "everyone", roleIds: [], userIds: [] }

const FineTuneLink: Component<{ slug: string; testId: string }> = (props) => {
  const i18n = useI18n()
  return (
    <a
      href={rolesPageHrefFor(props.slug)}
      class="text-xs text-accent underline-offset-2 hover:underline"
      data-testid={props.testId}
    >
      {i18n.t("kernel.mcpUi.accessFineTune")}
    </a>
  )
}

export const McpAccessSection: Component<{
  connectionId: string
  slug: string
  serverName: string
}> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [stored, { mutate }] = createResource(
    () => props.connectionId,
    (id) => getConnectionAccess(api, id),
  )
  const [draft, setDraft] = createSignal<McpConnectionAccess | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const value = () => draft() ?? stored.latest ?? EVERYONE

  async function save(): Promise<void> {
    setBusy(true)
    setError(null)
    try {
      const saved = await setConnectionAccess(api, props.connectionId, value())
      mutate(saved)
      setDraft(null)
      addToast({
        message: i18n.t("kernel.mcpUi.accessSaved", { name: props.serverName }),
        type: "success",
      })
    } catch (e) {
      setError(
        e instanceof ApiError && e.message
          ? e.message
          : i18n.t("kernel.mcpUi.accessFailed", { name: props.serverName }),
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="mcp-access-section">
      <Show when={stored.latest || stored.error}>
        <AccessPicker value={value()} onChange={setDraft} idPrefix="mcp-access" />
      </Show>
      <Show when={error()}>
        <p class="mt-3 text-sm text-error" role="alert" data-testid="mcp-access-error">
          {error()}
        </p>
      </Show>
      <div class="mt-4 flex flex-wrap items-center justify-between gap-3">
        <FineTuneLink slug={props.slug} testId="mcp-access-fine-tune" />
        <Button
          data-testid="mcp-access-save"
          disabled={busy() || draft() === null}
          loading={busy()}
          onClick={() => void save()}
        >
          {i18n.t("kernel.mcpUi.accessSave")}
        </Button>
      </div>
    </div>
  )
}

/** The tools review's one-line form: Everyone preselected, saved by the dialog. */
export const McpAccessRow: Component<{
  slug: string
  value: McpConnectionAccess
  onChange: (next: McpConnectionAccess) => void
}> = (props) => {
  const i18n = useI18n()
  return (
    <div class="flex flex-col gap-2" data-testid="mcp-review-access">
      <div class="flex flex-wrap items-baseline justify-between gap-2">
        <span class="text-sm font-medium text-text">{i18n.t("kernel.mcpUi.accessTitle")}</span>
        <FineTuneLink slug={props.slug} testId="mcp-review-access-fine-tune" />
      </div>
      <AccessPicker
        value={props.value}
        onChange={props.onChange}
        idPrefix="mcp-review-access"
        compact
      />
    </div>
  )
}
