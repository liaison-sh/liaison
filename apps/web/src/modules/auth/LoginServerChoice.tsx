// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE WAY BACK FROM A SIGN-IN SCREEN, ON THE PHONE AND THE DESKTOP.
//
// "Add a server" starts the app again on the new server, and the first thing
// that server shows is this card. Someone who added the wrong address, or who
// has no account there, would otherwise be stuck on it: the settings where the
// saved servers live (NativeServersSection) are behind the sign-in. So the card
// names the server it signs in to, offers every other saved server, lets this
// one be removed when there is another to fall back to, and ALWAYS offers to
// add a server, even when this is the only one saved: a phone set up on one
// server must not be locked to it by its own sign-in screen.
//
// THE DESKTOP gets the same way back, from the servers its shell publishes
// (`DesktopBridge.servers`, the ones the sidebar's Servers switcher reads),
// behind one "Change server" control so the email form stays the card. A new
// address goes through the desktop's own connect step (`beginAdd`), and the
// removal stays in Settings, where the shell asks its own question.
//
// A BROWSER GETS NOTHING: the block exists only when a shell published its
// servers.

import { type Component, createResource, createSignal, For, Show } from "solid-js"
import { type NativeServers, nativeServers } from "~/lib/native-bridge"
import { desktopServers } from "~/modules/desktop/desktop-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { AddServerForm, serverLabel } from "~/modules/settings/NativeServersSection"
import { addToast } from "~/modules/shell/toast-store"
import { Button } from "~/ui/Button"
import { Dialog } from "~/ui/Dialog"

const LINK = "text-[12.5px] text-accent-muted hover:text-accent transition-colors duration-150"

/**
 * The server as the desktop names it on its sign-in card: the host, since the
 * question there is which server this is, not what its organisation is called.
 */
function serverHost(address: string): string {
  return serverLabel({ address, label: null })
}

const Choice: Component<{ servers: NativeServers; desktop?: boolean }> = (props) => {
  const i18n = useI18n()
  const [snapshot] = createResource(async () => {
    try {
      return await props.servers.list()
    } catch {
      return null
    }
  })
  const [busy, setBusy] = createSignal(false)
  const [confirmingRemoval, setConfirmingRemoval] = createSignal(false)
  const [adding, setAdding] = createSignal(false)
  // The desktop's choices wait behind "Change server"; the phone's are open.
  const [changing, setChanging] = createSignal(!props.desktop)

  const current = () => snapshot()?.servers.find((s) => s.address === snapshot()?.current)
  const others = () => snapshot()?.servers.filter((s) => s.address !== snapshot()?.current) ?? []

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

  function beginAdd(): void {
    // The desktop's own connect step, when the shell has one.
    if (props.desktop && props.servers.beginAdd) props.servers.beginAdd()
    else setAdding(true)
  }

  return (
    <Show when={current()}>
      {(server) => (
        <div
          data-testid="login-servers"
          class="mt-6 flex flex-col items-center gap-2 border-t border-border pt-5"
        >
          <p data-testid="login-server-current" class="text-center text-[12px] text-text-tertiary">
            {i18n.t("kernel.servers.signingInTo", {
              server: props.desktop ? serverHost(server().address) : serverLabel(server()),
            })}
          </p>
          <Show
            when={changing()}
            fallback={
              <button
                type="button"
                data-testid="login-server-change"
                class={LINK}
                onClick={() => setChanging(true)}
              >
                {i18n.t("kernel.servers.changeServer")}
              </button>
            }
          >
            <For each={others()}>
              {(other) => (
                <button
                  type="button"
                  data-testid="login-server-switch"
                  disabled={busy()}
                  class={LINK}
                  onClick={() => void run(() => props.servers.switchTo(other.address))}
                >
                  {i18n.t("kernel.servers.useInstead", {
                    server: props.desktop ? serverHost(other.address) : serverLabel(other),
                  })}
                </button>
              )}
            </For>
            <Show
              when={adding()}
              fallback={
                <button
                  type="button"
                  data-testid="login-server-add"
                  disabled={busy()}
                  class={LINK}
                  onClick={beginAdd}
                >
                  {i18n.t(
                    props.desktop && props.servers.beginAdd
                      ? "kernel.servers.addServerEllipsis"
                      : "kernel.servers.addServer",
                  )}
                </button>
              }
            >
              <AddServerForm
                servers={props.servers}
                class="w-full pt-2"
                onCancel={() => setAdding(false)}
              />
            </Show>
            <Show when={!props.desktop && others().length > 0}>
              <button
                type="button"
                data-testid="login-server-remove"
                disabled={busy()}
                class="text-[12.5px] text-error transition-colors duration-150 hover:opacity-80"
                onClick={() => setConfirmingRemoval(true)}
              >
                {i18n.t("kernel.servers.removeServer")}
              </button>
            </Show>
          </Show>

          <Dialog open={confirmingRemoval()} onOpenChange={setConfirmingRemoval}>
            <Dialog.Content class="max-w-sm">
              <Dialog.Title>{i18n.t("kernel.servers.removeTitle")}</Dialog.Title>
              <Dialog.Description>
                {i18n.t("kernel.servers.removeMessage", { server: serverLabel(server()) })}
              </Dialog.Description>
              <div class="mt-5 flex justify-end gap-2">
                <Button variant="outline" onClick={() => setConfirmingRemoval(false)}>
                  {i18n.t("kernel.servers.cancel")}
                </Button>
                <Button
                  data-testid="login-server-remove-confirm"
                  variant="danger"
                  onClick={() => {
                    const target = server().address
                    setConfirmingRemoval(false)
                    void run(() => props.servers.remove(target))
                  }}
                >
                  {i18n.t("kernel.servers.removeConfirm")}
                </Button>
              </div>
            </Dialog.Content>
          </Dialog>
        </div>
      )}
    </Show>
  )
}

/** The block, or nothing at all outside a shell that published its servers. */
const LoginServerChoice: Component = () => {
  const phone = nativeServers()
  return (
    <Show
      when={phone}
      fallback={
        <Show when={desktopServers()}>
          {(published) => <Choice servers={published()} desktop />}
        </Show>
      }
    >
      {(published) => <Choice servers={published()} />}
    </Show>
  )
}

export default LoginServerChoice
