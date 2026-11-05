// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"

/**
 * The app an attention item is about: its own `app`, or for a kernel provider's
 * item, the connection's app (`metadata.appName`) or the approval's tool app
 * (`metadata.toolName` prefix).
 */
export function attentionSourceApp(item: AttentionItem): string {
  if (item.app !== "kernel") return item.app
  const meta = (item.metadata ?? {}) as { appName?: unknown; toolName?: unknown }
  if (typeof meta.appName === "string") return meta.appName
  if (typeof meta.toolName === "string") return meta.toolName.split(":")[0] ?? "kernel"
  return "kernel"
}
