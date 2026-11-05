// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AN ORG'S OWN MODEL SERVER: an OpenAI-compatible endpoint (vLLM, Ollama,
// LM Studio, a gateway) an admin adds on the AI models page. Its address is
// org data, so every call to it goes through the outbound guards:
//   - link-local and metadata addresses are always refused;
//   - private and loopback addresses only when the operator sets
//     LIAISON_ALLOW_PRIVATE_MODEL_SERVERS=true (a self-hosted box whose model
//     runs on its own network), never inferred from the edition;
//   - a demo box refuses custom servers outright;
//   - the connection is pinned to the address the guard checked, and a
//     redirect is never followed.
import { createOpenAICompatible } from "@ai-sdk/openai-compatible"
import type { LanguageModel } from "ai"
import {
  fetchWithPinnedHost,
  UnsafeOutboundUrlError,
  validateOutboundUrl,
} from "~/lib/outbound-fetch"
import { isDemoModeEnabled } from "~/modules/demo/demo-mode"

export class ModelServerError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ModelServerError"
  }
}

const NOT_A_URL = "This is not a valid address. Start it with http:// or https://"

/** Has the operator allowed model servers on private and loopback addresses? */
export function privateModelServersAllowed(): boolean {
  return process.env.LIAISON_ALLOW_PRIVATE_MODEL_SERVERS === "true"
}

function guardOptions() {
  return { requireHttps: false, allowPrivate: privateModelServersAllowed() } as const
}

/** Normalise an admin-entered address: trimmed, no trailing slash. */
export function normaliseServerURL(raw: string): string {
  return raw.trim().replace(/\/+$/, "")
}

/**
 * Check a model server address before it is stored or called. Throws a
 * ModelServerError whose message is fit to show the admin.
 */
export async function validateModelServerUrl(baseURL: string): Promise<URL> {
  if (isDemoModeEnabled()) {
    throw new ModelServerError("Your own model servers are not available on the demo.")
  }
  let parsed: URL
  try {
    parsed = new URL(baseURL)
  } catch {
    throw new ModelServerError(NOT_A_URL)
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelServerError(NOT_A_URL)
  }
  try {
    return await validateOutboundUrl(parsed, guardOptions())
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      if (/private network/.test(err.message)) {
        throw new ModelServerError("This address is on a private network")
      }
      if (/link-local or metadata/.test(err.message)) {
        throw new ModelServerError("This address cannot be used for a model server")
      }
      if (/resolved|validated/.test(err.message)) {
        throw new ModelServerError(`The host ${parsed.host} could not be found`)
      }
      throw new ModelServerError(err.message)
    }
    throw err
  }
}

/** A fetch for the AI SDK that goes through the pinned, no-redirect outbound path. */
export function modelServerFetch(): typeof fetch {
  const opts = { ...guardOptions(), maxRedirects: 0 }
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : input
    return fetchWithPinnedHost(url, init ?? {}, opts)
  }) as typeof fetch
}

/** The model a custom server serves under `name`, after the address guard. */
export async function createModelServerModel(params: {
  baseURL: string
  apiKey: string
  name: string
}): Promise<LanguageModel> {
  await validateModelServerUrl(params.baseURL)
  return createOpenAICompatible({
    name: "custom",
    baseURL: params.baseURL,
    ...(params.apiKey ? { apiKey: params.apiKey } : {}),
    // Streamed turns report token counts only when the usage chunk is asked for.
    includeUsage: true,
    fetch: modelServerFetch(),
  })(params.name)
}
