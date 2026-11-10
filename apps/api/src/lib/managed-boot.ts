// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Boot validation of the managed edition (`LIAISON_EDITION=managed`). A
// managed server hosts many orgs and is answerable to its control plane, so it
// refuses to start, naming what is missing, without:
//
//   - LIAISON_OPERATOR_ORG_ID    the one org that holds instance powers (no
//                                oldest-org fallback in this edition);
//   - LIAISON_ORG_HOST_TEMPLATE  each org's public host, with a `{slug}` placeholder;
//   - LIAISON_TEAM_ENDPOINT      set explicitly; the built-in default is refused
//                                unless LIAISON_TEAM_ENDPOINT_ALLOW_DEFAULT=1;
//   - LIAISON_PAY_FRAME_ORIGIN   the https origin of the Billing page's payment
//                                frame (no path, no trailing slash);
//   - LIAISON_MANAGED_DEFAULT_MODELS  the OpenRouter model ids a new org gets
//                                enabled (comma-separated, the first is Auto), so
//                                the first chat of every org has a model;
//   - a mail transport (RESEND_API_KEY or SMTP_HOST): sign-in codes, invitations
//                                and resets must reach people, never only the log;
//   - OPENROUTER_API_KEY         every AI call of the cell (chat, embeddings, media
//                                analysis, web search) runs on OpenRouter (S31);
//   - with GMAIL_PUBSUB_TOPIC, GMAIL_PUSH_AUDIENCE (https) and GMAIL_PUSH_SERVICE_ACCOUNT:
//                                the push subscription posts to /webhooks/_cell/gmail-push
//                                with an OIDC token the server must be able to verify;
//   - and NO other provider key: any non-blank platform key of ENV_KEY_MAP other
//     than OpenRouter's, or any GEMINI_* variable, is refused, so no call can
//     leave outside OpenRouter's zero-retention routing. OAuth client
//     variables (GOOGLE_OAUTH_CLIENT_ID, ...) are not provider keys.
//   - a liaison team identity installed with `liaison team identity install`
//     (state registered, key readable under ENCRYPTION_KEY). The managed
//     edition never registers itself.
//
// Raw `process.env` values: the parsed env fills defaults (LIAISON_TEAM_ENDPOINT)
// that must not count as set. Runs on server boot only (index.ts), never in the CLI.

import { withSystemDb } from "~/db/privileged"
import {
  DEFAULT_LIAISON_TEAM_ENDPOINT,
  isBareHttpsOrigin,
  parseManagedDefaultModels,
} from "~/lib/env"
import { ENV_KEY_MAP } from "~/modules/agent/credits/platform-key-env"
import { decryptInstanceKey, readIdentity } from "~/modules/liaison-team/identity"

export type IdentityBootState = "missing" | "pending" | "retiring" | "unreadable" | "registered"

type RawEnv = Record<string, string | undefined>

const blank = (v: string | undefined) => !v || v.trim() === ""
const trimSlash = (v: string) => v.trim().replace(/\/+$/, "")

/**
 * The provider key variables set (non-blank) that a managed cell must not hold:
 * every platform key but OpenRouter's, and any `GEMINI_*` variable.
 */
export function forbiddenManagedProviderKeys(raw: RawEnv): string[] {
  const platform = Object.values(ENV_KEY_MAP).filter((name) => name !== ENV_KEY_MAP.openrouter)
  const gemini = Object.keys(raw)
    .filter((name) => name.startsWith("GEMINI_"))
    .sort()
  return [...new Set([...platform, ...gemini])].filter((name) => !blank(raw[name]))
}

/**
 * A cell's Gmail push (S30): with a topic set, the push subscription posts to the
 * cell's `/webhooks/_cell/gmail-push` with a Google OIDC token, which the cell can
 * only verify knowing the token's audience and the push service account.
 */
function gmailPushProblems(raw: RawEnv): string[] {
  if (blank(raw.GMAIL_PUBSUB_TOPIC)) return []
  const problems: string[] = []
  const audience = raw.GMAIL_PUSH_AUDIENCE
  if (blank(audience)) {
    problems.push(
      "GMAIL_PUSH_AUDIENCE is required with GMAIL_PUBSUB_TOPIC: the https URL the push subscription posts to (its OIDC audience)",
    )
  } else if (!/^https:\/\/[^\s/]+\/\S*$/.test((audience as string).trim())) {
    problems.push("GMAIL_PUSH_AUDIENCE must be an https URL (the push endpoint)")
  }
  const account = raw.GMAIL_PUSH_SERVICE_ACCOUNT
  if (blank(account)) {
    problems.push(
      "GMAIL_PUSH_SERVICE_ACCOUNT is required with GMAIL_PUBSUB_TOPIC: the service account the push subscription signs its tokens as",
    )
  } else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((account as string).trim())) {
    problems.push("GMAIL_PUSH_SERVICE_ACCOUNT must be a service account address")
  }
  return problems
}

