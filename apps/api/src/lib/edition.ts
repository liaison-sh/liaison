// SPDX-License-Identifier: FSL-1.1-ALv2
import { env } from "~/lib/env"

/**
 * The instance edition — the clean frontier between self-hosted and managed.
 *
 * - `managed`     — the multi-tenant managed edition, switched on by
 *                   `LIAISON_EDITION=managed` (validated at server boot,
 *                   lib/managed-boot.ts). Credit metering, balance deduction,
 *                   and tier gating are live.
 * - `self_hosted` — BYOK-only: agent usage is recorded for monitoring but is
 *                   NEVER metered, deducted, or balance-gated.
 *
 * Only `LIAISON_EDITION=managed` switches managed on, so the managed boot
 * checks always run for a managed server (lib/managed-boot.ts). The legacy
 * control-plane pair (`CONTROL_PLANE_URL` + `CONTROL_PLANE_API_KEY`) alone no
 * longer does: such a server boots self-hosted with a warning (`legacyControlPlaneBootProblem`).
 */
export type Edition = "self_hosted" | "managed"

/** The edition these settings select. Pure: the caller passes the values. */
export function detectEdition(e: {
  LIAISON_EDITION?: string
  /** Read by older releases; none of these select the edition now. */
  NODE_ENV?: string
  CONTROL_PLANE_URL?: string
  CONTROL_PLANE_API_KEY?: string
}): Edition {
  return e.LIAISON_EDITION === "managed" ? "managed" : "self_hosted"
}

let override: Edition | null = null

/** The resolved instance edition. */
export function edition(): Edition {
  return override ?? detectEdition(env)
}

/** True in the managed edition — the only mode in which credits exist and agent
 *  usage is metered and deducted. */
export function isManagedEdition(): boolean {
  return edition() === "managed"
}

/** Test helper — force the edition. Pass `null` to restore env detection. */
export function _setEdition(mode: Edition | null): void {
  override = mode
}
