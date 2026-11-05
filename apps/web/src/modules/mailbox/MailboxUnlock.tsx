// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The unlock surface: this computer's passkey first when it has one that works
// here, otherwise the mailbox password, which works on every computer. And
// when the password is forgotten, the reset.
//
// There is no recovery phrase. A legacy keyring may still carry one, but it is
// never offered: a keyring with no mailbox password (enrolled with a passkey and
// a phrase) is unlocked with its passkey and then asked to set a password, so
// the user gains the method that works everywhere. A user who can unlock with
// nothing resets the mailbox: its mail is a copy of Gmail and downloads again.
//
// Wording rules (spec section 3.2, section 15 A15): a wrap that does not open
// is a refusal, never corruption. A PRF derived KEK that fails the unwrap means
// this device's PRF output does not match this wrap, which is a RUNTIME
// condition, so that case offers the mailbox password and never says corrupt
// or lost.

import {
  type Component,
  createEffect,
  createResource,
  createSignal,
  For,
  on,
  onCleanup,
  onMount,
  Show,
} from "solid-js"
import { ApiError } from "~/lib/api-error"
import { type Translate, useI18n } from "~/modules/i18n/i18n-context"
import type { MailboxUnlockSecretMethod } from "~/modules/mailbox/crypto-protocol"
import { startMailboxCryptoWorker } from "~/modules/mailbox/crypto-worker-boot"
import {
  declineDevicePasskey,
  devicePasskeyDeclined,
  devicePasskeyWrapId,
  forgetDevicePasskey,
  forgetMailboxDeviceState,
  rememberDevicePasskey,
} from "~/modules/mailbox/device-state"
import { MailboxEnrollment } from "~/modules/mailbox/MailboxEnrollment"
import {
  addWrap,
  requestMailboxResetCode,
  resetMailboxKeys,
  type WrapMetadataView,
} from "~/modules/mailbox/mailbox-api"
import { type Bytes, base64ToBytes, bytesToBase64 } from "~/modules/mailbox/mailbox-bytes"
import {
  mailboxPasswordExplainer,
  mailboxResetConsequences,
  passkeyShortcutCopy,
  wrapLabel,
} from "~/modules/mailbox/mailbox-copy"
import {
  loadMailboxKeyring,
  lockMailbox,
  mailboxCryptoClient,
  mailboxOwnerEmail,
  mailboxResetElsewhere,
  mailboxStore,
  unlockMailbox,
} from "~/modules/mailbox/mailbox-store"
import { passkeysUsableHere } from "~/modules/mailbox/passkey-availability"
import { evaluatePrfSecret, registerPasskeyForPrf } from "~/modules/mailbox/passkey-ceremony"
import { checkPassphrase, type PassphraseVerdict } from "~/modules/mailbox/passphrase-strength"
import { useApi } from "~/modules/shell/ApiContext"
import { shellTier } from "~/modules/shell/shell-tier"
import { Button } from "~/ui/Button"

export type MailboxUnlockView = "unlock" | "set-password" | "offer-passkey" | "reset-confirm"

export interface MailboxUnlockProps {
  userId: string
  onUnlocked?: () => void
  /** The screen to open on: the unlock (default), or straight on the reset. */
  initialView?: "unlock" | "reset"
  /** Told every time the screen changes, so a host can offer "Not now" only where it fits. */
  onViewChange?: (view: MailboxUnlockView) => void
  /** Test seam for the password check. Production uses `checkPassphrase`. */
  checkPassphraseFn?: (passphrase: string) => Promise<PassphraseVerdict>
}

type View = MailboxUnlockView

/** How long an unlock may run before the screen says it is still working. */
export const UNLOCK_SLOW_MS = 15_000
/**
 * A passkey prompt refused faster than this was not a person pressing Cancel:
 * the platform said no before anything was shown.
 */
const PASSKEY_INSTANT_REFUSAL_MS = 1_000

/**
 * Why an unlock attempt on THIS screen did not open the mailbox. Local to the
 * screen on purpose: the store's `lastErrorCode` is also written when a locked
 * message is merely rendered, so showing it would greet the user with a
 * refusal before they typed anything.
 */
type UnlockFailure =
  | "refused"
  | "reset-elsewhere"
  | "runtime-failed"
  | "device-prf-mismatch"
  | "password-format-unsupported"
  | "password-format-unsupported-no-passkey"
  | "worker-missing"
  | "rate-limited"
  | "network"
  | "passkey-cancelled"
  | "passkey-no-prf"
  | "passkey-unsupported"
  | "unexpected"

