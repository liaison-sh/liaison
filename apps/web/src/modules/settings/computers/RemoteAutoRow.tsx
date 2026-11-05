// SPDX-License-Identifier: FSL-1.1-ALv2
//
// REMOTE AUTO, on this computer's Settings tab (desktop app only). A node chat
// is started from the web or a phone, so nobody may be at this computer: it
// runs in Manual unless the person turned this on here. The switch is the
// shell's (apps/desktop src-tauri/src/node_job.rs): turning it on is the
// shell's own native question, so the state shown is always what the shell
// answered, never what the page asked for.

import { type Component, createSignal, onMount } from "solid-js"
import type { DesktopBridge } from "~/lib/desktop-shell-contract"
import { useI18n } from "~/modules/i18n/i18n-context"
import { Switch as Toggle } from "~/ui/Switch"

export const RemoteAutoRow: Component<{
  shell: Pick<DesktopBridge, "remoteAuto" | "setRemoteAuto">
}> = (props) => {
  const i18n = useI18n()
  const [on, setOn] = createSignal<boolean | null>(null)
  onMount(() => {
    void props.shell
      .remoteAuto?.()
      .then(setOn)
      .catch(() => setOn(false))
  })
  async function change(next: boolean): Promise<void> {
    const before = on()
    setOn(null)
    try {
      setOn((await props.shell.setRemoteAuto?.(next)) === true)
    } catch {
      setOn(before ?? false)
    }
  }
  return (
    <section
      data-testid="computer-remote-auto"
      class="flex items-start justify-between gap-6 border-t border-border-subtle pt-6"
    >
      <div class="min-w-0 flex-1">
        <p class="text-[13px] font-medium text-text">
          {i18n.t("kernel.computers.settings.remoteAutoTitle")}
        </p>
        <p class="mt-1 max-w-[60ch] text-[12.5px] leading-relaxed text-text-secondary">
          {i18n.t("kernel.computers.settings.remoteAutoBody")}
        </p>
      </div>
      <Toggle
        data-testid="computer-remote-auto-switch"
        checked={on() === true}
        disabled={on() === null}
        label={i18n.t("kernel.computers.settings.remoteAutoTitle")}
        onChange={(next) => void change(next)}
      />
    </section>
  )
}
