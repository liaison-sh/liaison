// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolveGoogleOAuthClientConfig } from "~/modules/settings/google-integration"
import calendarManifestJson from "./app.manifest.json"

// Calendar is a core app: its handlers.ts is a server module (modules/apps/core/registry.ts)
// that delegates to the host-side sync logic in plain `.ts` modules (sync.ts, tools.ts),
// reached through the app-id-gated `calendar_*` methods of
// apps/api/src/modules/apps/sandbox/rpc-bridge.ts, as `tickets_*` is.
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