/** Every reason this managed server must not boot; empty when it may. */
export function managedBootProblems(raw: RawEnv, identity: IdentityBootState): string[] {
  const problems: string[] = []
  if (blank(raw.LIAISON_OPERATOR_ORG_ID)) {
    problems.push("LIAISON_OPERATOR_ORG_ID is required: the id of the instance operator's org")
  }
  const template = raw.LIAISON_ORG_HOST_TEMPLATE
  if (blank(template)) {
    problems.push("LIAISON_ORG_HOST_TEMPLATE is required: each org's public URL, with {slug}")
  } else if (!template?.includes("{slug}")) {
    problems.push("LIAISON_ORG_HOST_TEMPLATE must contain the {slug} placeholder")
  }
  const endpoint = raw.LIAISON_TEAM_ENDPOINT
  if (blank(endpoint)) {
    problems.push("LIAISON_TEAM_ENDPOINT is required: this server's control plane endpoint")
  } else if (
    trimSlash(endpoint as string) === trimSlash(DEFAULT_LIAISON_TEAM_ENDPOINT) &&
    raw.LIAISON_TEAM_ENDPOINT_ALLOW_DEFAULT !== "1"
  ) {
    problems.push(
      "LIAISON_TEAM_ENDPOINT is the built-in default; set LIAISON_TEAM_ENDPOINT_ALLOW_DEFAULT=1 if that is intended",
    )
  }
  const payFrame = raw.LIAISON_PAY_FRAME_ORIGIN
  if (blank(payFrame)) {
    problems.push(
      "LIAISON_PAY_FRAME_ORIGIN is required: the https origin of the Billing page's payment frame",
    )
  } else if (!isBareHttpsOrigin((payFrame as string).trim())) {
    problems.push(
      "LIAISON_PAY_FRAME_ORIGIN must be an https origin with no path or trailing slash (https://pay.example.com)",
    )
  }
  const models = raw.LIAISON_MANAGED_DEFAULT_MODELS
  if (blank(models)) {
    problems.push(
      "LIAISON_MANAGED_DEFAULT_MODELS is required: the OpenRouter model ids a new org gets enabled, comma-separated",
    )
  } else if (parseManagedDefaultModels(models as string) === null) {
    problems.push(
      "LIAISON_MANAGED_DEFAULT_MODELS must be comma-separated OpenRouter model ids (vendor/model)",
    )
  }
  if (blank(raw.RESEND_API_KEY) && blank(raw.SMTP_HOST)) {
    problems.push(
      "a mail transport is required: set RESEND_API_KEY or SMTP_HOST (sign-in codes, invitations and resets)",
    )
  }
  if (blank(raw.OPENROUTER_API_KEY)) {
    problems.push(
      "OPENROUTER_API_KEY is required: every AI call of a managed cell runs on OpenRouter",
    )
  }
  problems.push(...gmailPushProblems(raw))
  const forbidden = forbiddenManagedProviderKeys(raw)
  if (forbidden.length > 0) {
    problems.push(
      `only OpenRouter's key may be set on a managed cell (every AI call runs on OpenRouter with zero data retention); unset: ${forbidden.join(", ")}`,
    )
  }
  const identityProblem: Record<Exclude<IdentityBootState, "registered">, string> = {
    missing:
      "no liaison team identity: run `liaison team identity mint`, then `liaison team identity install --key-file <path>`",
    pending:
      "the liaison team identity is minted but its key is not installed: run `liaison team identity install --key-file <path>`",
    retiring: "the liaison team identity is retiring: mint and install a new one",
    unreadable:
      "the liaison team identity key does not decrypt under ENCRYPTION_KEY: mint and install a new one",
  }
  if (identity !== "registered") problems.push(identityProblem[identity])
  return problems
}

/** The stored identity, as the boot check sees it. */
export async function readIdentityBootState(): Promise<IdentityBootState> {
  const identity = await withSystemDb("managed-boot:identity", (tx) => readIdentity(tx))
  if (!identity) return "missing"
  if (identity.state !== "registered") return identity.state
  return decryptInstanceKey(identity) === null ? "unreadable" : "registered"
}

/** Throws one error listing every problem; resolves when the managed server may boot. */
export async function assertManagedBoot(raw: RawEnv = process.env): Promise<void> {
  const problems = managedBootProblems(raw, await readIdentityBootState())
  if (problems.length > 0) {
    throw new Error(
      `Managed edition (LIAISON_EDITION=managed) cannot start:\n- ${problems.join("\n- ")}`,
    )
  }
}

/**
 * Whether this server boots under the checks above: only when it is switched
 * on by `LIAISON_EDITION=managed`, the multi-org cloud edition, which is also
 * the only way managed mode is switched on (lib/edition.ts).
 */
export function managedBootRequired(raw: RawEnv = process.env): boolean {
  return raw.LIAISON_EDITION === "managed"
}

/**
 * The legacy control-plane pair (`CONTROL_PLANE_URL` + `CONTROL_PLANE_API_KEY`)
 * set without `LIAISON_EDITION`: it once switched the managed edition on
 * without the checks above. It no longer switches anything: such a server boots
 * self-hosted, and index.ts logs this message as a warning saying what to set.
 * Null when there is nothing to warn about.
 */
export function legacyControlPlaneBootProblem(raw: RawEnv = process.env): string | null {
  if (raw.LIAISON_EDITION?.trim()) return null
  if (!raw.CONTROL_PLANE_URL?.trim() || !raw.CONTROL_PLANE_API_KEY?.trim()) return null
  return (
    "CONTROL_PLANE_URL and CONTROL_PLANE_API_KEY are set without LIAISON_EDITION. " +
    "They no longer switch the managed edition on, so this server runs self-hosted: set " +
    "LIAISON_EDITION=managed (the server then boots under the managed checks) or " +
    "LIAISON_EDITION=self_hosted, or unset both variables."
  )
}
