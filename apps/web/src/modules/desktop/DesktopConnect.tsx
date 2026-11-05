// SPDX-License-Identifier: FSL-1.1-ALv2
//
// P6d-T15, step one: WHICH LIAISON IS THIS.
//
// The overlay drew this as a panel over the page, in its own type scale, with
// the device grant sometimes drawn full screen behind it. It is the login
// card's first step now: same card, same `Input`, same `Button`, same error
// line, because "tell me where your account is" and "tell me who you are" are
// two steps of one question.
//
// A DEEP LINKED ADDRESS IS SHOWN, NEVER SILENTLY SAVED (FX1). The operating
// system hands this app a `liaison://connect` link on behalf of whatever page
// asked for it, so the address it names prefills the field and is applied by
// the user's own click.
//
// A REFUSAL IS ABOUT ONE ADDRESS. The red line clears at the next keystroke,
// because the address it refused is not the one being typed now: the walk
// caught the stale refusal sitting under a perfectly good address.
//
// The shell validates the scheme again on its side and persists it; this side
// only asks. On success the page reloads once, which is how the app picks up
// the new server (FX8).

import { normalizeServerAddress } from "@liaison/shared"
import { type Component, createSignal, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Button } from "~/ui/Button"
import { Input } from "~/ui/Input"
import { desktopState, isDesktop, platform, setServerAddress } from "./desktop-store"

/**
 * NORMATIVE, spec.md's "User-facing copy" table. Do not paraphrase. Catalog
 * keys: the English in kernel.json is the table's text, byte for byte.
 */
export const CONNECT_PROMPT = "kernel.desktopUi.connect.prompt"
export const CONNECT_HELPER = "kernel.desktopUi.connect.helper"
export const CONNECT_ACTION = "kernel.desktopUi.connect.action"
export const CONNECT_INVALID_ADDRESS = "kernel.desktopUi.connect.invalidAddress"
/** Asked before a `liaison://connect` link is applied. */
export const DEEP_LINK_CONFIRM_PROMPT = "kernel.desktopUi.connect.deepLinkConfirm"

/** The field's own label. */
export const SERVER_ADDRESS_LABEL = "kernel.desktopUi.connect.serverAddress"

/** The step "Add a server..." opens. */
export const ADD_SERVER_PROMPT = "kernel.servers.addPrompt"
/** Why an address was refused, when the shell could say more than "invalid". */
export const NOT_A_LIAISON_SERVER = "kernel.servers.notLiaison"
export const SERVER_UNREACHABLE = "kernel.servers.unreachable"
export const CONNECT_CANCEL = "kernel.servers.cancel"

/** The refusal line under the field, by the shell's own reason code. */
export function refusalKey(error: unknown): string {
  const code = error instanceof Error ? error.message : String(error)
  if (code === "NotALiaisonServer") return NOT_A_LIAISON_SERVER
  if (code === "ServerUnreachable") return SERVER_UNREACHABLE
  return CONNECT_INVALID_ADDRESS
}

/** NORMATIVE, moved with the notice it belongs to. */
export const WINDOWS_SHELL_NOTICE_BODY = "kernel.desktopUi.connect.windowsShellNotice"
export const WINDOWS_SHELL_NOTICE_DISMISS = "kernel.desktopUi.connect.windowsShellNoticeDismiss"

/** Set once the user has dismissed the note, on this machine. */
export const WINDOWS_SHELL_NOTICE_KEY = "liaison-desktop:windows-shell-notice"

/** An http(s) URL, the only thing the shell will store (`sidecar.rs`). */
export function isValidServerAddress(value: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(value.trim())
  } catch {
    return false
  }
  return parsed.protocol === "http:" || parsed.protocol === "https:"
}

// A bare domain is read as https: the one rule shared with the phone.
export { normalizeServerAddress }

function noteDismissed(): boolean {
  try {
    return localStorage.getItem(WINDOWS_SHELL_NOTICE_KEY) === "dismissed"
  } catch {
    // A window that refuses storage shows the note again, which is the safe
    // direction: repeating a true sentence costs less than never saying it.
    return false
  }
}

