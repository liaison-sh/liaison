// SPDX-License-Identifier: FSL-1.1-ALv2
import { createSignal } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import { useApi } from "~/modules/shell/ApiContext"
import { addToast } from "~/modules/shell/toast-store"
import { applyCorrection, readTarget } from "./magic-wand-apply"
import type { ProofreadFormat } from "./types"

export function useMagicWand(opts: {
  getEl: () => HTMLTextAreaElement | HTMLElement | undefined
  kind: ProofreadFormat
}): { run: () => Promise<void>; running: () => boolean } {
  const api = useApi()
  const i18n = useI18n()
  const [running, setRunning] = createSignal(false)

  async function run() {
    const el = opts.getEl()
    if (!el || running()) return
    const { text, format, target } = readTarget(el, opts.kind)
    if (text.trim() === "") return
    setRunning(true)
    try {
      const res = await api.post<{ text: string }>("/assist/proofread", { text, format })
      applyCorrection(target, res.text)
    } catch {
      addToast({ message: i18n.t("kernel.magicWandFailed"), type: "error" })
    } finally {
      setRunning(false)
    }
  }

  return { run, running }
}
