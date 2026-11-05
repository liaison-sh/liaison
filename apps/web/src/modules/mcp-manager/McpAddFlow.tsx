// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Adding an MCP server, in steps (S25, prototype S-MCPADD), for the org
// (Settings > Connectors) and for oneself (You > Connected tools):
//
//   1. Address  the server URL; `POST /probe` works out how to sign in.
//   2. Sign in  by what the probe found: automatic registration (DCR, CIMD),
//               a client the admin creates at the provider (its client id and
//               secret, and the exact redirect URL to give it), a token, or
//               nothing. Custom headers go with a token or no auth.
//   3. Tools    a dialog the person completes (McpToolsReviewDialog): the default
//               policy in one click, then what the first dial found, with
//               Allowed / Needs approval / Off. It opens by itself once the
//               sign-in or the connect succeeds.
//
// What is kept when something fails, deliberately:
//   - A connection that was never usable is deleted: a token or open server
//     whose first test fails, a sign-in that cannot start or is cancelled, or
//     an add abandoned while the sign-in tab is open. A failed add leaves
//     nothing in the list.
//   - A connection whose sign-in finished stays even if the first test then
//     fails: the person signed in, and the list shows why it is not working.
//
// The sign-in finishes in another tab on the server's own page, so this page
// re-reads the connection when the person comes back to it (refetch-on-return).
import { type Component, createSignal, For, Match, Show, Switch } from "solid-js"
import { ApiError } from "~/lib/api-client"
import { hasScope } from "~/modules/auth/auth-store"
import { openExternal } from "~/modules/desktop/external-links"
import { useI18n } from "~/modules/i18n/i18n-context"
import {
  createConnection,
  deleteConnection,
  listConnections,
  probeMcpServer,
  signInToMcp,
  testConnection,
} from "~/modules/mcp-manager/api"
import { CopyField } from "~/modules/mcp-manager/CopyField"
import { CustomHeadersEditor } from "~/modules/mcp-manager/CustomHeadersEditor"
import { MCP_ACCESS_ADMIN_SCOPE } from "~/modules/mcp-manager/McpAccessSection"
import { McpToolsReviewDialog } from "~/modules/mcp-manager/McpToolsReviewDialog"
import { onReturnToPage } from "~/modules/mcp-manager/refetch-on-return"
import type {
  McpConnection,
  McpConnectionCreateBody,
  McpOwnershipScope,
  McpProbeResult,
  McpToolSummary,
} from "~/modules/mcp-manager/types"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

interface Props {
  /** Whose connection this creates. Defaults to "org". */
  ownership?: McpOwnershipScope
  onCancel?: () => void
  /** The connection is saved and its tools reviewed. */
  onDone?: (conn: McpConnection) => void
}

type Step = 1 | 2 | 3
type Busy = null | "checking" | "connecting" | "waiting"

const SLUG_MAX = 32
const SKIPPED_LABELS = new Set(["mcp", "www", "api", "app"])

/** A name for the server from its host: `https://mcp.example.com/mcp` → "Example". */
export function suggestedName(url: string): string {
  let host: string
  try {
    host = new URL(url).hostname
  } catch {
    return ""
  }
  if (/^[\d.]+$/.test(host) || host.includes(":")) return host
  const labels = host.split(".")
  const meaningful = labels.slice(0, -1).filter((l) => !SKIPPED_LABELS.has(l))
  const word = meaningful.at(-1) ?? labels[0] ?? host
  return word.charAt(0).toUpperCase() + word.slice(1)
}

