// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * The agreements app's two doors into the signing module (modules/signing):
 *
 *  - `signing_seal(params)`: the manifest and seal of a version from its three
 *    hashes (the trail's computed here from the trail itself when given), its
 *    level, agreement and version. Pure: no database, no network, no key.
 *  - `signing_timestamp(params)`: an RFC 3161 stamp over a sealed manifest
 *    from the instance's authority. The kernel recomputes the seal from the
 *    manifest, so an app cannot have another value stamped. A reply is
 *    returned only after it verified; anything else answers `pending` with
 *    the reason, and `not_configured` (`TIMESTAMP_NOT_CONFIGURED`) when the
 *    instance has no authority.
 *
 * Both refuse any caller but the `agreements` app. Both answer data, never a
 * throw, for an expected outcome, since only an error's message crosses the
 * sandbox boundary. Bytes cross as base64.
 */
import type { BridgeContext } from "~/modules/apps/sandbox/bridge/context"
import { canonicalJsonBytes } from "~/modules/signing/canonical-json"
import { computeSeal, parseSealManifest, sealManifest, trailSha256 } from "~/modules/signing/seal"
import { loadTsaConfig, requestTimestamp } from "~/modules/signing/timestamp"

/** The one app that may call the signing bridge. */
export const SIGNING_BRIDGE_APP = "agreements"

interface SealParams {
  documentSha256: string
  signedPdfSha256: string
  /** The full trail; its hash is computed here. */
  trail?: unknown
  /** Or the trail hash, when the caller already holds it. */
  trailSha256?: string
  level: string
  agreement: string
  version: number
}

export function createSigningMethods(ctx: BridgeContext): Record<string, any> {
  const { requireApp } = ctx
  return {
    signing_seal: async (paramsJson: string): Promise<string> => {
      requireApp(SIGNING_BRIDGE_APP, "signing_seal")
      const p = JSON.parse(paramsJson || "{}") as SealParams
      const trailHash = p.trail !== undefined ? trailSha256(p.trail) : p.trailSha256
      const s = computeSeal({
        documentSha256: p.documentSha256,
        signedPdfSha256: p.signedPdfSha256,
        trailSha256: trailHash as string,
        level: p.level,
        agreement: p.agreement,
        version: p.version,
      })
      return JSON.stringify({
        manifest: s.manifest,
        manifestJson: new TextDecoder().decode(s.manifestBytes),
        seal: s.seal,
        trailSha256: s.manifest.trail_sha256,
        hashAlg: s.hashAlg,
        sealVersion: s.sealVersion,
      })
    },

    signing_timestamp: async (paramsJson: string): Promise<string> => {
      requireApp(SIGNING_BRIDGE_APP, "signing_timestamp")
      const p = JSON.parse(paramsJson || "{}") as { manifest?: unknown }
      const s = sealManifest(parseSealManifest(p.manifest))
      const config = loadTsaConfig()
      if (!config) {
        return JSON.stringify({
          status: "not_configured",
          code: "TIMESTAMP_NOT_CONFIGURED",
          seal: s.seal,
          message:
            "No timestamp authority is configured on this server (LIAISON_TSA_URL). Nothing was stamped.",
        })
      }
      const out = await requestTimestamp({ manifestBytes: canonicalJsonBytes(s.manifest), config })
      if (out.status === "pending") {
        return JSON.stringify({
          status: "pending",
          seal: s.seal,
          reason: out.reason,
          message: `The timestamp authority gave no usable stamp (${out.reason}); the seal waits for a retry. Nothing was stored.`,
        })
      }
      return JSON.stringify({
        status: "stamped",
        seal: s.seal,
        replyBase64: Buffer.from(out.reply).toString("base64"),
        genTime: out.genTime.toISOString(),
        policy: out.policy,
        serialHex: out.serialHex,
        signerCertSha256: out.signerCertSha256,
        chainSha256: out.chainSha256,
      })
    },
  }
}
