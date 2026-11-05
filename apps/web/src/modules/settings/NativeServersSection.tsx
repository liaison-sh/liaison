// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE SERVERS GROUP OF THE PHONE'S SETTINGS ROOT.
//
// The mobile app remembers several Liaison servers (an owner with more than one
// organisation, a developer with a local server) and moves between them from
// here: every saved server with a check on the current one, then "Add a
// server", "Remove this server" and "Sign out". The shell does the moving
// (apps/mobile servers/server-list.ts, published on the native bridge); this is
// the list the user reads and taps, in the grouped style of the rest of the
// screen.
//
// THE DESKTOP SHOWS IT TOO. The desktop shell publishes the same servers on
// its own bridge (`DesktopBridge.servers`), and the group is drawn at the top
// of Profile (`DesktopServersSection`) as well as in the sidebar's account
// menu (modules/desktop/DesktopServersMenu.tsx). On Windows and Linux that is
// the only switcher: the shell draws no menu strip in the window there.
//
// A BROWSER GETS NOTHING. The group exists only when a shell published the
// servers, so a browser tab renders exactly what it rendered before.
//
// Removing a server signs out of it and forgets it, so it is confirmed first:
// here on the phone, in the shell's own native dialog on the desktop
// (`confirmsRemoval`), which a page script cannot answer.

import { isValidServerAddress, normalizeServerAddress } from "@liaison/shared"
import { Check } from "lucide-solid"
import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { type NativeSavedServer, type NativeServers, nativeServers } from "~/lib/native-bridge"
import { desktopServers } from "~/modules/desktop/desktop-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"
import { Input } from "~/ui/Input"

/** What a saved server is called: its organisation's name, else its host. */
export function serverLabel(server: NativeSavedServer): string {
  if (server.label?.trim()) return server.label.trim()
  try {
    return new URL(server.address).host
  } catch {
    return server.address
  }
}

/** The catalogue key for an address the shell refused. */
export function addRefusalKey(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  if (code === "NotALiaisonServer") return "kernel.servers.notLiaison"
  if (code === "ServerUnreachable") return "kernel.servers.unreachable"
  return "kernel.servers.invalidAddress"
}

const ROW =
  "flex min-h-11 w-full shrink-0 items-center gap-3 px-4 text-left text-[16px] text-text hover:bg-surface-hover"

/**
 * The address field that adds a server, here and on the phone's sign-in card
 * (auth/LoginServerChoice.tsx). The shell moves the app to the new server once
 * it is added; the server being left stays saved.
 */
