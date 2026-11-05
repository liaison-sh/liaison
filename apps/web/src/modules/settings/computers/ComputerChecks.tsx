// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THIS COMPUTER'S CHECKS, drawn twice: the setup card at the top of Settings >
// Computers while this computer is not set up (three lines, each with its
// fix, then Turn on), and "Ready to work" on its Settings tab (each check, a
// fix or Turn off, and whether the OS lets Liaison read the places it looks
// in). The state and the flows are this-computer.ts's.

import { type Component, For, type JSX, Show } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { type ChecklistItem, checklistComplete, type ItemState } from "~/modules/nodes/node-setup"
import { sectionHeading } from "~/modules/settings/notification-settings/styles"
import { Button } from "~/ui/Button"
import { osKey, placesLabel } from "./computer-model"
import type { ThisComputer } from "./this-computer"

const target = "min-h-[44px] sm:min-h-0"

/** A check's mark: done, to do, or not known yet. */
const Mark: Component<{ state: ItemState | "warn" }> = (props) => (
  <span
    aria-hidden="true"
    class="mt-px flex size-5 shrink-0 items-center justify-center rounded-full border text-[11px] font-semibold"
    classList={{
      "border-accent bg-accent text-accent-foreground": props.state === "done",
      "border-warning text-warning": props.state === "warn",
      "border-border text-text-tertiary": props.state !== "done" && props.state !== "warn",
    }}
  >
    {props.state === "done" ? "✓" : props.state === "warn" ? "!" : ""}
  </span>
)

const Row: Component<{
  testId: string
  state: ItemState | "warn"
  title: string
  hint?: string | null
  note?: JSX.Element
  action?: JSX.Element
}> = (props) => (
  <li
    data-testid={props.testId}
    data-state={props.state}
    class="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6"
  >
    <div class="flex min-w-0 flex-1 items-start gap-3">
      <Mark state={props.state} />
      <div class="min-w-0">
        <p class="text-[13px] text-text">
          <span class="font-medium">{props.title}</span>
          <Show when={props.hint}>
            <span class="text-text-secondary"> · {props.hint}</span>
          </Show>
        </p>
        {props.note}
      </div>
    </div>
    <Show when={props.action}>
      <div class="flex shrink-0 items-center gap-3 pl-8 sm:pl-0">{props.action}</div>
    </Show>
  </li>
)

/** The combined "open at login, stay awake" line of the setup card. */
function startupState(items: Record<ChecklistItem, ItemState>): ItemState {
  const login = items.launchAtLogin
  const awake = items.keepAwake
  if (login === "checking" || awake === "checking") return "checking"
  return login === "done" && (awake === "done" || awake === "unsupported") ? "done" : "todo"
}

/** The setup card: shown while this computer is not set up yet (desktop only). */
export const SetupCard: Component<{ tc: ThisComputer }> = (props) => {
  const i18n = useI18n()
  const items = () => props.tc.state().items
  const phase = () => props.tc.state().phase
  const busy = () => props.tc.busy() !== null

  async function fixStartup(): Promise<void> {
    if (items().launchAtLogin !== "done") await props.tc.fix("launchAtLogin")
    if (items().keepAwake === "todo") await props.tc.fix("keepAwake")
  }

  const fixButton = (id: string, run: () => void, disabled = false) => (
    <Button
      variant="outline"
      class={`w-auto shrink-0 ${target}`}
      data-testid={`computer-fix-${id}`}
      disabled={busy() || disabled}
      onClick={run}
    >
      {i18n.t(`kernel.computers.setup.fix.${id}`)}
    </Button>
  )

  const doneLabel = (state: ItemState) => (
    <span
      class="text-[12.5px] font-medium"
      classList={{
        "text-accent": state === "done",
        "text-text-tertiary": state !== "done",
      }}
    >
      {i18n.t(`kernel.computers.setup.state.${state}`)}
    </span>
  )

  return (
    <section
      data-testid="computer-setup"
      data-phase={phase()}
      class="mb-8 rounded-lg border border-border bg-surface px-4 py-4 sm:px-5"
    >
      <div class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-6">
        <div class="min-w-0">
          <h2 class="text-[15px] font-medium text-text">
            {i18n.t("kernel.computers.setup.title")}
          </h2>
          <p class="mt-1 max-w-[60ch] text-[13px] leading-relaxed text-text-secondary">
            {i18n.t("kernel.computers.setup.body")}
          </p>
        </div>
        <Button
          class={`w-full shrink-0 sm:w-auto ${target}`}
          data-testid="computer-turn-on"
          loading={phase() === "registering" || phase() === "checking"}
          disabled={!checklistComplete(items()) || phase() === "loading"}
          onClick={() => void props.tc.toggle(true)}
        >
          {i18n.t("kernel.computers.setup.turnOn")}
        </Button>
      </div>
      <ul class="mt-3 flex flex-col divide-y divide-border-subtle border-t border-border-subtle">
        <Row
          testId="computer-check-claude"
          state={items().claude}
          title={i18n.t("kernel.computers.setup.check.claude")}
          hint={i18n.t("kernel.computers.setup.check.claudeHint")}
          action={
            items().claude === "todo"
              ? fixButton("claude", () => void props.tc.fix("claude"), props.tc.claudePending())
              : doneLabel(items().claude)
          }
        />
        <Row
          testId="computer-check-notifications"
          state={items().notifications}
          title={i18n.t("kernel.computers.setup.check.notifications")}
          hint={i18n.t("kernel.computers.setup.check.notificationsHint")}
          note={
            <Show when={items().notifications === "todo" && props.tc.notificationsRefused()}>
              <p
                data-testid="computer-notifications-refused"
                class="mt-1 text-[12px] leading-relaxed text-warning"
              >
                {i18n.t("kernel.computers.setup.notificationsDenied")}
              </p>
            </Show>
          }
          action={
            items().notifications === "todo"
              ? fixButton("notifications", () => void props.tc.fix("notifications"))
              : doneLabel(items().notifications)
          }
        />
        <Row
          testId="computer-check-startup"
          state={startupState(items())}
          title={i18n.t("kernel.computers.setup.check.startup")}
          hint={i18n.t("kernel.computers.setup.check.startupHint")}
          action={
            startupState(items()) === "todo"
              ? fixButton("startup", () => void fixStartup())
              : doneLabel(startupState(items()))
          }
        />
      </ul>
      <Show when={phase() === "error"}>
        <p data-testid="computer-setup-error" class="mt-3 text-[12.5px] font-medium text-warning">
          {i18n.t("kernel.computers.setup.error")}
        </p>
      </Show>
    </section>
  )
}