/** The catalog key that explains each failure to the user. */
const FAILURE_KEYS: Record<UnlockFailure, string> = {
  refused: "kernel.mailboxEncryption.unlock.failures.refused",
  "reset-elsewhere": "kernel.mailboxEncryption.unlock.failures.resetElsewhere",
  "runtime-failed": "kernel.mailboxEncryption.unlock.failures.runtimeFailed",
  "device-prf-mismatch": "kernel.mailboxEncryption.unlock.failures.devicePrfMismatch",
  "password-format-unsupported":
    "kernel.mailboxEncryption.unlock.failures.passwordFormatUnsupported",
  "password-format-unsupported-no-passkey":
    "kernel.mailboxEncryption.unlock.failures.passwordFormatUnsupportedNoPasskey",
  "worker-missing": "kernel.mailboxEncryption.unlock.failures.workerMissing",
  "rate-limited": "kernel.mailboxEncryption.unlock.failures.rateLimited",
  network: "kernel.mailboxEncryption.unlock.failures.network",
  "passkey-cancelled": "kernel.mailboxEncryption.unlock.failures.passkeyCancelled",
  "passkey-no-prf": "kernel.mailboxEncryption.unlock.failures.passkeyNoPrf",
  "passkey-unsupported": "kernel.mailboxEncryption.unlock.failures.passkeyUnsupported",
  unexpected: "kernel.mailboxEncryption.unlock.failures.unexpected",
}

function failureFromCode(code: string | null, passkeyOnFile: boolean): UnlockFailure {
  if (code === "MAILBOX_DEVICE_PRF_MISMATCH") return "device-prf-mismatch"
  if (code === "MAILBOX_PASSKEY_CEREMONY_FAILED") return "passkey-cancelled"
  // The keyring listing failed and this device holds no copy: a connection
  // problem, and typing the password again would not help.
  if (code === "MAILBOX_KEYRING_UNAVAILABLE") return "network"
  if (code === "MAILBOX_PASSWORD_FORMAT_UNSUPPORTED") {
    return passkeyOnFile ? "password-format-unsupported" : "password-format-unsupported-no-passkey"
  }
  if (code === "MAILBOX_LOCKED") return "worker-missing"
  if (code === "MAILBOX_RUNTIME_FAILED") return "runtime-failed"
  if (code === "MAILBOX_RESET_ELSEWHERE") return "reset-elsewhere"
  return "refused"
}

function classifyPasskeyError(error: unknown, elapsedMs: number): UnlockFailure {
  const name = (error as { name?: string } | null)?.name
  // NotAllowedError is also what a platform answers when it will not run the
  // ceremony at all. Refused before a person could have reacted, it was not
  // them cancelling.
  if (name === "NotAllowedError" && elapsedMs < PASSKEY_INSTANT_REFUSAL_MS) {
    return "passkey-unsupported"
  }
  if (name === "NotAllowedError" || name === "AbortError") return "passkey-cancelled"
  if (name === "NotSupportedError") return "passkey-no-prf"
  if (/no WebAuthn support/i.test(String((error as Error)?.message ?? ""))) {
    return "passkey-unsupported"
  }
  return "passkey-cancelled"
}

function classifyThrown(error: unknown, passkeyFailure: UnlockFailure | null): UnlockFailure {
  if (passkeyFailure) return passkeyFailure
  if (error instanceof ApiError) {
    if (error.status === 429) return "rate-limited"
    if (error.status === 0 || error.status >= 500) return "network"
    return "unexpected"
  }
  if (error instanceof TypeError) return "network"
  if (/crypto worker is not running/i.test(String((error as Error)?.message ?? ""))) {
    return "worker-missing"
  }
  return "unexpected"
}

/**
 * Why a reset did not happen. Each case asks for something different: a new
 * code, patience, or a connection.
 */
function resetFailureCopy(error: unknown, t: Translate): string {
  if (error instanceof ApiError) {
    if (error.status === 429) {
      return t("kernel.mailboxEncryption.unlock.resetFailures.rateLimited")
    }
    // A wrong code or password is a 422; a 401 is a dead session, handled
    // by the API client before it gets here.
    if (error.status === 422) {
      return t("kernel.mailboxEncryption.unlock.resetFailures.badCode")
    }
    if (error.status === 409) {
      return t("kernel.mailboxEncryption.unlock.resetFailures.nothingToReset")
    }
    if (error.status === 0 || error.status >= 500) {
      return t("kernel.mailboxEncryption.unlock.resetFailures.network")
    }
  }
  if (error instanceof TypeError) {
    return t("kernel.mailboxEncryption.unlock.resetFailures.network")
  }
  return t("kernel.mailboxEncryption.unlock.resetFailures.other")
}

