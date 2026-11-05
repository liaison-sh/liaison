// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The worker integrity bootstrap, and an honest statement of what it is worth.
//
// No shipping browser can SRI-pin a worker: `new Worker(url)` has no
// `integrity` option and import map `integrity` is ignored inside worker
// contexts. What we do instead: the page fetches the worker source, hashes it,
// compares the hash against one baked into the page at build time, and boots
// the worker from a blob URL only on a match, with a CSP `script-src` hash
// source and `worker-src blob:` narrowing what else could run.
//
// This does NOT protect against an operator who serves a different page: the
// baked hash is served by the same origin as the worker (spec section 9.1). It
// closes tampering with the worker file alone. Do not claim anything stronger
// here or in any copy.

export async function sha256Base64(source: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(source))
  const bytes = new Uint8Array(digest)
  let binary = ""
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

export async function verifyWorkerSource(source: string, expectedHash: string): Promise<boolean> {
  const actual = await sha256Base64(source)
  if (actual.length !== expectedHash.length) return false
  // Constant time compare. The hash is public, but a timing-variable compare
  // here is free to avoid and one less thing to argue about.
  let diff = 0
  for (let i = 0; i < actual.length; i++) diff |= actual.charCodeAt(i) ^ expectedHash.charCodeAt(i)
  return diff === 0
}

export interface WorkerBootOptions {
  /** Versioned and immutable, so the fetched bytes are the pinned bytes. */
  url: string
  expectedHash: string
  /**
   * Where the verified worker boots from. A build's worker is one self-contained
   * file and boots from a blob of the verified bytes (the default). The dev
   * server's worker imports other modules and only runs from its own URL.
   */
  bootFrom?: "blob" | "url"
}

/**
 * Fetch, verify, boot. Returns null when the hash does not match, and the
 * caller then refuses to unlock rather than running unverified code.
 */
export async function bootVerifiedWorker(options: WorkerBootOptions): Promise<Worker | null> {
  const response = await fetch(options.url, { credentials: "same-origin" })
  if (!response.ok) return null
  const source = await response.text()
  if (!(await verifyWorkerSource(source, options.expectedHash))) return null
  if (options.bootFrom === "url") return new Worker(options.url, { type: "module" })
  const blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }))
  try {
    return new Worker(blobUrl, { type: "module" })
  } finally {
    URL.revokeObjectURL(blobUrl)
  }
}
