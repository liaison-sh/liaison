// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Security > Sign-in methods (settings overhaul S16, A22): how people in the
// organisation sign in, for org admins. The email sign-in link (display only:
// it works whenever this server can send email, and admins always have it),
// single sign-on providers, the Google client, and the rule that admins need a
// second factor. It replaced the Integrations, SSO Providers and Sign-in
// security pages.
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import AdminSignInSecuritySettings from "./AdminSignInSecuritySettings"
import { GoogleClientCard } from "./GoogleClientCard"
import { SettingsPageSection } from "./SettingsPageParts"
import SsoProviders from "./SsoProviders"

export const SIGN_IN_METHODS_SCOPE = "kernel:org:admin"

const SignInMethodsSection: Component = () => {
  const i18n = useI18n()
  return (
    <SettingsPageSection
      data-testid="security-sign-in-methods"
      title={i18n.t("kernel.settingsRegroup.signInMethods")}
      description={i18n.t("kernel.settingsRegroup.signInMethodsHelp")}
      scope="org"
    >
      <div class="flex flex-col gap-6">
        <div
          data-testid="sign-in-methods-email-link"
          class="flex min-h-11 items-start justify-between gap-4 rounded-lg border border-border bg-surface p-4"
        >
          <div class="flex flex-col gap-1">
            <span class="text-sm font-medium text-text">
              {i18n.t("kernel.settingsRegroup.emailLink")}
            </span>
            <span class="text-xs text-text-secondary">
              {i18n.t("kernel.settingsRegroup.emailLinkHelp")}
            </span>
          </div>
          <span class="shrink-0 rounded bg-surface-hover px-2 py-1 text-xs text-text-secondary">
            {i18n.t("kernel.settingsRegroup.emailLinkOn")}
          </span>
        </div>
        <div>
          <h3 class="mb-2 text-sm font-medium text-text">
            {i18n.t("kernel.settingsRegroup.ssoProviders")}
          </h3>
          <SsoProviders />
        </div>
        <GoogleClientCard />
        <AdminSignInSecuritySettings />
      </div>
    </SettingsPageSection>
  )
}

export default SignInMethodsSection