/** Newest use first, then newest created: the passkey most likely to be this one. */
function byRecency(a: WrapMetadataView, b: WrapMetadataView): number {
  const at = Date.parse(a.lastUsedAt ?? a.createdAt)
  const bt = Date.parse(b.lastUsedAt ?? b.createdAt)
  return bt - at
}

export const MailboxUnlock: Component<MailboxUnlockProps> = (props) => {
  const api = useApi()
  const i18n = useI18n()
  const [secret, setSecret] = createSignal("")
  const [busy, setBusy] = createSignal(false)
  const [slow, setSlow] = createSignal(false)
  const [chosen, setChosen] = createSignal<MailboxUnlockSecretMethod | null>(null)
  const [view, setViewSignal] = createSignal<View>(
    props.initialView === "reset" ? "reset-confirm" : "unlock",
  )
  const [attemptError, setAttemptError] = createSignal<UnlockFailure | null>(null)
  const [notice, setNotice] = createSignal<string | null>(null)
  const [stepError, setStepError] = createSignal<string | null>(null)
  const [newPassword, setNewPassword] = createSignal("")
  const [newPasswordAgain, setNewPasswordAgain] = createSignal("")
  const [resetCode, setResetCode] = createSignal("")
  const [resetCodeSent, setResetCodeSent] = createSignal(false)
  let secretField: HTMLInputElement | undefined
  // True while THIS screen runs an unlock, so the store turning unlocked
  // mid-attempt is not mistaken for an unlock that happened elsewhere.
  let attempting = false

  function setView(next: View): void {
    setViewSignal(next)
    props.onViewChange?.(next)
  }
  onMount(() => props.onViewChange?.(view()))

  const [keyring, { refetch }] = createResource(async () => loadMailboxKeyring(api))
  // Refused (no mail access), not unreachable: retrying would not help.
  const keyringRefused = () => {
    const error = keyring.error as unknown
    return error instanceof ApiError && (error.status === 403 || error.status === 401)
  }
  const [usable] = createResource(async () => passkeysUsableHere())
  const [ownerEmail] = createResource(async () => mailboxOwnerEmail(api))
  const email = () => (ownerEmail.error ? "" : (ownerEmail() ?? ""))
  const passkeysHere = () => !usable.error && usable() === true
  // M2-2 T16. Unlocking is the one thing a locked mailbox lets a reader do, so
  // at phone width every control on this screen is a real touch target rather
  // than a chip sized for a mouse.
  const phone = () => shellTier() === "phone"

  const listing = () => (keyring.error ? undefined : keyring())
  const wraps = (): WrapMetadataView[] => listing()?.wraps ?? []
  /** The server answered, and no active identity is on file: there is nothing to unlock. */
  const needsSetup = () => {
    const current = listing()
    return !!current && !current.identities.some((row) => row.status === "active")
  }
  const passkeyWraps = () =>
    wraps()
      .filter((wrap) => wrap.type === "passkey_prf")
      .sort(byRecency)
  // Newest first: after the silent re-wrap of a legacy password row, a legacy
  // row whose delete failed can linger beside its replacement, and the
  // replacement is the one every build can open.
  const passwordWrap = () =>
    wraps()
      .filter((wrap) => wrap.type === "passphrase")
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))[0]
  const hasPassword = () => passwordWrap() !== undefined
  /**
   * Passkeys are offered to unlock only where one can work, or when nothing
   * else is on file (a keyring from before the mailbox password), where trying
   * costs nothing and the reset is the only other way.
   */
  const passkeyOffered = () => passkeyWraps().length > 0 && (passkeysHere() || !hasPassword())
  /** The passkey wrap that last unlocked on THIS computer, if it is still on file. */
  const devicePasskey = () => {
    const id = devicePasskeyWrapId(props.userId)
    return id && passkeyOffered() ? passkeyWraps().find((wrap) => wrap.id === id) : undefined
  }

  const method = (): MailboxUnlockSecretMethod => {
    const explicit = chosen()
    if (explicit) return explicit
    if (devicePasskey()) return "passkey_prf"
    if (hasPassword()) return "passphrase"
    return passkeyWraps().length > 0 ? "passkey_prf" : "passphrase"
  }

  const selectedWrap = (): WrapMetadataView | undefined =>
    method() === "passphrase" ? passwordWrap() : (devicePasskey() ?? passkeyWraps()[0])

  const methodsOffered = (): MailboxUnlockSecretMethod[] =>
    passkeyOffered() ? ["passkey_prf", "passphrase"] : ["passphrase"]

  /** After a password unlock, offer this device a passkey, unless it has one, said no, or cannot. */
  const willOfferPasskey = () =>
    method() === "passphrase" &&
    passkeysHere() &&
    !devicePasskey() &&
    !devicePasskeyDeclined(props.userId) &&
    typeof globalThis.navigator?.credentials?.create === "function"

  /** This device still caches the keyring from before a reset made elsewhere. */
  const resetElsewhere = () => mailboxResetElsewhere(props.userId, listing() ?? null)

  function done(): void {
    setNotice(null)
    // The Account Key bytes a minting session kept alive are zeroed now.
    void mailboxCryptoClient()?.endMinting()
    props.onUnlocked?.()
  }

  // An unlock that happened while this screen was up (the startup restore
  // finishing, another tab's unlock re-opening from this device): there is
  // nothing left to ask, so the screen gets out of the way.
  createEffect(
    on(
      () => mailboxStore.status,
      (status) => {
        if (status === "unlocked" && view() === "unlock" && !attempting && !needsSetup()) done()
      },
    ),
  )

  // The password field takes the focus whenever it is the thing to type.
  createEffect(() => {
    if (view() === "unlock" && method() === "passphrase" && hasPassword()) {
      queueMicrotask(() => secretField?.focus())
    }
  })

  let slowTimer: ReturnType<typeof setTimeout> | undefined
  onCleanup(() => clearTimeout(slowTimer))

  async function submit(): Promise<void> {
    const wrap = selectedWrap()
    if (!wrap || busy()) return
    setBusy(true)
    setSlow(false)
    clearTimeout(slowTimer)
    slowTimer = setTimeout(() => setSlow(true), UNLOCK_SLOW_MS)
    attempting = true
    setNotice(null)
    setAttemptError(null)
    // Keep the Account Key in the worker only when a new unlock method is about
    // to be added from this session; every other unlock zeroes it at once.
    const mintWraps = !hasPassword() || willOfferPasskey()
    // What went wrong on the passkey side, recorded where it happens: the store
    // folds every ceremony failure into one code, and the user needs to know
    // whether they cancelled, or this browser cannot do it at all.
    let passkeyFailure: UnlockFailure | null = null
    try {
      // The worker boots with the app; if it did not (or died), start it once
      // here rather than fail with nothing on screen.
      if (!mailboxCryptoClient()) await startMailboxCryptoWorker()
      if (!mailboxCryptoClient()) {
        setAttemptError("worker-missing")
        return
      }
      const ok = await unlockMailbox(api, {
        userId: props.userId,
        wrap,
        secret: secret(),
        mintWraps,
        resolveSecret:
          wrap.type === "passkey_prf"
            ? async (blob) => {
                const salt = blob.kdfParams?.salt
                const credentialId = blob.kdfParams?.credentialId
                if (!salt || !credentialId) {
                  passkeyFailure = "passkey-no-prf"
                  throw new Error("this passkey wrap is incomplete")
                }
                let prf: Bytes | null
                const asked = Date.now()
                try {
                  prf = await evaluatePrfSecret({
                    credentialId: base64ToBytes(credentialId),
                    salt: base64ToBytes(salt),
                  })
                } catch (error) {
                  passkeyFailure = classifyPasskeyError(error, Date.now() - asked)
                  throw error
                }
                if (!prf) {
                  passkeyFailure = "passkey-no-prf"
                  throw new Error("this authenticator returned no PRF output")
                }
                return bytesToBase64(prf)
              }
            : undefined,
      })
      setSecret("")
      if (!ok) {
        if (passkeyFailure) {
          setAttemptError(passkeyFailure)
          return
        }
        setAttemptError(failureFromCode(mailboxStore.lastErrorCode, passkeyWraps().length > 0))
        // A passkey that stopped working here is no longer offered first.
        if (
          wrap.type === "passkey_prf" &&
          mailboxStore.lastErrorCode === "MAILBOX_DEVICE_PRF_MISMATCH" &&
          devicePasskeyWrapId(props.userId) === wrap.id
        ) {
          forgetDevicePasskey(props.userId)
        }
        return
      }
      if (wrap.type === "passkey_prf") rememberDevicePasskey(props.userId, wrap.id)
      if (!hasPassword()) {
        setView("set-password")
        return
      }
      if (mintWraps) {
        setView("offer-passkey")
        return
      }
      done()
    } catch (error) {
      console.error("[mailbox] the unlock did not complete", error)
      setAttemptError(classifyThrown(error, passkeyFailure))
    } finally {
      attempting = false
      clearTimeout(slowTimer)
      setSlow(false)
      setBusy(false)
    }
  }

  async function setMailboxPassword(): Promise<void> {
    setStepError(null)
    const client = mailboxCryptoClient()
    if (!client) {
      setStepError(i18n.t("kernel.mailboxEncryption.unlock.failures.workerMissing"))
      return
    }
    setBusy(true)
    try {
      if (newPassword() !== newPasswordAgain()) {
        setStepError(i18n.t("kernel.mailboxEncryption.passwordsMismatch"))
        return
      }
      const verdict = await (
        props.checkPassphraseFn ?? ((value: string) => checkPassphrase(value))
      )(newPassword())
      if (!verdict.ok) {
        setStepError(verdict.reasons.join(" "))
        return
      }
      const minted = await client.mintWrap({ kind: "passphrase", passphrase: newPassword() })
      await addWrap(api, { ...minted, label: "Mailbox password" })
      setNewPassword("")
      setNewPasswordAgain("")
      void refetch()
      done()
    } catch (error) {
      console.error("[mailbox] the mailbox password was not saved", error)
      setStepError(i18n.t("kernel.mailboxEncryption.unlock.passwordNotSaved"))
    } finally {
      setBusy(false)
    }
  }

  async function addThisComputersPasskey(): Promise<void> {
    setStepError(null)
    const client = mailboxCryptoClient()
    if (!client) {
      setStepError(i18n.t("kernel.mailboxEncryption.unlock.failures.workerMissing"))
      return
    }
    setBusy(true)
    try {
      const registration = await registerPasskeyForPrf({
        userId: props.userId,
        userName: email() || "Liaison mailbox",
      })
      if (registration.kind === "no-wrap-row") {
        setStepError(
          i18n.t("kernel.mailboxEncryption.unlock.passkeyCannotOpen", {
            reason: registration.reason,
          }),
        )
        return
      }
      const salt = crypto.getRandomValues(new Uint8Array(32)) as Bytes
      const prf = await evaluatePrfSecret({ credentialId: registration.credentialId, salt })
      if (!prf) {
        setStepError(i18n.t("kernel.mailboxEncryption.unlock.passkeyNoSecret"))
        return
      }
      const minted = await client.mintWrap({
        kind: "passkey_prf",
        prfSecret: bytesToBase64(prf),
        credentialId: bytesToBase64(registration.credentialId),
        salt: bytesToBase64(salt),
      })
      const row = await addWrap(api, {
        ...minted,
        label: "Passkey",
        credentialId: minted.kdfParams.credentialId ?? null,
      })
      rememberDevicePasskey(props.userId, row.id)
      void refetch()
      done()
    } catch (error) {
      console.error("[mailbox] the passkey was not saved", error)
      setStepError(i18n.t("kernel.mailboxEncryption.unlock.passkeyNotSaved"))
    } finally {
      setBusy(false)
    }
  }

  async function sendResetCode(): Promise<void> {
    setBusy(true)
    setStepError(null)
    try {
      await requestMailboxResetCode(api)
      setResetCode("")
      setResetCodeSent(true)
    } catch (error) {
      setStepError(
        error instanceof ApiError && error.status === 429
          ? i18n.t("kernel.mailboxEncryption.unlock.codeRateLimited")
          : i18n.t("kernel.mailboxEncryption.unlock.codeNotSent"),
      )
    } finally {
      setBusy(false)
    }
  }

  async function confirmReset(): Promise<void> {
    setBusy(true)
    setStepError(null)
    try {
      await resetMailboxKeys(api, resetCode().trim())
    } catch (error) {
      setStepError(resetFailureCopy(error, i18n.t))
      setBusy(false)
      return
    }
    try {
      await lockMailbox()
      await forgetMailboxDeviceState(props.userId)
    } catch (error) {
      // The server side is reset; what is left on this device is a stale cache
      // the next unlock replaces. Setup carries on, it is not a failure.
      console.error("[mailbox] this device's old mailbox state was not cleared", error)
    } finally {
      setResetCode("")
      setResetCodeSent(false)
      setBusy(false)
    }
    // The keyring is gone, so the unlock screen shows the setup in its place.
    setAttemptError(null)
    setChosen(null)
    setView("unlock")
    try {
      await refetch()
    } catch {
      // The listing error renders on the unlock screen with its own retry.
    }
  }

  async function afterSetup(): Promise<void> {
    // Setup opens the mailbox with the password just chosen. When it did,
    // there is nothing left to ask.
    if (mailboxStore.status === "unlocked") {
      done()
      return
    }
    try {
      await refetch()
    } catch {
      // Rendered by the listing error below.
    }
    setChosen("passphrase")
    setNotice(i18n.t("kernel.mailboxEncryption.unlock.resetDone"))
  }

  const chipClass = () =>
    phone()
      ? "flex min-h-11 items-center rounded-full border border-border px-4 text-[15px] text-text-secondary aria-pressed:bg-surface-active aria-pressed:text-text"
      : "rounded-full border border-border px-3 py-1 text-xs text-text-secondary aria-pressed:bg-surface-active aria-pressed:text-text"
  const inputClass = () =>
    `w-full rounded border border-border bg-surface px-3 text-text ${
      phone() ? "min-h-11 py-2.5 text-[16px]" : "py-2 text-sm"
    }`
  const usernameValue = () => `mailbox:${email() || props.userId}`
  const startReset = () => {
    setStepError(null)
    setView("reset-confirm")
  }

  return (
    <div class="space-y-4" data-testid="mailbox-unlock">
      <Show when={view() === "unlock" && needsSetup()}>
        <div data-testid="mailbox-unlock.setup">
          <MailboxEnrollment
            userId={props.userId}
            emailAddress={email()}
            checkPassphraseFn={props.checkPassphraseFn}
            onEnrolled={() => void afterSetup()}
          />
        </div>
      </Show>

      <Show when={view() === "unlock" && keyringRefused()}>
        <p class="text-xs text-text-secondary" data-testid="mailbox-unlock.no-access">
          {i18n.t("kernel.mailboxEncryption.unlock.noAccess")}
        </p>
      </Show>

      <Show when={view() === "unlock" && keyring.error && !keyringRefused()}>
        <div class="space-y-2" data-testid="mailbox-unlock.keyring-error">
          <p class="text-xs text-red-500">
            {i18n.t("kernel.mailboxEncryption.unlock.failures.network")}
          </p>
          <Button size="sm" variant="outline" onClick={() => void refetch()}>
            {i18n.t("kernel.mailboxEncryption.unlock.submit")}
          </Button>
        </div>
      </Show>

      <Show when={view() === "unlock" && !needsSetup() && !keyring.error}>
        <form
          class="space-y-4"
          data-testid="mailbox-unlock.form"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <div>
            <h3 class="text-lg font-semibold text-text">
              {i18n.t("kernel.mailboxEncryption.unlock.title")}
            </h3>
            <p class="text-sm text-text-secondary">
              {i18n.t("kernel.mailboxEncryption.unlock.intro")}
            </p>
          </div>

          <Show when={resetElsewhere() && !attemptError()}>
            <p class="text-xs text-text-secondary" data-testid="mailbox-unlock.reset-elsewhere">
              {i18n.t("kernel.mailboxEncryption.unlock.failures.resetElsewhere")}
            </p>
          </Show>

          <Show when={notice()}>
            {(text) => (
              <p class="text-xs text-text-secondary" data-testid="mailbox-unlock.notice">
                {text()}
              </p>
            )}
          </Show>

          <div class="flex flex-wrap gap-2">
            <For each={methodsOffered()}>
              {(offered) => (
                <button
                  type="button"
                  data-testid={`mailbox-unlock.method-${offered}`}
                  aria-pressed={method() === offered}
                  class={chipClass()}
                  onClick={() => {
                    setChosen(offered)
                    setSecret("")
                  }}
                >
                  {wrapLabel(offered, i18n.t)}
                </button>
              )}
            </For>
          </div>

          <Show when={method() === "passphrase" && hasPassword()}>
            {/* What a password manager files the mailbox password under. */}
            <input
              type="text"
              name="username"
              autocomplete="username"
              data-testid="mailbox-unlock.username"
              value={usernameValue()}
              readOnly
              hidden
              tabIndex={-1}
              aria-hidden="true"
            />
            <label class="block text-xs text-text-secondary" for="mailbox-unlock-secret">
              {i18n.t("kernel.mailboxEncryption.unlock.secretLabel")}
            </label>
            <input
              ref={(el) => {
                secretField = el
              }}
              id="mailbox-unlock-secret"
              name="password"
              data-testid="mailbox-unlock.secret"
              type="password"
              autocomplete="current-password"
              autofocus
              class={inputClass()}
              value={secret()}
              onInput={(event) => setSecret(event.currentTarget.value)}
            />
          </Show>

          <Show when={listing() && !selectedWrap()}>
            <p class="text-xs text-text-tertiary" data-testid="mailbox-unlock.method-unavailable">
              <Show
                when={method() === "passphrase" && passkeyWraps().length > 0}
                fallback={<>{i18n.t("kernel.mailboxEncryption.unlock.nothingOnFile")}</>}
              >
                {i18n.t("kernel.mailboxEncryption.unlock.noPasswordYet")}
              </Show>
            </p>
          </Show>

          <Show when={attemptError()}>
            {(failure) => (
              <p
                class="text-xs text-red-500"
                data-testid="mailbox-unlock.refusal"
                data-failure={failure()}
              >
                {i18n.t(FAILURE_KEYS[failure()])}
              </p>
            )}
          </Show>

          <Show when={slow()}>
            <p class="text-xs text-text-tertiary" data-testid="mailbox-unlock.still-working">
              {i18n.t("kernel.mailboxEncryption.unlock.stillWorking")}
            </p>
          </Show>

          <div class="flex flex-wrap items-center gap-2">
            <Button
              type="submit"
              data-testid="mailbox-unlock.submit"
              size={phone() ? "lg" : "sm"}
              class={phone() ? "w-full" : undefined}
              loading={busy()}
              disabled={!selectedWrap()}
            >
              {i18n.t("kernel.mailboxEncryption.unlock.submit")}
            </Button>
            <Show when={attemptError() === "refused"}>
              <Button
                type="button"
                variant="outline"
                data-testid="mailbox-unlock.reset-offer"
                size={phone() ? "lg" : "sm"}
                class={phone() ? "w-full" : undefined}
                disabled={busy()}
                onClick={startReset}
              >
                {i18n.t("kernel.mailboxEncryption.unlock.forgotReset")}
              </Button>
            </Show>
          </div>

          {/* After a wrong password the reset is the button above: one way to it, not two. */}
          <Show when={attemptError() !== "refused"}>
            <button
              type="button"
              data-testid="mailbox-unlock.reset"
              class="block text-xs text-accent hover:underline"
              onClick={startReset}
            >
              {i18n.t("kernel.mailboxEncryption.unlock.forgotPassword")}
            </button>
          </Show>
        </form>
      </Show>

      <Show when={view() === "set-password"}>
        <form
          class="space-y-3"
          data-testid="mailbox-unlock.set-password"
          onSubmit={(event) => {
            event.preventDefault()
            void setMailboxPassword()
          }}
        >
          <h3 class="text-lg font-semibold text-text">
            {i18n.t("kernel.mailboxEncryption.unlock.setPasswordTitle")}
          </h3>
          <p class="text-sm text-text-secondary">
            {mailboxPasswordExplainer(i18n.t)}{" "}
            {i18n.t("kernel.mailboxEncryption.unlock.noPasswordNote")}
          </p>
          <input
            type="text"
            name="username"
            autocomplete="username"
            value={usernameValue()}
            readOnly
            hidden
            tabIndex={-1}
            aria-hidden="true"
          />
          <input
            data-testid="mailbox-unlock.new-password"
            type="password"
            name="new-password"
            autocomplete="new-password"
            autofocus
            aria-label={i18n.t("kernel.mailboxEncryption.unlock.passwordLabel")}
            class={inputClass()}
            value={newPassword()}
            onInput={(event) => setNewPassword(event.currentTarget.value)}
          />
          <input
            data-testid="mailbox-unlock.new-password-again"
            type="password"
            name="new-password-again"
            autocomplete="new-password"
            aria-label={i18n.t("kernel.mailboxEncryption.unlock.passwordAgainLabel")}
            class={inputClass()}
            value={newPasswordAgain()}
            onInput={(event) => setNewPasswordAgain(event.currentTarget.value)}
          />
          <div class="flex flex-wrap gap-2">
            <Button type="submit" data-testid="mailbox-unlock.save-password" loading={busy()}>
              {i18n.t("kernel.mailboxEncryption.unlock.savePassword")}
            </Button>
            <Button
              type="button"
              variant="outline"
              data-testid="mailbox-unlock.later"
              disabled={busy()}
              onClick={() => done()}
            >
              {i18n.t("kernel.mailboxEncryption.unlock.notNow")}
            </Button>
          </div>
        </form>
      </Show>

      <Show when={view() === "offer-passkey"}>
        <div class="space-y-3" data-testid="mailbox-unlock.offer-passkey">
          <h3 class="text-lg font-semibold text-text">
            {i18n.t("kernel.mailboxEncryption.unlock.offerPasskeyTitle")}
          </h3>
          <p class="text-sm text-text-secondary">{passkeyShortcutCopy(i18n.t)}</p>
          <div class="flex flex-wrap gap-2">
            <Button
              data-testid="mailbox-unlock.add-passkey"
              loading={busy()}
              onClick={() => void addThisComputersPasskey()}
            >
              {i18n.t("kernel.mailboxEncryption.unlock.addPasskey")}
            </Button>
            <Button
              variant="outline"
              data-testid="mailbox-unlock.decline-passkey"
              disabled={busy()}
              onClick={() => {
                declineDevicePasskey(props.userId)
                done()
              }}
            >
              {i18n.t("kernel.mailboxEncryption.unlock.notNow")}
            </Button>
          </div>
        </div>
      </Show>

      <Show when={view() === "reset-confirm"}>
        <div class="space-y-3" data-testid="mailbox-unlock.reset-confirm">
          <h3 class="text-lg font-semibold text-text">
            {i18n.t("kernel.mailboxEncryption.unlock.resetTitle")}
          </h3>
          <ul
            class="list-disc space-y-1 pl-5 text-sm text-text-secondary"
            data-testid="mailbox-unlock.reset-consequences"
          >
            <For each={mailboxResetConsequences(i18n.t)}>{(line) => <li>{line}</li>}</For>
          </ul>
          <p class="text-xs text-text-tertiary">
            {i18n.t("kernel.mailboxEncryption.unlock.resetGmailNote")}
          </p>
          <Show
            when={resetCodeSent()}
            fallback={
              <Button
                fullWidth
                data-testid="mailbox-unlock.reset-send-code"
                loading={busy()}
                onClick={() => void sendResetCode()}
              >
                {i18n.t("kernel.mailboxEncryption.unlock.emailCode")}
              </Button>
            }
          >
            <form
              class="space-y-3"
              onSubmit={(event) => {
                event.preventDefault()
                if (/^\d{6}$/.test(resetCode().trim())) void confirmReset()
              }}
            >
              <p class="text-sm text-text-secondary" data-testid="mailbox-unlock.reset-code-sent">
                <Show
                  when={email()}
                  fallback={<>{i18n.t("kernel.mailboxEncryption.unlock.resetCodeSent")}</>}
                >
                  {(address) =>
                    i18n.t("kernel.mailboxEncryption.unlock.resetCodeSentTo", { email: address() })
                  }
                </Show>
              </p>
              <input
                data-testid="mailbox-unlock.reset-code"
                inputmode="numeric"
                autocomplete="one-time-code"
                autofocus
                maxLength={6}
                aria-label={i18n.t("kernel.mailboxEncryption.unlock.resetCodeLabel")}
                class={inputClass()}
                value={resetCode()}
                onInput={(event) => setResetCode(event.currentTarget.value)}
              />
              <Button
                fullWidth
                type="submit"
                data-testid="mailbox-unlock.reset-confirm-button"
                variant="danger"
                loading={busy()}
                disabled={!/^\d{6}$/.test(resetCode().trim())}
              >
                {i18n.t("kernel.mailboxEncryption.unlock.resetConfirm")}
              </Button>
              <button
                type="button"
                data-testid="mailbox-unlock.reset-resend"
                class="block text-xs text-accent hover:underline"
                disabled={busy()}
                onClick={() => void sendResetCode()}
              >
                {i18n.t("kernel.mailboxEncryption.unlock.resendCode")}
              </button>
            </form>
          </Show>
          <button
            type="button"
            data-testid="mailbox-unlock.reset-cancel"
            class="block text-xs text-text-tertiary hover:underline"
            onClick={() => {
              setResetCode("")
              setResetCodeSent(false)
              setStepError(null)
              setView("unlock")
              // Asked for from an open mailbox: keeping it means nothing to unlock.
              if (mailboxStore.status === "unlocked") done()
            }}
          >
            {i18n.t("kernel.mailboxEncryption.unlock.keepMailbox")}
          </button>
        </div>
      </Show>

      <Show when={stepError()}>
        {(error) => (
          <p class="text-xs text-red-500" data-testid="mailbox-unlock.step-error">
            {error()}
          </p>
        )}
      </Show>
    </div>
  )
}