/** "Ready to work" on this computer's Settings tab. */
export const ReadyChecks: Component<{
  tc: ThisComputer
  os: string | null
  /** Places the OS does not let Liaison read (`~/Documents`), from the folder list. */
  denied: readonly string[]
}> = (props) => {
  const i18n = useI18n()
  const items = () => props.tc.state().items
  const busy = () => props.tc.busy() !== null

  const action = (item: ChecklistItem) => {
    const state = items()[item]
    if (state === "todo") {
      return (
        <Button
          variant="outline"
          class={`w-auto shrink-0 ${target}`}
          data-testid={`computer-ready-fix-${item}`}
          disabled={busy() || (item === "claude" && props.tc.claudePending())}
          onClick={() => void props.tc.fix(item)}
        >
          {i18n.t(`kernel.computers.ready.fix.${item}`)}
        </Button>
      )
    }
    if (state === "done" && (item === "launchAtLogin" || item === "keepAwake")) {
      return (
        <Button
          variant="outline"
          class={`w-auto shrink-0 ${target}`}
          data-testid={`computer-ready-off-${item}`}
          disabled={busy()}
          onClick={() => void props.tc.undo(item)}
        >
          {i18n.t("kernel.computers.ready.turnOff")}
        </Button>
      )
    }
    return undefined
  }

  const hint = (item: ChecklistItem): string | null => {
    const state = items()[item]
    if (state === "unsupported") return i18n.t("kernel.computers.setup.state.unsupported")
    if (state === "checking") return i18n.t("kernel.computers.setup.state.checking")
    if (item === "keepAwake" && state === "done") {
      const status = props.tc.awake()
      if (status?.power === "battery") return i18n.t("kernel.computers.ready.keepAwakeBattery")
      if (status?.held) return i18n.t("kernel.computers.ready.keepAwakeHeld")
    }
    if (item === "notifications" && state === "todo" && props.tc.notificationsRefused()) {
      return i18n.t("kernel.computers.setup.notificationsDenied")
    }
    return null
  }

  return (
    <section data-testid="computer-ready" class="border-t border-border-subtle pt-6">
      <h2 class={sectionHeading}>{i18n.t("kernel.computers.ready.title")}</h2>
      <p class="mt-2 max-w-[60ch] text-[13px] leading-relaxed text-text-secondary">
        {i18n.t("kernel.computers.ready.hint")}
      </p>
      <ul class="mt-2 flex flex-col divide-y divide-border-subtle">
        <For each={["claude", "notifications", "launchAtLogin", "keepAwake"] as ChecklistItem[]}>
          {(item) => (
            <Row
              testId={`computer-ready-${item}`}
              state={items()[item]}
              title={i18n.t(`kernel.computers.ready.check.${item}`)}
              hint={hint(item)}
              action={action(item)}
            />
          )}
        </For>
        <Show when={props.denied.length > 0}>
          <Row
            testId="computer-ready-read"
            state="warn"
            title={i18n.t("kernel.computers.ready.read", {
              places: placesLabel(props.denied),
            })}
            hint={i18n.t("kernel.computers.ready.readDenied", {
              os: i18n.t(`kernel.computers.os.${osKey(props.os)}`),
            })}
            action={
              props.tc.shell?.openPrivacySettings && props.os !== "linux" ? (
                <Button
                  variant="outline"
                  class={`w-auto shrink-0 ${target}`}
                  data-testid="computer-ready-open-settings"
                  onClick={() => void props.tc.shell?.openPrivacySettings?.()}
                >
                  {i18n.t("kernel.computers.folders.openSystemSettings")}
                </Button>
              ) : undefined
            }
          />
        </Show>
      </ul>
    </section>
  )
}
