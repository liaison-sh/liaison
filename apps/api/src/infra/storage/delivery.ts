// SPDX-License-Identifier: FSL-1.1-ALv2
//
// How file bytes travel between a browser and the object store.
//
// "direct": the browser PUTs to a presigned URL and fetches a presigned GET, so
// the bytes never cross the API. Only possible when the deployment says the
// store is browser reachable (OBJECT_STORAGE_BROWSER_DIRECT) and the bucket
// carries a CORS rule for the app origins.
//
// "relay": the bytes go through the API (`/api/file-relay/:token` for uploads,
// `/api/files/:id/inline?download=1` and `/api/file-relay-dl/:token` for
// downloads). The only path for a store on a private network (self-hosted
// SeaweedFS), and the default.
//
// Every browser-facing URL decision (upload sessions, download URLs, list
// thumbnails, the CSP) reads this module, so the switch has one meaning.

import { env } from "~/lib/env"

export type StorageDelivery = "direct" | "relay"

type DeliveryEnv = Pick<
  typeof env,
  | "OBJECT_STORAGE_BROWSER_DIRECT"
  | "OBJECT_STORAGE_ENDPOINT"
  | "OBJECT_STORAGE_PUBLIC_URL"
  | "OBJECT_STORAGE_BUCKET"
  | "OBJECT_STORAGE_FORCE_PATH_STYLE"
>

/**
 * The one decision. A sealed attachment always relays: its bytes are read
 * chunk by chunk through the range route the crypto worker drives, and nothing
 * about that path changes with the store's reachability.
 */
export function storageDelivery(
  file: { sealed?: boolean } = {},
  e: Pick<DeliveryEnv, "OBJECT_STORAGE_BROWSER_DIRECT"> = env,
): StorageDelivery {
  if (file.sealed) return "relay"
  return e.OBJECT_STORAGE_BROWSER_DIRECT ? "direct" : "relay"
}

// The SDK addresses a bucket virtual-hosted (`<bucket>.<endpoint host>`) only
// when its name is a valid DNS label without dots; anything else, and every
// path-style client, puts the bucket in the path on the endpoint's own host.
const VIRTUAL_HOSTABLE_BUCKET = /^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/

/**
 * The origin presigned URLs point at, for the CSP and the bucket CORS rule, or
 * null when delivery is relayed (the browser never talks to the store).
 * OBJECT_STORAGE_PUBLIC_URL, when set, replaces the signed URL's host
 * (object-storage.ts rewritePublicHostFor), so it is the origin then.
 */
export function browserStorageOrigin(e: DeliveryEnv = env): string | null {
  if (storageDelivery({}, e) !== "direct") return null
  if (e.OBJECT_STORAGE_PUBLIC_URL) return new URL(e.OBJECT_STORAGE_PUBLIC_URL).origin
  const endpoint = new URL(e.OBJECT_STORAGE_ENDPOINT)
  if (e.OBJECT_STORAGE_FORCE_PATH_STYLE || !VIRTUAL_HOSTABLE_BUCKET.test(e.OBJECT_STORAGE_BUCKET)) {
    return endpoint.origin
  }
  endpoint.hostname = `${e.OBJECT_STORAGE_BUCKET}.${endpoint.hostname}`
  return endpoint.origin
}
