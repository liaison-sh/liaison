// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * "Set up your mailbox", in the conversation: a person's own mailbox (Gmail or
 * IMAP) fetches no mail until its owner chooses a mailbox password. This card
 * draws the SAME enrollment Settings > Mail draws (`MailboxEnrollment`: the
 * password, an optional passkey, "Your mailbox is ready"), or, for an owner who
 * already has a mailbox password, the same "turn this mailbox on" Settings runs
 * (`/mailbox-keys/arm`). Nothing about the keys differs from Settings: this is
 * only another place the same component renders.
 *
 * Drawn in two places: under the agent's `kernel__mailbox_setup` call, and
 * inside a personal mailbox's connect card once it connected (`quiet`: nothing
 * at all unless the mailbox waits for its password), so the person goes from
 * connecting straight to the password without asking.
 *
 * With `makePrivate` (the person asked the agent for a private mailbox), the
 * card instead makes the viewer's transparent mailbox private: the mailbox
 * password first if they have none (the same enrollment), then the server
 * re-encrypts the mailbox to their key (`/mailbox/encryption/.../make-private`).
 * A transparent mailbox needs no card otherwise: it syncs with no setup.
 *
 * Only the mailbox's owner can complete it: the card reads the viewer's own
 * mailboxes, so anyone else sees one quiet line, never a form. Calm: no alarm,
 * one sentence of why, the form.
 */
