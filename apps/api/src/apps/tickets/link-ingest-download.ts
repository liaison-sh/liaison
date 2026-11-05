// SPDX-License-Identifier: FSL-1.1-ALv2
import { fileTypeFromBuffer } from "file-type"
import { filesLogger as log } from "~/lib/logger"
import { fetchWithPinnedHost, UnsafeOutboundUrlError } from "~/lib/outbound-fetch"
import { readStreamCapped } from "~/lib/read-capped-body"
import {
  DOWNLOAD_TIMEOUT_MS,
  MEDIA_MAX_BYTES,
} from "~/modules/agent/media/media-analysis-constants"
import { hostInWhitelist } from "~/modules/agent/media/media-analysis-shared"

/**
 * The pure, unit-testable download-and-verify core for the inbound
 * transfer-link auto-downloader (C2). Built ON TOP of `outbound-fetch.ts` —
 * the DNS-pin / private-IP / redirect protections are delegated there and NOT
 * reimplemented. This module adds the new concerns: host whitelist (via
 * `onHopValidate`, enforced on the initial URL AND every redirect hop),
 * magic-byte true-type verification, a streamed byte cap, and a hard timeout.
 *
 * Egress goes ONLY through `outbound-fetch.ts` — never a bare `fetch` (the
 * raw-fetch-discipline guard fails the build otherwise).
 */

export interface DownloadOptions {
  whitelist: string[]
  /** Test seam — injected fake fetch (forwarded to outbound-fetch's fetchImpl). */
  fetchImpl?: typeof fetch
}

export interface ResolvedDownload {
  downloadUrl: string
  filename?: string
  declaredSize?: number
}

export type DownloadResult = { bytes: Buffer; mimeFromMagic: string } | { error: string }

/**
 * Download a media file from a (whitelisted) direct-download URL and verify it.
 * Returns the raw bytes + magic-detected MIME, or a caller-visible error string.
 */
