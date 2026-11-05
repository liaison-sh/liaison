// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * MODEL KEYS: the one id a thread, an agent or a routine stores for its model
 * (`threads.agent_model_id`, `agents.model_preference`, `routines.agent_model_id`).
 *
 *   - a native model's key is its catalogue id (`gemini-flash-lite-latest`);
 *   - an OpenRouter model's key is `openrouter/<OpenRouter id>`
 *     (`openrouter/deepseek/deepseek-v4.1-flash`);
 *   - a model of an org's own server is `custom/<serverId>/<model name>`.
 *
 * The prefix decides the namespace, so the three never collide: a key that
 * starts with `openrouter/` or `custom/` is never looked up in the native
 * catalogue, even if a row with that id were ever inserted there. A custom key
 * is split on its first two slashes only, so a model name may contain slashes.
 */
import type { AddedModel, AiModelsSettings } from "@liaison/shared"

export const OPENROUTER_KEY_PREFIX = "openrouter/"
export const CUSTOM_KEY_PREFIX = "custom/"

/** A custom server's id: 8 lowercase hex characters. */
export const SERVER_ID_RE = /^[0-9a-f]{8}$/

export type ParsedModelKey =
  | { kind: "native"; modelId: string }
  | { kind: "openrouter"; upstreamId: string }
  | { kind: "custom"; serverId: string; name: string }

/** Parse a stored model key, or null for a key in an added namespace that is malformed. */
export function parseModelKey(key: string): ParsedModelKey | null {
  if (key.startsWith(OPENROUTER_KEY_PREFIX)) {
    const upstreamId = key.slice(OPENROUTER_KEY_PREFIX.length)
    return upstreamId ? { kind: "openrouter", upstreamId } : null
  }
  if (key.startsWith(CUSTOM_KEY_PREFIX)) {
    const rest = key.slice(CUSTOM_KEY_PREFIX.length)
    const slash = rest.indexOf("/")
    if (slash <= 0) return null
    const serverId = rest.slice(0, slash)
    const name = rest.slice(slash + 1)
    if (!SERVER_ID_RE.test(serverId) || !name) return null
    return { kind: "custom", serverId, name }
  }
  return { kind: "native", modelId: key }
}

/** Is this id one a native catalogue row may carry? (No added-namespace prefix.) */
/**
 * The providers whose catalogue rows are chat models. The catalogue also prices
 * non-model work (the `system` web search row); such a row is never offered in
 * a picker, never Auto and never a model a turn runs on.
 */
export const CHAT_MODEL_PROVIDERS = ["anthropic", "openai", "google", "mistral"] as const

export function isChatModelProvider(provider: string): boolean {
  return (CHAT_MODEL_PROVIDERS as readonly string[]).includes(provider)
}

export function isNativeModelId(modelId: string): boolean {
  return !modelId.startsWith(OPENROUTER_KEY_PREFIX) && !modelId.startsWith(CUSTOM_KEY_PREFIX)
}

export function openRouterModelKey(upstreamId: string): string {
  return `${OPENROUTER_KEY_PREFIX}${upstreamId}`
}

export function customModelKey(serverId: string, name: string): string {
  return `${CUSTOM_KEY_PREFIX}${serverId}/${name}`
}

/** Where a custom server's key sits in `providerKeys`. */
export function customServerKeyName(serverId: string): string {
  return `custom:${serverId}`
}

/** A fresh custom server id. */
export function newServerId(): string {
  return crypto.randomUUID().replaceAll("-", "").slice(0, 8)
}

/** An added model's entry, by key. */
export function findAddedModel(models: AiModelsSettings, key: string): AddedModel | undefined {
  return (models.added ?? []).find((m) => m.key === key)
}