/** The connection handle the API wants (`^[a-z0-9-]{1,32}$`) from a name. */
export function slugFrom(name: string, attempt = 0): string {
  const base =
    name
      .normalize("NFKD")
      .replace(/\p{M}/gu, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "mcp-server"
  const suffix = attempt > 0 ? `-${attempt + 1}` : ""
  return `${base.slice(0, SLUG_MAX - suffix.length).replace(/-+$/, "")}${suffix}`
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}

export const McpAddFlow: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const ownership = (): McpOwnershipScope => props.ownership ?? "org"
  const [step, setStep] = createSignal<Step>(1)
  const [busy, setBusy] = createSignal<Busy>(null)
  const [error, setError] = createSignal<string | null>(null)
  const [url, setUrl] = createSignal("")
  const [probe, setProbe] = createSignal<McpProbeResult | null>(null)
  const [name, setName] = createSignal("")
  const [clientId, setClientId] = createSignal("")
  const [clientSecret, setClientSecret] = createSignal("")
  const [token, setToken] = createSignal("")
  const [headers, setHeaders] = createSignal<Record<string, string>>({})
  const [created, setCreated] = createSignal<McpConnection | null>(null)
  const [tools, setTools] = createSignal<McpToolSummary[]>([])
  const [stillWaiting, setStillWaiting] = createSignal(false)
  /** The tools review dialog: opens by itself when step 3 is reached. */
  const [reviewOpen, setReviewOpen] = createSignal(false)
  /** The sign-in finished: from here the connection is kept whatever happens. */
  const [signedIn, setSignedIn] = createSignal(false)

  const mode = () => probe()?.mode
  const isOAuth = () => mode() === "dcr" || mode() === "cimd" || mode() === "preregistered"
  const host = () => {
    try {
      return new URL(url()).host
    } catch {
      return url()
    }
  }

  async function check(): Promise<void> {
    const target = url().trim()
    if (!target) return
    setError(null)
    setBusy("checking")
    try {
      const found = await probeMcpServer(api, target)
      setUrl(target)
      setProbe(found)
      if (!name()) setName(suggestedName(target))
      setStep(2)
    } catch (e) {
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  function body(attempt: number): McpConnectionCreateBody {
    const display = name().trim() || suggestedName(url()) || host()
    const out: McpConnectionCreateBody = {
      slug: slugFrom(display, attempt),
      displayName: display,
      transport: "http",
      httpUrl: url(),
      ownershipScope: ownership(),
    }
    switch (mode()) {
      case "dcr":
      case "cimd":
        out.authFlavor = "oauth_dcr"
        break
      case "preregistered":
        out.authFlavor = "oauth_static"
        out.oauthClientId = clientId().trim()
        if (clientSecret().trim()) out.oauthClientSecret = clientSecret().trim()
        break
      case "bearer":
        out.authFlavor = "bearer"
        out.bearerToken = token().trim()
        break
      default:
        out.authFlavor = "none"
    }
    if (!isOAuth() && Object.keys(headers()).length > 0) out.customHeaders = headers()
    return out
  }

  /** Saves the connection, taking the next free handle when the name's is used. */
  async function save(): Promise<McpConnection> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await createConnection(api, body(attempt))
      } catch (e) {
        if (e instanceof ApiError && e.code === "slug_conflict" && attempt < 20) continue
        throw e
      }
    }
  }

  /** Removes a connection that never worked; the add leaves nothing behind. */
  async function discard(conn: McpConnection | null): Promise<void> {
    if (signedIn()) return
    setCreated(null)
    if (conn) await deleteConnection(api, conn.id).catch(() => {})
  }

  async function connectDirect(): Promise<void> {
    setError(null)
    setBusy("connecting")
    let conn: McpConnection | null = null
    try {
      conn = await save()
      const result = await testConnection(api, conn.id)
      if (!result.ok) {
        await discard(conn)
        setError(result.error?.message ?? i18n.t("kernel.mcpUi.testFailedGeneric"))
        return
      }
      setCreated(conn)
      setTools(result.tools ?? [])
      setStep(3)
      setReviewOpen(true)
    } catch (e) {
      await discard(conn)
      setError(messageOf(e))
    } finally {
      setBusy(null)
    }
  }

  async function signIn(): Promise<void> {
    setError(null)
    setStillWaiting(false)
    setBusy("connecting")
    let conn: McpConnection | null = created()
    try {
      conn ??= await save()
      setCreated(conn)
      const outcome = await signInToMcp(api, conn.id, (u) => void openExternal(u))
      if (outcome === "cancelled") {
        await discard(conn)
        setBusy(null)
        return
      }
      if (outcome === "connected") {
        await afterSignIn(conn)
        return
      }
      setBusy("waiting")
    } catch (e) {
      await discard(conn)
      setError(messageOf(e))
      setBusy(null)
    }
  }

  /** Whether the sign-in in the other tab has finished; then on to the tools. */
  async function checkSignedIn(manual: boolean): Promise<void> {
    const conn = created()
    if (!conn || busy() !== "waiting") return
    try {
      const row = (await listConnections(api)).find((r) => r.id === conn.id)
      if (row && row.status !== "oauth_pending") {
        await afterSignIn(conn)
        return
      }
      if (manual) setStillWaiting(true)
    } catch (e) {
      setError(messageOf(e))
    }
  }

  onReturnToPage(() => void checkSignedIn(false))

  async function afterSignIn(conn: McpConnection): Promise<void> {
    setSignedIn(true)
    setStillWaiting(false)
    setBusy("connecting")
    try {
      const result = await testConnection(api, conn.id)
      if (!result.ok) {
        // Signed in, so kept: the list shows the error and offers a new sign-in.
        setError(result.error?.message ?? i18n.t("kernel.mcpUi.testFailedGeneric"))
        setBusy("waiting")
        return
      }
      setTools(result.tools ?? [])
      setStep(3)
      setReviewOpen(true)
      setBusy(null)
    } catch (e) {
      setError(messageOf(e))
      setBusy("waiting")
    }
  }

  async function cancel(): Promise<void> {
    // Mid sign-in the row exists but was never signed in: it goes too.
    if (step() === 2) await discard(created())
    props.onCancel?.()
  }

  function back(): void {
    // A signed-in connection is kept; going back starts a new one.
    void discard(created())
    setCreated(null)
    setSignedIn(false)
    setBusy(null)
    setError(null)
    setStep(1)
  }

  const canSignIn = () =>
    mode() !== "preregistered" ||
    (clientId().trim() !== "" && (!probe()?.requiresClientSecret || clientSecret().trim() !== ""))

  const stepLabels = [
    "kernel.mcpUi.stepAddress",
    "kernel.mcpUi.stepSignIn",
    "kernel.mcpUi.stepTools",
  ]

  return (
    <div class="flex flex-col gap-4" data-testid="mcp-add-flow">
      <ol
        class="m-0 flex list-none flex-wrap items-center gap-2 p-0 text-xs"
        aria-label={i18n.t("kernel.mcpUi.progress")}
      >
        <For each={stepLabels}>
          {(label, i) => (
            <li
              data-testid={`mcp-add-step-${i() + 1}`}
              aria-current={step() === i() + 1 ? "step" : undefined}
              class="inline-flex items-center gap-1.5"
              classList={{
                "font-semibold text-text": step() === i() + 1,
                "text-text-tertiary": step() !== i() + 1,
              }}
            >
              <span class="inline-flex h-5 w-5 items-center justify-center rounded-full border border-border text-[11px]">
                {step() > i() + 1 ? "✓" : i() + 1}
              </span>
              {i18n.t(label)}
              <Show when={i() < stepLabels.length - 1}>
                <span class="ml-1 text-text-tertiary" aria-hidden="true">
                  ·
                </span>
              </Show>
            </li>
          )}
        </For>
      </ol>

      <Show when={ownership() === "personal"}>
        <p data-testid="mcp-personal-hint" class="text-sm text-text-secondary">
          {i18n.t("kernel.mcpUi.personalHint")}
        </p>
      </Show>

      <Show when={error()}>
        {(msg) => (
          <div
            data-testid="mcp-add-error"
            role="alert"
            class="rounded-md border border-warning-border bg-warning-glow px-3 py-2 text-sm text-text"
          >
            {msg()}
          </div>
        )}
      </Show>

      <Switch>
        <Match when={step() === 1}>
          <form
            class="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
            onSubmit={(e) => {
              e.preventDefault()
              void check()
            }}
          >
            <label class="flex flex-col gap-1">
              <span class="text-[12.5px] font-medium text-text">
                {i18n.t("kernel.mcpUi.serverAddress")}
              </span>
              <input
                type="url"
                data-testid="mcp-add-url"
                class="rounded border border-border bg-bg px-2 py-1.5 text-sm"
                placeholder="https://mcp.example.com/mcp"
                autocomplete="off"
                spellcheck={false}
                value={url()}
                onInput={(e) => setUrl(e.currentTarget.value)}
              />
              <span class="text-xs text-text-secondary">
                {i18n.t("kernel.mcpUi.serverAddressHint")}
              </span>
            </label>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" data-testid="mcp-add-cancel" onClick={() => void cancel()}>
                {i18n.t("kernel.common.cancel")}
              </Button>
              <Button
                type="submit"
                data-testid="mcp-add-check"
                loading={busy() === "checking"}
                disabled={url().trim() === ""}
              >
                {busy() === "checking"
                  ? i18n.t("kernel.mcpUi.checking")
                  : i18n.t("kernel.mcpUi.continue")}
              </Button>
            </div>
          </form>
        </Match>

        <Match when={step() === 2 && probe()}>
          {(found) => (
            <div
              class="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
              data-testid={`mcp-add-mode-${found().mode}`}
            >
              <div class="flex items-center gap-3">
                <span class="inline-flex h-9 w-9 flex-none items-center justify-center rounded-md border border-border bg-bg text-sm font-semibold">
                  {(name() || host()).slice(0, 1).toUpperCase()}
                </span>
                <div class="min-w-0">
                  <div class="truncate text-sm font-semibold text-text">{name() || host()}</div>
                  <div class="truncate font-mono text-xs text-text-secondary">{url()}</div>
                </div>
              </div>
              <div
                class="rounded-md border border-border bg-bg px-3 py-2 text-sm"
                data-testid="mcp-add-discovery"
              >
                <Switch>
                  <Match when={found().mode === "dcr" || found().mode === "cimd"}>
                    <div class="font-medium text-text">
                      {i18n.t("kernel.mcpUi.discoveryAutomatic")}
                    </div>
                    <div class="text-xs text-text-secondary">
                      {i18n.t("kernel.mcpUi.discoveryAutomaticHint")}
                    </div>
                  </Match>
                  <Match when={found().mode === "preregistered"}>
                    <div class="font-medium text-text">
                      {i18n.t("kernel.mcpUi.discoveryClient")}
                    </div>
                    <div class="text-xs text-text-secondary">
                      {i18n.t("kernel.mcpUi.discoveryClientHint")}
                    </div>
                  </Match>
                  <Match when={found().mode === "bearer"}>
                    <div class="font-medium text-text">{i18n.t("kernel.mcpUi.discoveryToken")}</div>
                  </Match>
                  <Match when={found().mode === "none"}>
                    <div class="font-medium text-text">{i18n.t("kernel.mcpUi.discoveryOpen")}</div>
                  </Match>
                </Switch>
              </div>

              <label class="flex flex-col gap-1">
                <span class="text-[12.5px] font-medium text-text">
                  {i18n.t("kernel.mcpUi.displayName")}
                </span>
                <input
                  data-testid="mcp-add-name"
                  class="rounded border border-border bg-bg px-2 py-1 text-sm"
                  value={name()}
                  disabled={busy() === "waiting"}
                  onInput={(e) => setName(e.currentTarget.value)}
                />
              </label>

              <Show when={found().mode === "preregistered"}>
                <CopyField
                  testid="mcp-add-callback-url"
                  label={i18n.t("kernel.mcpUi.redirectUrlLabel")}
                  value={found().callbackUrl}
                />
                <label class="flex flex-col gap-1">
                  <span class="text-[12.5px] font-medium text-text">
                    {i18n.t("kernel.mcpUi.clientId")}
                  </span>
                  <input
                    data-testid="mcp-add-client-id"
                    class="rounded border border-border bg-bg px-2 py-1 font-mono text-sm"
                    autocomplete="off"
                    spellcheck={false}
                    value={clientId()}
                    disabled={busy() === "waiting"}
                    onInput={(e) => setClientId(e.currentTarget.value)}
                  />
                </label>
                <label class="flex flex-col gap-1">
                  <span class="text-[12.5px] font-medium text-text">
                    {found().requiresClientSecret
                      ? i18n.t("kernel.mcpUi.clientSecret")
                      : i18n.t("kernel.mcpUi.clientSecretOptional")}
                  </span>
                  <input
                    type="password"
                    data-testid="mcp-add-client-secret"
                    class="rounded border border-border bg-bg px-2 py-1 font-mono text-sm"
                    autocomplete="new-password"
                    value={clientSecret()}
                    disabled={busy() === "waiting"}
                    onInput={(e) => setClientSecret(e.currentTarget.value)}
                  />
                </label>
              </Show>

              <Show when={found().mode === "bearer"}>
                <label class="flex flex-col gap-1">
                  <span class="text-[12.5px] font-medium text-text">
                    {i18n.t("kernel.mcpUi.accessToken")}
                  </span>
                  <input
                    type="password"
                    data-testid="mcp-add-token"
                    class="rounded border border-border bg-bg px-2 py-1 font-mono text-sm"
                    autocomplete="new-password"
                    value={token()}
                    onInput={(e) => setToken(e.currentTarget.value)}
                  />
                </label>
              </Show>

              <Show when={found().mode === "bearer" || found().mode === "none"}>
                <CustomHeadersEditor
                  onChange={(patch) => {
                    const set: Record<string, string> = {}
                    for (const [k, v] of Object.entries(patch)) if (v !== null) set[k] = v
                    setHeaders(set)
                  }}
                />
              </Show>

              <Show when={busy() === "waiting"}>
                <div
                  class="rounded-md border border-border bg-bg px-3 py-2 text-sm"
                  data-testid="mcp-add-waiting"
                >
                  <div class="text-text">
                    {i18n.t("kernel.mcpUi.waitingForSignIn", { name: name() || host() })}
                  </div>
                  <Show when={stillWaiting()}>
                    <div class="text-xs text-text-secondary" data-testid="mcp-add-still-waiting">
                      {i18n.t("kernel.mcpUi.notSignedInYet")}
                    </div>
                  </Show>
                </div>
              </Show>

              <div class="flex flex-wrap justify-end gap-2">
                <Button variant="ghost" data-testid="mcp-add-back" onClick={back}>
                  {i18n.t("kernel.mcpUi.back")}
                </Button>
                <Button variant="ghost" data-testid="mcp-add-cancel" onClick={() => void cancel()}>
                  {i18n.t("kernel.common.cancel")}
                </Button>
                <Show
                  when={isOAuth()}
                  fallback={
                    <Button
                      data-testid="mcp-add-connect"
                      loading={busy() === "connecting"}
                      disabled={found().mode === "bearer" && token().trim() === ""}
                      onClick={() => void connectDirect()}
                    >
                      {i18n.t("kernel.mcpUi.connect")}
                    </Button>
                  }
                >
                  <Show
                    when={busy() === "waiting"}
                    fallback={
                      <Button
                        data-testid="mcp-add-signin"
                        loading={busy() === "connecting"}
                        disabled={!canSignIn()}
                        onClick={() => void signIn()}
                      >
                        {i18n.t("kernel.mcpUi.signInWith", { name: name() || host() })}
                      </Button>
                    }
                  >
                    <Button
                      variant="outline"
                      data-testid="mcp-add-signin-retry"
                      onClick={() => void signIn()}
                    >
                      {i18n.t("kernel.mcpUi.openSignInAgain")}
                    </Button>
                    <Button
                      data-testid="mcp-add-signed-in"
                      onClick={() => void checkSignedIn(true)}
                    >
                      {i18n.t("kernel.mcpUi.iSignedIn")}
                    </Button>
                  </Show>
                </Show>
              </div>
            </div>
          )}
        </Match>

        <Match when={step() === 3 && created()}>
          {(conn) => (
            <div class="flex flex-col gap-3" data-testid="mcp-add-tools">
              <div class="rounded-md border border-success-border bg-success-glow px-3 py-2 text-sm text-text">
                {i18n.t("kernel.mcpUi.toolsFound", { count: tools().length })}
              </div>
              <McpToolsReviewDialog
                open={reviewOpen()}
                connectionId={conn().id}
                serverName={conn().displayName}
                currentPolicy={conn().connectionDefaultPolicy ?? "gate_writes"}
                tools={tools()}
                toolsEditable={ownership() === "org"}
                accessSlug={
                  ownership() === "org" && hasScope(MCP_ACCESS_ADMIN_SCOPE)
                    ? conn().slug
                    : undefined
                }
                onClose={() => {
                  setReviewOpen(false)
                  props.onDone?.(conn())
                }}
              />
            </div>
          )}
        </Match>
      </Switch>
    </div>
  )
}
