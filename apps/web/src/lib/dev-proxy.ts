// SPDX-License-Identifier: FSL-1.1-ALv2
/**
 * What the Vite dev and preview servers forward to the API. In production one
 * origin serves the app and the API, so every URL the server prints from
 * `BASE_URL` (an API ticket inbox's ingest URL under `/webhooks`, which
 * `liaison tickets inbox create` and the inbox settings show) works as is; on a
 * dev checkout `BASE_URL` is this web server, so each of those prefixes must
 * be proxied here or the printed URL answers 404.
 */
export function devProxyFor(apiTarget: string) {
  return {
    "/api": { target: apiTarget, changeOrigin: true },
    "/healthz": { target: apiTarget, changeOrigin: true },
    "/webhooks": { target: apiTarget, changeOrigin: true },
    "/ws": { target: apiTarget, ws: true },
  }
}
