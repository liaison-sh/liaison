// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolveGoogleOAuthClientConfig } from "~/modules/settings/google-integration"
import calendarManifestJson from "./app.manifest.json"

// Calendar is a `trusted: true` app (mirrors tickets — it owns real UI + schema + entities).
// Its handlers.ts stays a thin sandboxed QuickJS delegator; host-side sync logic lives in
// plain host `.ts` modules exposed as app-id-gated `calendar_*` methods hand-added to the
// shared apps/api/src/modules/apps/sandbox/rpc-bridge.ts, exactly as `tickets_*` is.
export const calendarAppManifest = {
  ...calendarManifestJson,
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
  // Reuse the shared Gmail/Tickets OAuth client (org override -> GMAIL_OAUTH_CLIENT_ID/SECRET
  // env fallback) -- NOT a dedicated GOOGLE_CALENDAR_* env pair. Keyed on the `google-calendar`
  // connection name, exactly as tickets keys its resolver on `gmail`.
  _oauthClientResolvers: {
    "google-calendar": async ({ orgId }: { orgId: string }) =>
      resolveGoogleOAuthClientConfig(orgId),
  },
}
