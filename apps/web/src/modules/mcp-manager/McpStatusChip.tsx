// SPDX-License-Identifier: FSL-1.1-ALv2
//
// One status vocabulary for an MCP connection, wherever it is listed (the
// org's servers on Connectors, a member's own on Connected tools, the server's
// page). Calm UI: a small chip, colour only for "needs you".
import { type Component, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { McpConnectionListItem } from "~/modules/mcp-manager/types"

/** What a person should know about a connection, most actionable first. */
export type McpRowState =
  | "disabled"
  | "secrets_unreadable"
  | "needs_reauth"
  | "oauth_pending"
  | "failed"
  | "connected"
  | "connecting"
  | "idle"

type Row = Pick<McpConnectionListItem, "status" | "disabled" | "secretsUnreadable">

export function mcpRowState(c: Row): McpRowState {
  if (c.disabled) return "disabled"
  // The credentials cannot be read: signing in would be refused too, so this
  // wins over "not signed in" (the list reports such a row as oauth_pending).
  if (c.secretsUnreadable) return "secrets_unreadable"
  switch (c.status) {
    case "needs_reauth":
    case "oauth_pending":
    case "failed":
    case "connected":
    case "connecting":
      return c.status
    default:
      return "idle"
  }
}

/** A sign-in is what fixes it (and is possible: the secrets can be read). */
export function canSignIn(state: McpRowState): boolean {
  return state === "needs_reauth" || state === "oauth_pending"
}

const LABEL: Record<McpRowState, string> = {
  disabled: "kernel.mcpUi.chipDisabled",
  secrets_unreadable: "kernel.mcpUi.chipSecretsUnreadable",
  needs_reauth: "kernel.mcpUi.chipSignInAgain",
  oauth_pending: "kernel.mcpUi.chipNotSignedIn",
  failed: "kernel.mcpUi.chipFailed",
  connected: "kernel.mcpUi.chipConnected",
  connecting: "kernel.mcpUi.chipConnecting",
  idle: "kernel.mcpUi.chipNotChecked",
}

function tone(state: McpRowState): "ok" | "warn" | "mute" {
  if (state === "connected") return "ok"
  if (
    state === "needs_reauth" ||
    state === "oauth_pending" ||
    state === "secrets_unreadable" ||
    state === "failed"
  ) {
    return "warn"
  }
  return "mute"
}

export const McpStatusChip: Component<{ conn: Row }> = (props) => {
  const i18n = useI18n()
  const state = () => mcpRowState(props.conn)
  return (
    <Show when={state()}>
      {(s) => (
        <span
          data-testid={`mcp-chip-${s()}`}
          class="inline-flex flex-none items-center rounded-full border px-2 py-px text-[11px] font-medium"
          classList={{
            "border-success-border bg-success-glow text-success": tone(s()) === "ok",
            "border-warning-border bg-warning-glow text-warning": tone(s()) === "warn",
            "border-border text-text-tertiary": tone(s()) === "mute",
          }}
        >
          {i18n.t(LABEL[s()])}
        </span>
      )}
    </Show>
  )
}
