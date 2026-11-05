// SPDX-License-Identifier: FSL-1.1-ALv2
//
// "Trust this sender": mark an address, or its whole domain, as a trusted sender for the org
// (trusted-senders-store.ts). A trusted sender counts as verified for inbound mail that arrives
// without a provider verdict, and as a known guest for calendar invitations. A public mail
// provider's domain (gmail.com, ...) is only ever trusted address by address.
//
// Shows the current state ("Trusted sender", with what made it so) to everyone, and the trust and
// remove actions to staff who hold the contacts or tickets settings admin scope.

import { emailDomainOf, isPublicEmailProvider } from "@liaison/shared"
import { type Component, createSignal, onMount, Show } from "solid-js"
import {
  canManageTrustedSenders,
  ensureTrustedSenders,
  trustEntryFor,
  trustSender,
  untrustSender,
} from "~/modules/contacts/trusted-senders-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { PopupMenu } from "~/ui/PopupMenu"

interface Props {
  email: string
  /** Prefix for the control's test ids. */
  testId: string
}

const CHIP =
  "rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wide transition-colors disabled:opacity-50"

export const TrustedSenderControl: Component<Props> = (props) => {
  const i18n = useI18n()
  const api = useApi()
  const [open, setOpen] = createSignal(false)
  const [busy, setBusy] = createSignal(false)
  onMount(() => void ensureTrustedSenders(api))

  const entry = () => trustEntryFor(props.email)
  const domain = () => emailDomainOf(props.email)
  const domainTrustable = () => !!domain() && !isPublicEmailProvider(domain())

  async function run(action: () => Promise<void>) {
    if (busy()) return
    setBusy(true)
    try {
      await action()
    } catch {
      addToast({ message: i18n.t("contacts.trusted.saveFailed"), type: "error" })
    } finally {
      setBusy(false)
      setOpen(false)
    }
  }

  return (
    <Show
      when={entry()}
      fallback={
        <Show when={canManageTrustedSenders()}>
          <PopupMenu open={open()} onOpenChange={setOpen}>
            <PopupMenu.Trigger aria-label={i18n.t("contacts.trusted.trust")}>
              <span
                data-testid={`${props.testId}-trust`}
                class={`${CHIP} border-border text-text-secondary hover:text-text`}
              >
                {i18n.t("contacts.trusted.trust")}
              </span>
            </PopupMenu.Trigger>
            <PopupMenu.Content aria-label={i18n.t("contacts.trusted.trust")} class="w-64">
              <PopupMenu.Item
                textValue={props.email}
                disabled={busy()}
                data-testid={`${props.testId}-trust-address`}
                onSelect={() => run(() => trustSender(api, "address", props.email.toLowerCase()))}
              >
                {i18n.t("contacts.trusted.trustAddress", { address: props.email })}
              </PopupMenu.Item>
              <Show when={domainTrustable()}>
                <PopupMenu.Item
                  textValue={domain() ?? ""}
                  disabled={busy()}
                  data-testid={`${props.testId}-trust-domain`}
                  onSelect={() => run(() => trustSender(api, "domain", domain() as string))}
                >
                  {i18n.t("contacts.trusted.trustDomain", { domain: domain() ?? "" })}
                </PopupMenu.Item>
              </Show>
            </PopupMenu.Content>
          </PopupMenu>
        </Show>
      }
    >
      {(e) => (
        <span class="inline-flex items-center gap-1">
          <span
            data-testid={`${props.testId}-trusted`}
            title={
              e().kind === "domain"
                ? i18n.t("contacts.trusted.byDomain", { domain: e().value })
                : i18n.t("contacts.trusted.byAddress")
            }
            class={`${CHIP} border-border text-text-secondary`}
          >
            {i18n.t("contacts.trusted.label")}
          </span>
          <Show when={canManageTrustedSenders()}>
            <button
              type="button"
              data-testid={`${props.testId}-untrust`}
              disabled={busy()}
              class={`${CHIP} border-transparent text-text-tertiary hover:border-border hover:text-text`}
              onClick={() => run(() => untrustSender(api, e().id))}
            >
              {e().kind === "domain"
                ? i18n.t("contacts.trusted.untrustDomain", { domain: e().value })
                : i18n.t("contacts.trusted.untrust")}
            </button>
          </Show>
        </span>
      )}
    </Show>
  )
}
