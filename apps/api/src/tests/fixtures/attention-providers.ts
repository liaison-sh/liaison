// SPDX-License-Identifier: FSL-1.1-ALv2
import type { AttentionItem } from "@liaison/shared"

function mkItem(provider: string, urgency: number, suffix: string): AttentionItem {
  return {
    id: `${provider}:item:${suffix}`,
    app: provider,
    entity: "thing",
    entityId: suffix,
    kind: "admin_action",
    summary: `${provider} item`,
    urgency,
    occurredAt: new Date().toISOString(),
    action: { type: "open_entity", tabType: `${provider}:thing`, entityId: suffix },
  }
}

export async function fastProviderA(): Promise<AttentionItem[]> {
  return [mkItem("fastA", 90, "1")]
}

export async function fastProviderB(): Promise<AttentionItem[]> {
  return [mkItem("fastB", 50, "2")]
}

export async function fastProviderC(): Promise<AttentionItem[]> {
  return [mkItem("fastC", 30, "3")]
}

export async function slowProvider(): Promise<AttentionItem[]> {
  await new Promise((r) => setTimeout(r, 2500))
  return [mkItem("slow", 70, "x")]
}
