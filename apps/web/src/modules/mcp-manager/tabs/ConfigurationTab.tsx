// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A server's settings: name, address, rate cap, and for a token or no-auth
// server its credentials (a new token, custom headers). Credentials are
// write-only: the token is never shown, headers show their names only.
import { type Component, createResource, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { getConnection, patchConnection } from "~/modules/mcp-manager/api"
import { CustomHeadersEditor, type HeaderPatch } from "~/modules/mcp-manager/CustomHeadersEditor"
import type { McpConnection, McpConnectionPatchBody } from "~/modules/mcp-manager/types"
import { billingMode } from "~/modules/settings/BillingState"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

interface Props {
  connectionId: string
}

export const ConfigurationTab: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [conn, { refetch }] = createResource(() => getConnection(api, props.connectionId))

  const envChip = (c: McpConnection) => c.managedBy === "env"
  const isManaged = () => billingMode() === "managed"

  return (
    <Show when={conn()} keyed>
      {(c) => (
        <div class="space-y-4">
          <Show when={envChip(c)}>
            <div
              data-testid="mcp-managed-by-env-chip"
              class="inline-flex items-center rounded bg-amber-100 px-2 py-0.5 text-xs text-amber-800"
            >
              {i18n.t("kernel.mcpUi.fromEnv")}
            </div>
          </Show>

          <div>
            <label for="mcp-config-display-name" class="block text-sm font-medium text-text">
              {i18n.t("kernel.mcpUi.displayName")}
            </label>
            <input
              id="mcp-config-display-name"
              data-testid="mcp-config-display-name"
              class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-sm"
              value={c.displayName}
              disabled={envChip(c)}
              onChange={async (e) => {
                await patchConnection(api, c.id, { displayName: e.currentTarget.value })
                await refetch()
              }}
            />
          </div>

          <div>
            <label for="mcp-config-transport" class="block text-sm font-medium text-text">
              {i18n.t("kernel.mcpUi.transport")}
            </label>
            <input
              id="mcp-config-transport"
              data-testid="mcp-config-transport"
              class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-sm"
              value={c.transport}
              disabled
            />
          </div>

          <Show when={c.transport === "http" || c.transport === "sse"}>
            <div>
              <label for="mcp-config-http-url" class="block text-sm font-medium text-text">
                {i18n.t("kernel.mcpUi.url")}
              </label>
              <input
                id="mcp-config-http-url"
                data-testid="mcp-config-http-url"
                class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-sm"
                value={c.httpUrl ?? ""}
                disabled={envChip(c)}
                onChange={async (e) => {
                  if (envChip(c)) return
                  await patchConnection(api, c.id, { httpUrl: e.currentTarget.value })
                  await refetch()
                }}
              />
              <p class="mt-1 text-xs text-text-secondary" data-testid="mcp-config-http-url-hint">
                {i18n.t("kernel.mcpUi.urlChangeClearsSignIn")}
              </p>
            </div>
          </Show>

          <div>
            <label for="mcp-config-ratecap" class="block text-sm font-medium text-text">
              {i18n.t("kernel.mcpUi.rateCap")}
              <Show when={!isManaged()}>
                <span
                  data-testid="mcp-config-ratecap-managed-only"
                  class="ml-2 inline-flex items-center rounded bg-slate-100 px-2 py-0.5 text-[10px] text-slate-700"
                >
                  {i18n.t("kernel.mcpUi.managedOnly")}
                </span>
              </Show>
            </label>
            <input
              id="mcp-config-ratecap"
              data-testid="mcp-config-ratecap"
              type="number"
              class="mt-1 w-full rounded border border-border bg-bg px-2 py-1 text-sm"
              value={c.rateCapPerMinute ?? ""}
              disabled={!isManaged() || envChip(c)}
              placeholder={i18n.t("kernel.mcpUi.unlimited")}
              onChange={async (e) => {
                if (!isManaged() || envChip(c)) return
                const raw = e.currentTarget.value.trim()
                // Empty input clears the cap: send explicit `null` so the PATCH unsets
                // the column (sending `undefined` would drop the key and leave the cap).
                if (raw === "") {
                  await patchConnection(api, c.id, { rateCapPerMinute: null })
                  await refetch()
                  return
                }
                const cap = Number(raw)
                // Ignore non-numeric input rather than sending a corrupting value.
                if (!Number.isFinite(cap)) return
                await patchConnection(api, c.id, { rateCapPerMinute: cap })
                await refetch()
              }}
            />
          </div>

          <Show when={!envChip(c) && (c.authFlavor === "bearer" || c.authFlavor === "none")}>
            <CredentialsBlock conn={c} onSaved={() => void refetch()} />
          </Show>
        </div>
      )}
    </Show>
  )
}

/** A new token and the custom headers of a bearer or no-auth server, saved together. */
const CredentialsBlock: Component<{ conn: McpConnection; onSaved: () => void }> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [token, setToken] = createSignal("")
  const [headers, setHeaders] = createSignal<HeaderPatch>({})
  const [saving, setSaving] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  const dirty = () => token().trim() !== "" || Object.keys(headers()).length > 0

  async function save(): Promise<void> {
    setSaving(true)
    setError(null)
    const body: McpConnectionPatchBody = {}
    if (token().trim()) body.bearerToken = token().trim()
    if (Object.keys(headers()).length > 0) body.customHeaders = headers()
    try {
      await patchConnection(api, props.conn.id, body)
      props.onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      class="space-y-3 rounded-lg border border-border bg-surface p-4"
      data-testid="mcp-config-credentials"
    >
      <Show when={props.conn.authFlavor === "bearer"}>
        <label class="flex flex-col gap-1">
          <span class="text-[12.5px] font-medium text-text">
            {i18n.t("kernel.mcpUi.replaceToken")}
          </span>
          <input
            type="password"
            data-testid="mcp-config-bearer-token"
            class="rounded border border-border bg-bg px-2 py-1 font-mono text-sm"
            autocomplete="new-password"
            placeholder={i18n.t("kernel.mcpUi.tokenKeepPlaceholder")}
            value={token()}
            onInput={(e) => setToken(e.currentTarget.value)}
          />
        </label>
      </Show>
      <CustomHeadersEditor savedNames={props.conn.customHeaderNames ?? []} onChange={setHeaders} />
      <Show when={error()}>
        {(msg) => (
          <div data-testid="mcp-config-credentials-error" role="alert" class="text-sm text-error">
            {msg()}
          </div>
        )}
      </Show>
      <div class="flex justify-end">
        <Button
          size="sm"
          data-testid="mcp-config-credentials-save"
          disabled={!dirty()}
          loading={saving()}
          onClick={() => void save()}
        >
          {i18n.t("kernel.mcpUi.saveCredentials")}
        </Button>
      </div>
    </div>
  )
}
