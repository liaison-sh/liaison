// SPDX-License-Identifier: FSL-1.1-ALv2
import { resolveEnabledMailProviderOAuthClient } from "~/modules/mail/provider-settings"
import mailManifestJson from "./app.manifest.json"

// Deep-freeze the imported JSON. Bun caches JSON imports across the test
// process and the spread below is shallow — without the freeze, any test that
// mutates a nested field (e.g. `manifest.schema.conversations.fields.status.enum`)
// poisons subsequent registerApps validations across every test file.
function deepFreeze<T>(o: T): T {
  if (o && typeof o === "object" && !Object.isFrozen(o)) {
    Object.freeze(o)
    for (const k of Object.keys(o)) deepFreeze((o as Record<string, unknown>)[k])
  }
  return o
}

export const mailAppManifest = {
  ...deepFreeze(mailManifestJson),
  _format: "manifest" as const,
  _bundlePath: new URL("./handlers.ts", import.meta.url).pathname,
  _oauthClientResolvers: {
    gmail: async ({ orgId }: { orgId: string }) => {
      return await resolveEnabledMailProviderOAuthClient(orgId, "gmail")
    },
  },
}