export async function downloadVerifiedMedia(
  downloadUrl: string,
  opts: DownloadOptions,
): Promise<DownloadResult> {
  try {
    const response = await fetchWithPinnedHost(
      downloadUrl,
      { headers: { accept: "image/*,video/*" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
      {
        fetchImpl: opts.fetchImpl,
        // requireHttps defaults to true. onHopValidate runs on the initial URL
        // and on every redirect hop — the whitelist gate.
        onHopValidate: (next) => {
          if (!hostInWhitelist(next.host, opts.whitelist)) {
            throw new UnsafeOutboundUrlError(`Off-whitelist host: ${next.host}`)
          }
        },
      },
    )

    if (!response.ok) {
      return { error: `Download failed with HTTP ${response.status}` }
    }

    // Cheap early gate: header content-type must look like media. The header is
    // spoofable, so this is NOT authoritative — the magic-byte check below is.
    const headerType = (response.headers.get("content-type") ?? "").toLowerCase()
    if (!headerType.startsWith("image/") && !headerType.startsWith("video/")) {
      return { error: `Unexpected content-type: ${headerType || "none"}` }
    }

    // Stream the body, enforcing the hard byte ceiling regardless of
    // Content-Length (advisory only). Mirrors object-storage's strict `>` cap.
    const bytes = await streamWithCap(response, MEDIA_MAX_BYTES)
    if ("error" in bytes) return bytes

    // Magic-byte true-type verification — the header is attacker-controlled.
    const sniffed = await fileTypeFromBuffer(bytes.buffer)
    const sniffedMime = sniffed?.mime ?? ""
    if (!sniffedMime.startsWith("image/") && !sniffedMime.startsWith("video/")) {
      return { error: `Content is not image/video (sniffed: ${sniffedMime || "unknown"})` }
    }
    // NOTE: `isBlockedFileType` is intentionally NOT applied here — the
    // magic-byte image/video gate already excludes executables/scripts, and
    // both the resolver filename and the header MIME are attacker-controlled
    // (so feeding them to isBlockedFileType adds no real protection). The
    // sniffed-type gate is the authoritative content check.

    return { bytes: bytes.buffer, mimeFromMagic: sniffedMime }
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      return { error: `Refused unsafe download: ${err.message}` }
    }
    if (err instanceof DOMException && err.name === "TimeoutError") {
      return { error: "Download timed out" }
    }
    if (err instanceof Error && err.name === "AbortError") {
      return { error: "Download timed out" }
    }
    return { error: `Download error: ${err instanceof Error ? err.message : String(err)}` }
  }
}

/** Read a Response body chunk-by-chunk, rejecting at the strict `> cap` boundary. */
async function streamWithCap(
  response: Response,
  cap: number,
): Promise<{ buffer: Buffer } | { error: string }> {
  const body = response.body
  if (!body) {
    // A null body would force an UNBOUNDED `arrayBuffer()` read (the whole
    // payload into memory before any cap → memory-pressure DoS). undici always
    // surfaces a ReadableStream for a 200, so treat a null body as an error
    // rather than reading it. (Defensive: the advisory Content-Length, even if
    // present, is spoofable, so we do not trust it to re-enable the read.)
    return { error: "No response body" }
  }
  const buffer = await readStreamCapped(body, cap)
  return buffer ? { buffer } : { error: `Download exceeds ${cap} bytes` }
}

/**
 * Per-host resolver registry: turns a share URL into direct download URLs.
 * Every resolver routes egress through `fetchWithPinnedHost` (whitelist
 * enforced) and returns `[]` (never undefined) on any failure so the caller can
 * surface a note.
 */
export const resolverRegistry: Record<
  string,
  (shareUrl: string, opts: DownloadOptions) => Promise<ResolvedDownload[]>
> = {
  "swisstransfer.com": resolveSwissTransfer,
  "we.tl": resolveWeTransfer,
  "wetransfer.com": resolveWeTransfer,
}

/**
 * SwissTransfer direct-download resolution. Its API exposes the container
 * metadata as JSON from which a direct download URL is derivable. Best-effort:
 * returns [] on any non-JSON / error response.
 */
async function resolveSwissTransfer(
  shareUrl: string,
  opts: DownloadOptions,
): Promise<ResolvedDownload[]> {
  try {
    const u = new URL(shareUrl)
    // SwissTransfer share URLs end with the transfer UUID. The public API
    // returns container metadata for that id.
    const id = u.pathname.split("/").filter(Boolean).pop()
    // Encode the path segment before interpolation — `id` is from the
    // attacker-controlled share-URL path, and an unencoded `../`/`?`/`#` could
    // reshape the API request path/query. The host is hard-coded and re-checked
    // by onHopValidate, so this is request-hygiene, not an SSRF fix.
    if (!id) return []
    const apiUrl = `https://www.swisstransfer.com/api/links/${encodeURIComponent(id)}`
    const resp = await fetchWithPinnedHost(
      apiUrl,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
      {
        fetchImpl: opts.fetchImpl,
        onHopValidate: (next) => {
          if (!hostInWhitelist(next.host, opts.whitelist)) {
            throw new UnsafeOutboundUrlError(`Off-whitelist host: ${next.host}`)
          }
        },
      },
    )
    if (!resp.ok) return []
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase()
    if (!ct.includes("application/json")) return []
    const data = (await resp.json()) as {
      data?: {
        container?: {
          files?: { fileName?: string; fileSizeInBytes?: number; UUID?: string }[]
          UUID?: string
        }
        downloadHost?: string
      }
    }
    const container = data.data?.container
    const host = data.data?.downloadHost
    const files = container?.files ?? []
    if (!host || !container?.UUID || files.length === 0) return []
    return files
      .filter((f) => f.UUID)
      .map((f) => ({
        downloadUrl: `https://${host}/api/download/${container.UUID}/${f.UUID}`,
        filename: f.fileName,
        declaredSize: f.fileSizeInBytes,
      }))
  } catch (err) {
    log.warn(
      { resolver: "swisstransfer" },
      `resolve failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }
}

/**
 * WeTransfer (best-effort) — attempt a direct GET on the share URL with
 * `Accept: application/json`; if the response is non-JSON or fails, return []
 * so the caller surfaces a note (never undefined behavior).
 */
async function resolveWeTransfer(
  shareUrl: string,
  opts: DownloadOptions,
): Promise<ResolvedDownload[]> {
  try {
    const resp = await fetchWithPinnedHost(
      shareUrl,
      { headers: { accept: "application/json" }, signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) },
      {
        fetchImpl: opts.fetchImpl,
        onHopValidate: (next) => {
          if (!hostInWhitelist(next.host, opts.whitelist)) {
            throw new UnsafeOutboundUrlError(`Off-whitelist host: ${next.host}`)
          }
        },
      },
    )
    if (!resp.ok) return []
    const ct = (resp.headers.get("content-type") ?? "").toLowerCase()
    if (!ct.includes("application/json")) return []
    const data = (await resp.json().catch(() => null)) as { direct_link?: string } | null
    if (!data?.direct_link) return []
    return [{ downloadUrl: data.direct_link }]
  } catch (err) {
    log.warn(
      { resolver: "wetransfer" },
      `resolve failed: ${err instanceof Error ? err.message : String(err)}`,
    )
    return []
  }
}
