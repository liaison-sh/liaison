// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AppUIContext } from "./types"

interface ShellBindings {
  openTab: (type: string, entityId: string, label?: string) => void
  closeTab: () => void
  showToast: (message: string, variant?: string) => void
}

export function createDirectBridge(shell: ShellBindings): AppUIContext {
  return {
    openTab: (type, entityId, label) => shell.openTab(type, entityId, label),
    closeTab: () => shell.closeTab(),
    showToast: (message, variant) => shell.showToast(message, variant),
  }
}
