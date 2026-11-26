// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE DESKTOP'S FIRST SCREEN: A LIAISON CLOUD WORKSPACE.
//
// A first launch asks for a workspace name under the build's cloud domain
// (`acme` becomes `https://acme.liaison.sh`) instead of a server address. The
// address it builds goes through exactly what `DesktopConnect` does with a
// typed one: the shell checks that a Liaison answers there, stores it, and the
// page reloads onto it. Somebody on their own server takes "Use a self-hosted
// server" to the address field, unchanged (`DesktopServerStep` switches).
//
// A DEEP LINKED WORKSPACE IS SHOWN, NEVER SILENTLY SAVED, as on the address
// screen: a `liaison://connect` link to `https://<name>.<domain>` prefills the
// name, and the user's click applies it.
//
// The two links to the cloud's own pages open in the system browser: the
// workspace reminder needs the site's bot check, so there is no lookup here.

import {
  cloudPageUrl,
  workspaceAddress,
  workspaceSlugFromAddress,
  workspaceSlugFromInput,
} from "@liaison/shared"
import { type Component, createSignal, createUniqueId, Show } from "solid-js"
import { cn } from "~/lib/cn"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { desktopState, setServerAddress } from "./desktop-store"
import { openExternal } from "./external-links"

/** NORMATIVE catalogue keys, English in kernel.json. No dash punctuation (A7). */
export const CLOUD_PROMPT = "kernel.desktopUi.cloud.prompt"
export const CLOUD_WORKSPACE_LABEL = "kernel.desktopUi.cloud.workspace"
export const CLOUD_PLACEHOLDER = "kernel.desktopUi.cloud.placeholder"
export const CLOUD_ACTION = "kernel.desktopUi.cloud.action"
export const CLOUD_INVALID_WORKSPACE = "kernel.desktopUi.cloud.invalidWorkspace"
export const CLOUD_NOT_FOUND = "kernel.desktopUi.cloud.notFound"
export const CLOUD_UNREACHABLE = "kernel.desktopUi.cloud.unreachable"
export const CLOUD_DEEP_LINK_CONFIRM = "kernel.desktopUi.cloud.deepLinkConfirm"
export const CLOUD_FORGOT = "kernel.desktopUi.cloud.forgot"
export const CLOUD_SELF_HOSTED = "kernel.desktopUi.cloud.selfHosted"
export const CLOUD_CREATE_WORKSPACE = "kernel.desktopUi.cloud.createWorkspace"
const CONNECT_CANCEL = "kernel.servers.cancel"

/** The refusal line, by the shell's own reason code (see `refusalKey`). */
export function cloudRefusalKey(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  if (code === "ServerUnreachable") return CLOUD_UNREACHABLE
  return CLOUD_NOT_FOUND
}

export interface DesktopCloudConnectProps {
  /** The build's cloud domain (`liaison.sh`). */
  domain: string
  /** Switches to the address field. */
  onSelfHosted: () => void
  /** Closes the step with nothing applied, when it was opened over a session. */
  onCancel?: () => void
}

const DesktopCloudConnect: Component<DesktopCloudConnectProps> = (props) => {
  const i18n = useI18n()
  const fieldId = createUniqueId()
  const linkedSlug = () => {
    const linked = desktopState().deepLinkAddress
    return linked ? (workspaceSlugFromAddress(linked, props.domain) ?? "") : ""
  }
  const [typed, setTyped] = createSignal<string | null>(null)
  const [refusal, setRefusal] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)
  const value = () => typed() ?? linkedSlug()

  async function connect(event?: Event) {
    event?.preventDefault()
    if (busy()) return
    const slug = workspaceSlugFromInput(value(), props.domain)
    if (slug === null) {
      setRefusal(CLOUD_INVALID_WORKSPACE)
      return
    }
    setRefusal(null)
    setBusy(true)
    try {
      await setServerAddress(workspaceAddress(slug, props.domain))
      // Same as the address field: the app reads its server at load (FX8).
      try {
        globalThis.location?.reload?.()
      } catch {
        // The address is stored either way.
      }
    } catch (error) {
      setRefusal(cloudRefusalKey(error))
    } finally {
      setBusy(false)
    }
  }

  const page = (which: "login" | "signup") =>
    void openExternal(cloudPageUrl(props.domain, which, i18n.locale()))

  const linkClass =
    "text-[12.5px] text-accent-muted transition-colors duration-150 hover:text-accent"

  return (
    <form
      data-testid="desktop-cloud-connect"
      class="flex flex-col gap-4"
      onSubmit={(event) => void connect(event)}
    >
      <p class="text-center text-[13px] text-text-secondary">
        <Show when={linkedSlug() && typed() === null} fallback={i18n.t(CLOUD_PROMPT)}>
          {i18n.t(CLOUD_DEEP_LINK_CONFIRM)}
        </Show>
      </p>
      <div class="flex flex-col gap-1.5">
        <label for={fieldId} class="text-[12.5px] font-medium text-text-secondary">
          {i18n.t(CLOUD_WORKSPACE_LABEL)}
        </label>
        <div
          class={cn(
            "flex w-full items-center rounded-sm border bg-bg transition-colors duration-150",
            "focus-within:border-accent-muted",
            refusal() ? "border-error" : "border-border",
          )}
        >
          <input
            id={fieldId}
            data-testid="desktop-cloud-workspace"
            class="min-w-0 flex-1 bg-transparent px-3 py-[9px] text-[13.5px] text-text outline-none placeholder:text-text-tertiary"
            placeholder={i18n.t(CLOUD_PLACEHOLDER)}
            value={value()}
            aria-invalid={refusal() !== null}
            autocomplete="off"
            autocapitalize="none"
            spellcheck={false}
            onInput={(event) => {
              setTyped(event.currentTarget.value)
              setRefusal(null)
            }}
          />
          <span
            data-testid="desktop-cloud-suffix"
            class="whitespace-nowrap pr-3 text-[13.5px] text-text-tertiary"
          >
            .{props.domain}
          </span>
        </div>
      </div>
      <Show when={refusal()}>
        {(key) => (
          <p role="alert" class="text-xs text-error">
            {i18n.t(key())}
          </p>
        )}
      </Show>
      <Button fullWidth type="submit" loading={busy()}>
        {i18n.t(CLOUD_ACTION)}
      </Button>
      <Show when={props.onCancel}>
        {(cancel) => (
          <Button fullWidth type="button" variant="outline" onClick={() => cancel()()}>
            {i18n.t(CONNECT_CANCEL)}
          </Button>
        )}
      </Show>
      <div class="flex flex-col items-center gap-2">
        <button
          type="button"
          data-testid="desktop-cloud-forgot"
          class={linkClass}
          onClick={() => page("login")}
        >
          {i18n.t(CLOUD_FORGOT)}
        </button>
        <button
          type="button"
          data-testid="desktop-cloud-create"
          class={linkClass}
          onClick={() => page("signup")}
        >
          {i18n.t(CLOUD_CREATE_WORKSPACE)}
        </button>
        <button
          type="button"
          data-testid="desktop-cloud-self-hosted"
          class={linkClass}
          onClick={() => props.onSelfHosted()}
        >
          {i18n.t(CLOUD_SELF_HOSTED)}
        </button>
      </div>
    </form>
  )
}

export default DesktopCloudConnect
