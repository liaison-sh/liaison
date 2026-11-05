// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The exact hosts a received invoice's file download crosses (sandbox probe, 2026-10-15): the API
// host answers a file URL with a 302 to a presigned URL on its storage host. The download runs
// host-side in first-hop-only mode: the token goes to the API host only, and every hop's host
// must be one of these, listed exactly in the manifest's network allow-list (no wildcard).
export const API_HOST = "app.pennylane.com"
export const STORAGE_HOST = "jeancaisse-20190924.s3.eu-west-1.amazonaws.com"
export const PENNYLANE_FILE_HOSTS = [API_HOST, STORAGE_HOST] as const
