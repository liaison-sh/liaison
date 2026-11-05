// SPDX-License-Identifier: FSL-1.1-ALv2
//
// THE STEPS A CLIENT CARD SHOWS.
//
// A client card (`oauth_client`, `google_integration_client`) asks for an
// OAuth client the person first creates at the provider. The card shows how,
// as numbered steps with the values to copy (redirect URIs, scopes, commands).
// This is the one place the card's steps come from:
//
//   google    the Google client (Gmail, Calendar, any Google connection): the
//             computed setup values of this deployment and its apps that are
//             on (setup-guides/google.ts); the card renders them with the
//             shared `googleSetupGuide` in the viewer's language
//   shopify   the Shopify store connection: the app's settings (URLs, scopes,
//             API version, from the same generator as shopify.app.toml),
//             rendered with the shared `shopifyDashboardGuide` (Dev Dashboard)
//   app       any other connection: its manifest's own `setupGuide`
//
// Values, never rendered text: the card renders them with its own `t()`, the
// agent reads the same steps through `kernel__google_setup`. Nothing secret
// ever goes in a guide: it is shown to everyone who can see the conversation.

import type { GoogleSetupValues, ShopifyDashboardValues } from "@liaison/shared"
import { oauthRedirectBaseUrl, orgPublicBaseUrl } from "~/lib/org-public-url"
import { connectionConfigRegistry } from "~/modules/apps/app-registries"
import { ensureAppsForOrg } from "~/modules/apps/init"
import {
  connectionSetupExtraSteps,
  setupStepMarkdown,
} from "~/modules/connection-guides/connection-setup"
import { computeGoogleSetupValues, isGoogleConnection } from "~/modules/connection-guides/google"
import { appConnectionSetup, shopifyOptedInProtectedScopes } from "~/modules/connection-guides/plan"
import { shopifyAppValues } from "~/modules/connection-guides/shopify-app-toml"
import type { SecretTarget } from "~/modules/secret-requests/targets"

/** Setup steps shown on a client card, above its form. */
export type SecretRequestGuide =
  | { provider: "google"; values: GoogleSetupValues }
  | { provider: "shopify"; values: ShopifyDashboardValues }
  | { provider: "app"; summary?: string; steps: string[]; docsUrl?: string }

/** Whether a connection signs in at a Shopify store (its authorize URL is per store). */
function isShopifyConnection(app: string, authorizationUrl: string | undefined): boolean {
  return app === "shopify" || (authorizationUrl ?? "").includes(".myshopify.com")
}

/** The steps for this card, or null when it shows none. */
export async function clientCardGuide(
  orgId: string,
  target: SecretTarget,
): Promise<SecretRequestGuide | null> {
  if (target.kind !== "oauth_client" && target.kind !== "google_integration_client") return null
  await ensureAppsForOrg(orgId)
  if (target.kind === "google_integration_client") {
    return { provider: "google", values: computeGoogleSetupValues(orgId) }
  }
  const config = connectionConfigRegistry.get([orgId, target.app, target.connection])
  if (!config) return null
  if (isGoogleConnection(config)) {
    return { provider: "google", values: computeGoogleSetupValues(orgId) }
  }
  if (isShopifyConnection(target.app, config.authorizationUrl)) {
    return {
      provider: "shopify",
      values: {
        // A client card collects a client the person creates (none yet, or their
        // own in place of the instance's): the full steps, never the connect-only guide.
        clientSource: "none",
        // The scopes the app's configuration must list: a protected scope the org
        // opted in to is granted only when the released configuration names it.
        ...shopifyAppValues(
          await orgPublicBaseUrl(orgId),
          config,
          oauthRedirectBaseUrl(),
          await shopifyOptedInProtectedScopes(orgId, config),
        ),
      },
    }
  }
  // The manifest's steps, then the values the code fixes (redirect URI,
  // scopes, webhook URLs): the same lines `liaison guide <app>/<connection>` prints.
  const setup = await appConnectionSetup(orgId, target.app, target.connection)
  if (!setup) return null
  const steps = [...setup.steps, ...connectionSetupExtraSteps(setup, "card")].map(setupStepMarkdown)
  if (steps.length === 0 && !setup.summary) return null
  return {
    provider: "app",
    ...(setup.summary ? { summary: setup.summary } : {}),
    steps,
    ...(setup.docsUrl ? { docsUrl: setup.docsUrl } : {}),
  }
}
