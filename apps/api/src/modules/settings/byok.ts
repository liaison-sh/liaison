// SPDX-License-Identifier: FSL-1.1-ALv2
// The model providers an organization can bring its own key for, and their
// names as people read them. One list for the key routes and the secret card.

import { createMiddleware } from "hono/factory"
import type { AppEnv } from "~/app"
import { isManagedEdition } from "~/lib/edition"

export const BYOK_PROVIDERS = ["anthropic", "openai", "google", "mistral", "openrouter"] as const
export type ByokProvider = (typeof BYOK_PROVIDERS)[number]

export const BYOK_PROVIDER_NAMES: Record<ByokProvider, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  google: "Google",
  mistral: "Mistral",
  openrouter: "OpenRouter",
}

/**
 * The managed edition runs every model call on the server's own provider keys
 * and meters it in credits (spec A33): adding or checking an organization's
 * own provider key, or adding an own model server or one of its models, is
 * refused with 403 `managed_no_byok`. Reading and removing stay allowed.
 * Decided per request (lib/edition.ts).
 */
export const refuseByokInManaged = createMiddleware<AppEnv>(async (c, next) => {
  if (isManagedEdition() && c.req.method !== "GET" && c.req.method !== "DELETE") {
    return c.json(
      {
        error: {
          message:
            "This service runs models on its own keys: your own keys and servers are not used.",
          code: "managed_no_byok",
        },
      },
      403,
    )
  }
  await next()
})