export interface DesktopConnectProps {
  /**
   * Closes the step with nothing applied. Given when the step was OPENED
   * ("Add a server...", a connect link over a signed in
   * window): the first run's step has nowhere to go back to.
   */
  onCancel?: () => void
}

const DesktopConnect: Component<DesktopConnectProps> = (props) => {
  const i18n = useI18n()
  const deepLinked = () => desktopState().deepLinkAddress ?? ""
  const adding = () => desktopState().addingServer === true
  const [typed, setTyped] = createSignal<string | null>(null)
  /** The catalogue key of the refusal on screen, or null. */
  const [refusal, setRefusal] = createSignal<string | null>(null)
  const invalid = () => refusal() !== null
  const setInvalid = (value: boolean) => setRefusal(value ? CONNECT_INVALID_ADDRESS : null)
  const [busy, setBusy] = createSignal(false)
  const [noteHidden, setNoteHidden] = createSignal(noteDismissed())

  /** What the field holds: what was typed, else whatever the link proposed. */
  const value = () => typed() ?? deepLinked()
  const showNote = () => platform() === "windows" && !noteHidden()

  async function connect(event?: Event) {
    event?.preventDefault()
    if (busy()) return
    const candidate = normalizeServerAddress(value())
    if (!isValidServerAddress(candidate)) {
      setInvalid(true)
      return
    }
    setInvalid(false)
    setBusy(true)
    try {
      await setServerAddress(candidate)
      // The app reads its server at load, so the new one takes effect on the
      // next load and not before (FX8). A window with no reload (a test, a
      // headless render) simply stays where it is.
      try {
        globalThis.location?.reload?.()
      } catch {
        // Nothing to do: the address is stored either way.
      }
    } catch (error) {
      // The shell refused it. An address that did not answer, or answered as
      // something that is not a Liaison, says so; any other refusal reads as a
      // malformed address, because from here it is the same fact.
      setRefusal(refusalKey(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Show when={isDesktop()}>
      <form class="flex flex-col gap-4" onSubmit={(event) => void connect(event)}>
        <p class="text-center text-[13px] text-text-secondary">
          <Show
            when={deepLinked() && typed() === null}
            fallback={i18n.t(adding() ? ADD_SERVER_PROMPT : CONNECT_PROMPT)}
          >
            {i18n.t(DEEP_LINK_CONFIRM_PROMPT)}
          </Show>
        </p>
        <Input
          data-testid="desktop-connect-address"
          label={i18n.t(SERVER_ADDRESS_LABEL)}
          placeholder="liaison.example.com"
          value={value()}
          onInput={(event) => {
            setTyped(event.currentTarget.value)
            // The refusal stopped being true at this keystroke.
            setInvalid(false)
          }}
          autocomplete="url"
        />
        <Show when={invalid()}>
          <p role="alert" class="text-xs text-error">
            {i18n.t(refusal() ?? CONNECT_INVALID_ADDRESS)}
          </p>
        </Show>
        <Button fullWidth type="submit" loading={busy()}>
          {i18n.t(CONNECT_ACTION)}
        </Button>
        <Show when={props.onCancel}>
          {(cancel) => (
            <Button fullWidth type="button" variant="outline" onClick={() => cancel()()}>
              {i18n.t(CONNECT_CANCEL)}
            </Button>
          )}
        </Show>
        <p class="text-center text-[12.5px] text-text-tertiary">{i18n.t(CONNECT_HELPER)}</p>
        <Show when={showNote()}>
          <div data-testid="windows-shell-note" class="flex flex-col items-center gap-1">
            <p class="text-center text-[12px] text-text-tertiary">
              {i18n.t(WINDOWS_SHELL_NOTICE_BODY)}
            </p>
            <button
              type="button"
              class="text-[12px] text-accent-muted transition-colors duration-150 hover:text-accent"
              onClick={() => {
                try {
                  localStorage.setItem(WINDOWS_SHELL_NOTICE_KEY, "dismissed")
                } catch {
                  // The note simply comes back next launch.
                }
                setNoteHidden(true)
              }}
            >
              {i18n.t(WINDOWS_SHELL_NOTICE_DISMISS)}
            </button>
          </div>
        </Show>
      </form>
    </Show>
  )
}

export default DesktopConnect
