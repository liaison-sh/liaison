// SPDX-License-Identifier: FSL-1.1-ALv2
export interface AppUIContext {
  openTab(type: string, entityId: string, label?: string): void
  closeTab(): void
  showToast(message: string, variant?: "success" | "error" | "info"): void
}