export const AddServerForm: Component<{
  servers: NativeServers
  onCancel: () => void
  class?: string
}> = (props) => {
  const i18n = useI18n()
  const [address, setAddress] = createSignal("")
  const [refusal, setRefusal] = createSignal<string | null>(null)
  const [busy, setBusy] = createSignal(false)

  async function add(event?: Event): Promise<void> {
    event?.preventDefault()
    if (busy()) return
    setBusy(true)
    setRefusal(null)
    // The same rule as the shell's first launch: a bare host gets https://.
    const candidate = normalizeServerAddress(address())
    if (!isValidServerAddress(candidate)) {
      setRefusal("kernel.servers.invalidAddress")
      setBusy(false)
      return
    }
    try {
      await props.servers.add(candidate)
    } catch (error) {
      setRefusal(addRefusalKey(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form class={`flex flex-col gap-3 ${props.class ?? ""}`} onSubmit={(event) => void add(event)}>
      <Input
        label={i18n.t("kernel.servers.addPrompt")}
        placeholder="liaison.example.com"
        value={address()}
        onInput={(event) => {
          setAddress(event.currentTarget.value)
          setRefusal(null)
        }}
        // NOT type="url": iOS refuses a bare host ("Enter a URL") before
        // this form sees it. A text field with the URL keyboard instead.
        type="text"
        inputmode="url"
        autocapitalize="none"
        autocorrect="off"
        spellcheck={false}
        autocomplete="url"
        data-testid="you-server-address"
      />
      <Show when={refusal()}>
        {(key) => (
          <p role="alert" class="text-xs text-error">
            {i18n.t(key())}
          </p>
        )}
      </Show>
      <div class="flex flex-wrap gap-2">
        <Button type="submit" loading={busy()}>
          {i18n.t("kernel.servers.addAction")}
        </Button>
        <Button type="button" variant="outline" onClick={() => props.onCancel()}>
          {i18n.t("kernel.servers.cancel")}
        </Button>
      </div>
    </form>
  )
}

export const ServersGroup: Component<{ servers: NativeServers }> = (props) => {
  const i18n = useI18n()
  const [snapshot] = createResource(() => props.servers.list())
  const [adding, setAdding] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  const [confirmingRemoval, setConfirmingRemoval] = createSignal(false)

  const current = () => snapshot()?.current ?? null
  const currentServer = () => snapshot()?.servers.find((server) => server.address === current())

  async function run(action: () => Promise<void>): Promise<void> {
    if (busy()) return
    setBusy(true)
    try {
      await action()
    } catch {
      addToast({ message: i18n.t("kernel.servers.switchFailed"), type: "error" })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="you-group-servers" class="flex flex-col">
      <h2 class="px-4 pb-1 pt-4 text-[12px] font-semibold uppercase tracking-wide text-text-tertiary">
        {i18n.t("kernel.servers.heading")}
      </h2>
      <For each={snapshot()?.servers ?? []}>
        {(server) => {
          const isCurrent = () => server.address === current()
          return (
            <button
              type="button"
              data-testid="you-server-row"
              aria-current={isCurrent() ? "true" : undefined}
              disabled={busy()}
              onClick={() => {
                if (!isCurrent()) void run(() => props.servers.switchTo(server.address))
              }}
              class={ROW}
            >
              <span class="min-w-0 flex-1 truncate">{serverLabel(server)}</span>
              <Show when={isCurrent()}>
                <Check
                  size={18}
                  class="shrink-0 text-accent"
                  aria-label={i18n.t("kernel.servers.currentServer")}
                />
              </Show>
            </button>
          )
        }}
      </For>

      <Show
        when={adding()}
        fallback={
          <button
            type="button"
            data-testid="you-server-add"
            onClick={() => {
              // The desktop's own connect step, when the shell has one.
              if (props.servers.beginAdd) props.servers.beginAdd()
              else setAdding(true)
            }}
            class={`${ROW} text-accent`}
          >
            {i18n.t("kernel.servers.addServer")}
          </button>
        }
      >
        <AddServerForm
          servers={props.servers}
          class="px-4 py-3"
          onCancel={() => setAdding(false)}
        />
      </Show>

      <Show when={currentServer()}>
        <button
          type="button"
          data-testid="you-server-remove"
          disabled={busy()}
          onClick={() => {
            const target = current()
            // The desktop shell asks its own native question.
            if (props.servers.confirmsRemoval) {
              if (target) void run(() => props.servers.remove(target))
            } else setConfirmingRemoval(true)
          }}
          class={`${ROW} text-error`}
        >
          {i18n.t("kernel.servers.removeServer")}
        </button>
        <button
          type="button"
          data-testid="you-server-sign-out"
          disabled={busy()}
          onClick={() => void run(() => props.servers.signOut())}
          class={ROW}
        >
          {i18n.t("kernel.servers.signOut")}
        </button>
      </Show>

      <Dialog open={confirmingRemoval()} onOpenChange={setConfirmingRemoval}>
        <Dialog.Content class="max-w-sm">
          <Dialog.Title>{i18n.t("kernel.servers.removeTitle")}</Dialog.Title>
          <Dialog.Description>
            {i18n.t("kernel.servers.removeMessage", {
              server: currentServer() ? serverLabel(currentServer() as NativeSavedServer) : "",
            })}
          </Dialog.Description>
          <div class="mt-5 flex justify-end gap-2">
            <Button variant="outline" onClick={() => setConfirmingRemoval(false)}>
              {i18n.t("kernel.servers.cancel")}
            </Button>
            <Button
              data-testid="you-server-remove-confirm"
              variant="danger"
              onClick={() => {
                const target = current()
                setConfirmingRemoval(false)
                if (target) void run(() => props.servers.remove(target))
              }}
            >
              {i18n.t("kernel.servers.removeConfirm")}
            </Button>
          </div>
        </Dialog.Content>
      </Dialog>
    </div>
  )
}

/** The group, or nothing at all outside a shell that published servers. */
const NativeServersSection: Component = () => {
  const servers = () => nativeServers() ?? desktopServers()
  return <Show when={servers()}>{(published) => <ServersGroup servers={published()} />}</Show>
}

/** The desktop's group alone, for the top of Profile. Nothing on a phone. */
export const DesktopServersSection: Component = () => {
  return (
    <Show when={desktopServers()}>{(published) => <ServersGroup servers={published()} />}</Show>
  )
}

export default NativeServersSection
