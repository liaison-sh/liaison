// SPDX-License-Identifier: FSL-1.1-ALv2
//
// S3: an app declares the host API range it needs (`host`, "^1" when absent).
// Install, upgrade and registration refuse an app whose range this server's
// host API version does not satisfy, with one message that says what to do.
import { DEFAULT_HOST_API_RANGE, HOST_API_VERSION } from "@liaison/host"

interface HostRangeManifest {
  name: string
  version: string
  host?: string
}

/** Why this server cannot run the app, or null when its host range is satisfied. */
export function hostApiIncompatibility(manifest: HostRangeManifest): string | null {
  const range = manifest.host ?? DEFAULT_HOST_API_RANGE
  if (Bun.semver.satisfies(HOST_API_VERSION, range)) return null
  return `${manifest.name} ${manifest.version} needs host API ${range}; this server provides host API ${HOST_API_VERSION}. Update Liaison first.`
}

/** Throw the S3 message when this server cannot satisfy the app's host range. */
export function assertHostApiCompatible(manifest: HostRangeManifest): void {
  const problem = hostApiIncompatibility(manifest)
  if (problem) throw new Error(problem)
}
