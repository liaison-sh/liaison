// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The enrollment wizard (spec section 5.1): the mailbox password, required,
// then an optional passkey for this device where passkeys can work here. It
// ends with the mailbox OPEN: the password just chosen unlocks the session
// before the wizard hands off, so nobody is asked for it again a second later.
//
// Ordering rule, load bearing: NO MAIL SYNC MAY START UNTIL THE MAILBOX KEYS
// EXIST. The OAuth handoff is the step after the POST, never before it, because
// a first fetch that landed before enrollment would write plaintext and the
// guarantee would already be broken.
//
// Three things that look optional and are not:
//   * The mailbox password is mandatory. It is the unlock method that works on
//     every computer, and it is the only one: there is no recovery phrase. A
//     user who forgets it resets the mailbox, which re-downloads from Gmail.
//     A user who abandons here has persisted nothing: the POST is the only
//     write and it happens at the very end.
//   * Any non-empty password is accepted, however weak: the user's choice
//     (see `passphrase-strength.ts` for what that costs).
//   * A passkey whose `prf.enabled` is not exactly true produces NO wrap row.
//     Its KEK could never be reproduced, and a broken row is worse than none.

import { signKeyringAttestation } from "@liaison/mailbox-crypto"
import {
  type AccountKeyWrap,
  generateAccountKey,
  generateIdentityKey,
  wrapWithPassphrase,
  zeroBytes,
} from "@liaison/mailbox-crypto/src/client"
import { type Component, createResource, createSignal, onMount, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { startMailboxCryptoWorker } from "~/modules/mailbox/crypto-worker-boot"
import { rememberDevicePasskey } from "~/modules/mailbox/device-state"
import { keyringPayloadFromEntry } from "~/modules/mailbox/keyring-payload"
import { saveWrappedKeyring } from "~/modules/mailbox/keyring-storage"
import {
  type EnrollWrapInput,
  enrollKeyring,
  fetchKeyring,
  type KeyringView,
} from "~/modules/mailbox/mailbox-api"
import { type Bytes, bytesToBase64 } from "~/modules/mailbox/mailbox-bytes"
import { wrapLabel } from "~/modules/mailbox/mailbox-copy"
import {
  loadMailboxKeyring,
  mailboxCryptoClient,
  mailboxOwnerEmail,
  unlockMailbox,
} from "~/modules/mailbox/mailbox-store"
import { passkeysUsableHere } from "~/modules/mailbox/passkey-availability"
import {
  buildPasskeyWrap,
  evaluatePrfSecret,
  registerPasskeyForPrf,
} from "~/modules/mailbox/passkey-ceremony"
import { checkPassphrase, type PassphraseVerdict } from "~/modules/mailbox/passphrase-strength"
import { useApi } from "~/modules/shell/ApiContext"
import { Button } from "~/ui/Button"

const FIRST_KEY_ID = 1

export interface MailboxEnrollmentProps {
  userId: string
  emailAddress: string
  /** Called after the keys exist, which is when the OAuth handoff may run. */
  onEnrolled?: () => void
  /** Test seam for the password check. Production uses `checkPassphrase`. */
  checkPassphraseFn?: (passphrase: string) => Promise<PassphraseVerdict>
}

type Step = "password" | "passkey" | "done"

function wrapInput(wrap: AccountKeyWrap, label: string): EnrollWrapInput {
  return {
    wrapType: wrap.wrapType,
    label,
    credentialId: wrap.kdfParams.credentialId ? bytesToBase64(wrap.kdfParams.credentialId) : null,
    wrappedAccountKey: bytesToBase64(wrap.wrappedAccountKey),
    kdfParams: {
      salt: bytesToBase64(wrap.kdfParams.salt),
      ...(wrap.kdfParams.credentialId
        ? { credentialId: bytesToBase64(wrap.kdfParams.credentialId) }
        : {}),
      ...(wrap.kdfParams.kdf ? { kdf: wrap.kdfParams.kdf } : {}),
      ...(wrap.kdfParams.iterations !== undefined ? { iterations: wrap.kdfParams.iterations } : {}),
    },
    verifier: null,
  }
}

export const MailboxEnrollment: Component<MailboxEnrollmentProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [step, setStep] = createSignal<Step>("password")
  const [busy, setBusy] = createSignal(false)
  const [passkeyNotice, setPasskeyNotice] = createSignal<string | null>(null)
  const [passphrase, setPassphrase] = createSignal("")
  const [confirmation, setConfirmation] = createSignal("")
  const [passphraseRefusal, setPassphraseRefusal] = createSignal<string | null>(null)
  const [enrollError, setEnrollError] = createSignal<string | null>(null)
  let passwordField: HTMLInputElement | undefined

  // Nothing here is persisted until the POST, so holding these in the closure
  // for the length of the wizard is the whole "abandon costs nothing" story.
  let accountKey: Bytes | null = null
  let identity: Awaited<ReturnType<typeof generateIdentityKey>> | null = null
  let passwordWrap: EnrollWrapInput | null = null
  // The password itself, until the mailbox is open: it unlocks the session at
  // the end, so setup does not end on a prompt for what was just typed.
  let chosenPassword: string | null = null

  const [existing] = createResource(async () => fetchKeyring(api))
  const settled = () => existing.state === "ready" || existing.state === "errored"
  const alreadyEnrolled = () =>
    !existing.error && (existing()?.identities ?? []).some((row) => row.status === "active")
  const [ownerEmail] = createResource(async () =>
    props.emailAddress ? props.emailAddress : await mailboxOwnerEmail(api),
  )
  const email = () => (ownerEmail.error ? "" : (ownerEmail() ?? ""))

  onMount(() => {
    queueMicrotask(() => passwordField?.focus())
  })

  /** The keys, made once per wizard. False, with the reason on screen, when this browser cannot. */
  async function ensureKeys(): Promise<boolean> {
    if (accountKey && identity) return true
    try {
      accountKey = generateAccountKey()
      identity = await generateIdentityKey({
        accountKey,
        userId: props.userId,
        keyId: FIRST_KEY_ID,
      })
      return true
    } catch (error) {
      // An engine without Ed25519 or X25519 (older WebKit): nothing can be set
      // up here, and a button that silently did nothing would say otherwise.
      console.error("[mailbox] this browser could not make the mailbox keys", error)
      if (accountKey) zeroBytes(accountKey)
      accountKey = null
      identity = null
      setPassphraseRefusal(i18n.t("kernel.mailboxEncryption.enrollment.setupUnsupported"))
      return false
    }
  }

  async function acceptPassword(): Promise<void> {
    if (busy()) return
    setBusy(true)
    setPassphraseRefusal(null)
    setEnrollError(null)
    try {
      if (passphrase() !== confirmation()) {
        setPassphraseRefusal(i18n.t("kernel.mailboxEncryption.passwordsMismatch"))
        return
      }
      const verdict = await (
        props.checkPassphraseFn ?? ((value: string) => checkPassphrase(value))
      )(passphrase())
      if (!verdict.ok) {
        setPassphraseRefusal(verdict.reasons.join(" "))
        return
      }
      if (!(await ensureKeys()) || !accountKey) return
      const wrap = await wrapWithPassphrase({
        accountKey,
        passphrase: passphrase(),
        salt: crypto.getRandomValues(new Uint8Array(16)) as Bytes,
        userId: props.userId,
      })
      passwordWrap = wrapInput(wrap, "Mailbox password")
      chosenPassword = passphrase()
      setPassphrase("")
      setConfirmation("")
      // The passkey offer only where a passkey can work: anywhere else it is
      // a system prompt that ends on an error.
      if (await passkeysUsableHere()) {
        setStep("passkey")
        return
      }
      await finish(null)
    } catch (error) {
      // A key derivation this runtime refuses must not leave a button that
      // silently does nothing.
      console.error("[mailbox] mailbox password step failed", error)
      setPassphraseRefusal(i18n.t("kernel.mailboxEncryption.enrollment.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  async function addPasskey(): Promise<void> {
    setBusy(true)
    setPasskeyNotice(null)
    try {
      const registration = await registerPasskeyForPrf({
        userId: props.userId,
        userName: email() || "Liaison mailbox",
      })
      if (registration.kind === "no-wrap-row") {
        // No row, on purpose.
        setPasskeyNotice(
          i18n.t("kernel.mailboxEncryption.enrollment.passkeyCannotOpen", {
            reason: registration.reason,
          }),
        )
        return
      }
      const salt = crypto.getRandomValues(new Uint8Array(32)) as Bytes
      const prfSecret = await evaluatePrfSecret({ credentialId: registration.credentialId, salt })
      if (!prfSecret || !accountKey) {
        setPasskeyNotice(i18n.t("kernel.mailboxEncryption.enrollment.passkeyNoSecret"))
        return
      }
      const proven = await buildPasskeyWrap({
        accountKey,
        prfSecret,
        userId: props.userId,
        credentialId: registration.credentialId,
        salt,
      })
      await finish(wrapInput(proven.wrap, "Passkey"))
    } catch (error) {
      console.error("[mailbox] the passkey step did not finish", error)
      setPasskeyNotice(i18n.t("kernel.mailboxEncryption.enrollment.passkeyIncomplete"))
    } finally {
      setBusy(false)
    }
  }

  /**
   * Open the mailbox with the password just chosen, which is also what
   * persists the session so the next page load opens it too. A failure here is
   * not a failed setup (the keys are saved): the mailbox then simply asks for
   * the password the first time it is read.
   */
  async function openAfterSetup(keyring: KeyringView | null): Promise<void> {
    const password = chosenPassword
    chosenPassword = null
    if (password === null) return
    try {
      const listed = keyring?.wraps?.length ? keyring : await fetchKeyring(api)
      const row = listed.wraps
        .filter((wrap) => wrap.type === "passphrase")
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
      if (!row) return
      if (!mailboxCryptoClient()) await startMailboxCryptoWorker()
      if (!mailboxCryptoClient()) return
      const opened = await unlockMailbox(api, { userId: props.userId, wrap: row, secret: password })
      if (opened) await loadMailboxKeyring(api, props.userId)
    } catch (error) {
      console.error("[mailbox] the mailbox did not open after setup", error)
    }
  }

  async function finish(passkeyWrap: EnrollWrapInput | null): Promise<void> {
    if (!accountKey || !identity || !passwordWrap || chosenPassword === null) {
      // Nothing was saved; the password step has to run again.
      setEnrollError(i18n.t("kernel.mailboxEncryption.enrollment.interrupted"))
      setStep("password")
      return
    }
    setBusy(true)
    setEnrollError(null)
    try {
      const attestation = await signKeyringAttestation({
        signPrivateKey: identity.privateKeys.signPrivate,
        userId: props.userId,
        identities: [
          {
            keyId: identity.entry.keyId,
            status: identity.entry.status,
            ecdhSpki: identity.entry.ecdhSpki,
            signSpki: identity.entry.signSpki,
          },
        ],
      })

      const payload = keyringPayloadFromEntry(identity.entry)
      const keyring = await enrollKeyring(api, {
        ecdhPublicKey: payload.ecdhSpki,
        signPublicKey: payload.signSpki,
        keyId: identity.entry.keyId,
        attestation: bytesToBase64(attestation),
        // Ciphertext under the Account Key, which never leaves this browser.
        // The server stores it so another computer, or this one after its site
        // data is cleared, can rebuild the keyring from the mailbox password.
        wrappedEcdhPrivate: payload.wrappedEcdhPrivate,
        wrappedSignPrivate: payload.wrappedSignPrivate,
        ecdhWrapIv: payload.ecdhWrapIv,
        signWrapIv: payload.signWrapIv,
        wraps: passkeyWrap ? [passwordWrap, passkeyWrap] : [passwordWrap],
      })
      // The device-local copy is now a cache, not the only copy.
      saveWrappedKeyring(props.userId, [payload])
      // The passkey just made on this computer is the one to offer first here.
      const passkeyRow = passkeyWrap
        ? (keyring?.wraps ?? []).find((wrap) => wrap.type === "passkey_prf")
        : undefined
      if (passkeyRow) rememberDevicePasskey(props.userId, passkeyRow.id)
      zeroBytes(accountKey)
      accountKey = null
      passwordWrap = null
      await openAfterSetup(keyring ?? null)
      setStep("done")
      props.onEnrolled?.()
    } catch (error) {
      console.error("[mailbox] the mailbox setup was not saved", error)
      setEnrollError(i18n.t("kernel.mailboxEncryption.enrollment.saveFailed"))
    } finally {
      setBusy(false)
    }
  }

  const inputClass = "w-full rounded border border-border bg-surface px-3 py-2 text-sm text-text"

  return (
    <div class="space-y-4" data-testid="mailbox-enrollment">
      <Show when={alreadyEnrolled()}>
        <div data-testid="mailbox-enrollment.existing-keyring" class="space-y-2">
          <p class="text-sm text-text-secondary">
            {i18n.t("kernel.mailboxEncryption.enrollment.existingKeyring")}
          </p>
          <p class="text-xs text-text-tertiary">
            {i18n.t("kernel.mailboxEncryption.enrollment.methodsOnFile", {
              methods: (existing()?.wraps ?? [])
                .map((wrap) => wrapLabel(wrap.type, i18n.t))
                .filter((label): label is string => label !== null)
                .join(", "),
            })}
          </p>
        </div>
      </Show>

      <Show when={settled() && !alreadyEnrolled() && step() === "password"}>
        <form
          class="space-y-3"
          data-testid="mailbox-enrollment.password-step"
          onSubmit={(event) => {
            event.preventDefault()
            void acceptPassword()
          }}
        >
          <h3 class="text-lg font-semibold text-text">
            {i18n.t("kernel.mailboxEncryption.enrollment.setupTitle")}
          </h3>
          <p
            class="text-sm text-text-secondary"
            data-testid="mailbox-enrollment.password-explainer"
          >
            {i18n.t("kernel.mailboxEncryption.enrollment.setupIntro")}
          </p>
          {/* What a password manager files the new password under. */}
          <input
            type="text"
            name="username"
            autocomplete="username"
            data-testid="mailbox-enrollment.username"
            value={`mailbox:${email() || props.userId}`}
            readOnly
            hidden
            tabIndex={-1}
            aria-hidden="true"
          />
          <label class="block text-xs text-text-secondary" for="mailbox-enrollment-password">
            {i18n.t("kernel.mailboxEncryption.unlock.passwordLabel")}
          </label>
          <input
            ref={(el) => {
              passwordField = el
            }}
            id="mailbox-enrollment-password"
            name="new-password"
            data-testid="mailbox-enrollment.passphrase"
            type="password"
            autocomplete="new-password"
            autofocus
            class={inputClass}
            value={passphrase()}
            onInput={(event) => setPassphrase(event.currentTarget.value)}
          />
          <label class="block text-xs text-text-secondary" for="mailbox-enrollment-password-again">
            {i18n.t("kernel.mailboxEncryption.unlock.passwordAgainLabel")}
          </label>
          <input
            id="mailbox-enrollment-password-again"
            name="new-password-again"
            data-testid="mailbox-enrollment.passphrase-confirm"
            type="password"
            autocomplete="new-password"
            class={inputClass}
            value={confirmation()}
            onInput={(event) => setConfirmation(event.currentTarget.value)}
          />
          <Show when={passphraseRefusal()}>
            {(refusal) => (
              <p class="text-xs text-red-500" data-testid="mailbox-enrollment.passphrase-refusal">
                {refusal()}
              </p>
            )}
          </Show>
          <Button
            fullWidth
            type="submit"
            data-testid="mailbox-enrollment.accept-passphrase"
            loading={busy()}
          >
            {i18n.t("kernel.mailboxEncryption.enrollment.acceptPassword")}
          </Button>
        </form>
      </Show>

      <Show when={step() === "passkey"}>
        <div class="space-y-3" data-testid="mailbox-enrollment.passkey-step">
          <p class="text-sm text-text-secondary">
            {i18n.t("kernel.mailboxEncryption.enrollment.passkeyOffer")}
          </p>
          <div class="flex flex-wrap gap-2">
            <Button
              data-testid="mailbox-enrollment.use-passkey"
              loading={busy()}
              onClick={() => void addPasskey()}
            >
              {i18n.t("kernel.mailboxEncryption.enrollment.addPasskey")}
            </Button>
            <Button
              variant="outline"
              data-testid="mailbox-enrollment.skip-passkey"
              disabled={busy()}
              onClick={() => void finish(null)}
            >
              {i18n.t("kernel.mailboxEncryption.enrollment.skipPasskey")}
            </Button>
          </div>
        </div>
      </Show>

      <Show when={passkeyNotice()}>
        {(notice) => (
          <p class="text-xs text-amber-600" data-testid="mailbox-enrollment.passkey-unavailable">
            {notice()}
          </p>
        )}
      </Show>

      <Show when={enrollError()}>
        {(error) => (
          <p class="text-xs text-red-500" data-testid="mailbox-enrollment.error">
            {error()}
          </p>
        )}
      </Show>

      <Show when={step() === "done"}>
        <p class="text-sm text-text-secondary" data-testid="mailbox-enrollment.done">
          {i18n.t("kernel.mailboxEncryption.enrollment.done")}
        </p>
      </Show>
    </div>
  )
}
