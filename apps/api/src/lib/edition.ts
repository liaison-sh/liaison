// SPDX-License-Identifier: FSL-1.1-ALv2
import { env, validateControlPlaneEnv } from "~/lib/env"

/**
 * The instance edition — the clean frontier between self-hosted and managed.
 *
 * - `managed`     — connected to a control plane (`CONTROL_PLANE_URL` +
 *                   `CONTROL_PLANE_API_KEY` both set). Credit metering, balance
 *                   deduction, tier gating, and the billing-admin API are live.
 * - `self_hosted` — no control plane. BYOK-only: agent usage is recorded for
 *                   monitoring but is NEVER metered, deducted, or balance-gated.
 *                   There are no credits outside a control plane.
 *
 * Detection delegates to `validateControlPlaneEnv` — the single source of truth
 * for what "managed" means. Half-configured (one env var set) resolves to
 * `self_hosted` here; production startup fails that case separately.
 */
export type Edition = "self_hosted" | "managed"

function detect(): Edition {
  try {
    return validateControlPlaneEnv(
      {
        NODE_ENV: env.NODE_ENV,
        CONTROL_PLANE_URL: env.CONTROL_PLANE_URL,
        CONTROL_PLANE_API_KEY: env.CONTROL_PLANE_API_KEY,
      },
      { warn: () => {} },
    ).mode
  } catch {
    return "self_hosted"
  }
}

const detected: Edition = detect()
let override: Edition | null = null

/** The resolved instance edition. */
export function edition(): Edition {
  return override ?? detected
}

/** True when this instance is connected to a control plane — the only mode in
 *  which credits exist and agent usage is metered and deducted. */
export function isManagedEdition(): boolean {
  return edition() === "managed"
}

/** Test helper — force the edition. Pass `null` to restore env detection. */
export function _setEdition(mode: Edition | null): void {
  override = mode
}
