// SPDX-License-Identifier: FSL-1.1-ALv2
import type { ApiClient } from "~/lib/api-client"

/** The raster image types the avatar upload endpoint accepts. */
export const AVATAR_ACCEPT_MIME = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const
/** Value for a file input's `accept` attribute. */
export const AVATAR_ACCEPT_ATTR = AVATAR_ACCEPT_MIME.join(",")
/** Client-side guardrail mirroring the server's hard ceiling. */
export const AVATAR_MAX_UPLOAD_BYTES = 5 * 1024 * 1024

/** Shape returned by the avatar endpoints (a subset of the /users/me profile). */
export interface AvatarProfile {
  id: string
  name: string
  email: string
  avatarUrl?: string | null
}

/**
 * Upload a new profile picture. The File is sent as the raw request body — the
 * browser sets Content-Type from `file.type`. Returns the updated profile whose
 * `avatarUrl` is the new public capability URL.
 */
export function uploadAvatar(api: ApiClient, file: File): Promise<AvatarProfile> {
  return api.post<AvatarProfile>("/users/me/avatar", file)
}

/** Remove the profile picture, returning to the initials fallback. */
export function removeAvatar(api: ApiClient): Promise<AvatarProfile> {
  return api.delete<AvatarProfile>("/users/me/avatar")
}
