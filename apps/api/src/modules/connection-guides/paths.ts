// SPDX-License-Identifier: FSL-1.1-ALv2
/** The OAuth callback paths under BASE_URL, as the flows build them (drift-tested in google.test.ts). */

/** Where every app connection returns (connections/service.ts). */
export const CONNECTIONS_CALLBACK_PATH = "/api/connections/callback"
/** Where Google sign-in to Liaison returns (auth/oauth-routes.ts). */
export const SIGN_IN_CALLBACK_PATH = "/api/auth/oauth/callback"