import { type Component, createSignal, onMount, Show } from "solid-js"
import { onEntityChange } from "~/framework/entity-changes"
import { userFromToken } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import type { MailAccount } from "~/modules/mail/mail-account-store"
import { MailboxEnrollment } from "~/modules/mailbox/MailboxEnrollment"
import { fetchKeyring } from "~/modules/mailbox/mailbox-api"
import { useOptionalApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

/** The states in which the owner's mailbox password is what the mailbox waits for. */
const WAITS_FOR_PASSWORD = new Set(["pending_enrollment", "paused", "none"])

/** What a finished `kernel__mailbox_setup` call asks the card to show, or null. */
export function mailboxSetupCardRef(toolCall: {
  toolName: string
  status: string
  result?: unknown
  args?: unknown
}): { email?: string; makePrivate?: boolean } | null {
  const name = toolCall.toolName.replace("kernel:", "kernel__")
  if (name !== "kernel__mailbox_setup" || toolCall.status === "error") return null
  const result = toolCall.result
  if (!result || typeof result !== "object" || (result as { card?: unknown }).card !== "shown") {
    return null
  }
  const args = toolCall.args as { email?: unknown; private?: unknown } | undefined
  const email = args?.email
  return {
    ...(typeof email === "string" && email !== "" ? { email } : {}),
    ...(args?.private === true ? { makePrivate: true } : {}),
  }
}

export interface MailboxSetupCardProps {
  /** The mailbox's address, when the card is about one (the connect card's account). */
  email?: string
  /** Draw nothing unless one of the viewer's own mailboxes waits for its password. */
  quiet?: boolean
  /** Make the viewer's transparent mailbox private (the person asked for it). */
  makePrivate?: boolean
}

export const MailboxSetupCard: Component<MailboxSetupCardProps> = (props) => {
  const i18n = useI18n()
  const api = useOptionalApi()
  const [accounts, setAccounts] = createSignal<MailAccount[] | null>(null)
  const [hasKeys, setHasKeys] = createSignal<boolean | null>(null)
  const [busy, setBusy] = createSignal(false)
  const [error, setError] = createSignal<string | null>(null)
  // Set once THIS card took the mailbox to ready: its done line stays.
  const [doneHere, setDoneHere] = createSignal(false)

  const me = () => userFromToken()?.userId ?? null
  const wanted = () => props.email?.trim().toLowerCase() || null

  /** The viewer's own personal mailboxes this card is about. */
  const mine = () =>
    (accounts() ?? []).filter(
      (a) =>
        a.ownerType === "user" &&
        a.ownerId !== null &&
        a.ownerId === me() &&
        (!wanted() || a.emailAddress.toLowerCase() === wanted()),
    )
  const waiting = () =>
    props.makePrivate
      ? null
      : (mine().find((a) => WAITS_FOR_PASSWORD.has(a.encryptionState ?? "")) ?? null)
  const transparent = () =>
    props.makePrivate ? (mine().find((a) => a.encryptionState === "managed") ?? null) : null
  const [enrollForPrivate, setEnrollForPrivate] = createSignal(false)
  const [privateDone, setPrivateDone] = createSignal<string | null>(null)

  /** Re-encrypt the mailbox to the owner's key (needs their mailbox password set). */
  async function makePrivate(account: MailAccount): Promise<void> {
    if (!api) return
    if (!hasKeys()) {
      setEnrollForPrivate(true)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await api.post(`/mailbox/encryption/accounts/${account.id}/make-private`, undefined, {
        suppressGlobalError: true,
      })
      setPrivateDone(account.emailAddress)
      await load()
    } catch (err) {
      setError(
        i18n.t("kernel.mailboxEncryption.setupCard.privateFailed", {
          message: (err as Error)?.message ?? String(err),
        }),
      )
    } finally {
      setBusy(false)
    }
  }
  const ready = () => mine().some((a) => a.encryptionState === "ready")

  async function load(): Promise<void> {
    if (!api) return
    try {
      setAccounts(await api.get<MailAccount[]>("/mail/accounts"))
    } catch {
      // No mail app, or a failed read: keep the last state; the next change reloads.
      if (accounts() === null) setAccounts([])
    }
  }

  async function loadKeys(): Promise<void> {
    if (!api) return
    try {
      const keyring = await fetchKeyring(api)
      setHasKeys(keyring.identities.some((identity) => identity.status === "active"))
    } catch {
      // A browser that cannot tell must not skip the setup: it offers the form,
      // whose own check shows an existing mailbox password.
      setHasKeys(false)
    }
  }

  onEntityChange(["mail:account", "kernel:connected_account"], () => {
    void load()
  })

  onMount(() => {
    void load()
    void loadKeys()
  })

  async function finish(account: MailAccount): Promise<void> {
    setDoneHere(true)
    if (!api) return
    // The enroll and arm routes queue the sync; this one fetches at once, as Settings does.
    try {
      await api.post(`/mail/accounts/${account.id}/sync`, undefined, { suppressGlobalError: true })
    } catch {
      // The queued sync still runs: nothing to tell the person here.
    }
    await load()
  }

  /** An owner who already has a mailbox password: arm this mailbox to it, as Settings does. */
  async function turnOn(account: MailAccount): Promise<void> {
    if (!api) return
    setBusy(true)
    setError(null)
    try {
      await api.post("/mailbox-keys/arm", undefined, { suppressGlobalError: true })
      await finish(account)
    } catch {
      setError(i18n.t("kernel.mailboxEncryption.setupCard.turnOnFailed"))
    } finally {
      setBusy(false)
    }
  }

  const loaded = () => accounts() !== null
  const showWaiting = () => loaded() && !doneHere() && waiting() !== null && hasKeys() !== null
  const showDone = () =>
    loaded() &&
    !props.makePrivate &&
    (doneHere() || (!props.quiet && waiting() === null && ready()))
  const showNotOwner = () =>
    loaded() && !props.quiet && !props.makePrivate && !doneHere() && waiting() === null && !ready()
  const showPrivate = () =>
    loaded() && props.makePrivate === true && (transparent() !== null || privateDone() !== null)

  return (
    <Show when={showWaiting() || showDone() || showNotOwner() || showPrivate()}>
      <div
        data-testid="mailbox-setup-card"
        class="my-2 max-w-md rounded-lg border border-border bg-elevated px-3 py-2 text-[13px]"
      >
        <div class="font-medium text-text-primary">
          {i18n.t(
            props.makePrivate
              ? "kernel.mailboxEncryption.setupCard.privateTitle"
              : "kernel.mailboxEncryption.setupCard.title",
          )}
        </div>
        <Show when={showPrivate()}>
          <Show
            when={privateDone()}
            fallback={
              <Show when={transparent()}>
                {(account) => (
                  <div class="mt-1" data-testid="mailbox-setup-card.private">
                    <p class="text-text-secondary">
                      {i18n.t("kernel.mailboxEncryption.setupCard.privateWhy", {
                        email: account().emailAddress,
                      })}
                    </p>
                    <Show
                      when={enrollForPrivate()}
                      fallback={
                        <Button
                          size="sm"
                          class="mt-2"
                          data-testid="mailbox-setup-card.make-private"
                          disabled={busy() || hasKeys() === null}
                          onClick={() => void makePrivate(account())}
                        >
                          {i18n.t("kernel.mailboxEncryption.setupCard.makePrivate")}
                        </Button>
                      }
                    >
                      <div class="mt-3">
                        <MailboxEnrollment
                          userId={me() ?? ""}
                          emailAddress={account().emailAddress}
                          onEnrolled={() => {
                            setEnrollForPrivate(false)
                            setHasKeys(true)
                            void makePrivate(account())
                          }}
                        />
                      </div>
                    </Show>
                    <Show when={error()}>
                      {(message) => (
                        <p class="mt-1 text-text-secondary" data-testid="mailbox-setup-card.error">
                          {message()}
                        </p>
                      )}
                    </Show>
                  </div>
                )}
              </Show>
            }
          >
            {(email) => (
              <p class="mt-1 text-text-secondary" data-testid="mailbox-setup-card.private-done">
                {i18n.t("kernel.mailboxEncryption.setupCard.privateDone", { email: email() })}
              </p>
            )}
          </Show>
        </Show>
        <Show when={showWaiting() ? waiting() : null}>
          {(account) => (
            <div class="mt-1" data-testid="mailbox-setup-card.waiting">
              <p class="text-text-secondary" data-testid="mailbox-setup-card.why">
                {i18n.t("kernel.mailboxEncryption.setupCard.waiting", {
                  email: account().emailAddress,
                })}
              </p>
              <Show
                when={hasKeys()}
                fallback={
                  <div class="mt-3">
                    <MailboxEnrollment
                      userId={me() ?? ""}
                      emailAddress={account().emailAddress}
                      onEnrolled={() => void finish(account())}
                    />
                  </div>
                }
              >
                <p class="mt-1 text-text-secondary" data-testid="mailbox-setup-card.has-password">
                  {i18n.t("kernel.mailboxEncryption.setupCard.hasPassword")}
                </p>
                <Button
                  size="sm"
                  class="mt-2"
                  data-testid="mailbox-setup-card.turn-on"
                  disabled={busy()}
                  onClick={() => void turnOn(account())}
                >
                  {i18n.t("kernel.mailboxEncryption.setupCard.turnOn")}
                </Button>
              </Show>
              <Show when={error()}>
                {(message) => (
                  <p class="mt-1 text-text-secondary" data-testid="mailbox-setup-card.error">
                    {message()}
                  </p>
                )}
              </Show>
            </div>
          )}
        </Show>
        <Show when={showDone()}>
          <p class="mt-1 text-text-secondary" data-testid="mailbox-setup-card.done">
            {i18n.t("kernel.mailboxEncryption.enrollment.done")}
          </p>
        </Show>
        <Show when={showNotOwner()}>
          <p class="mt-1 text-text-secondary" data-testid="mailbox-setup-card.owner-only">
            {i18n.t("kernel.mailboxEncryption.setupCard.ownerOnly")}
          </p>
        </Show>
      </div>
    </Show>
  )
}
