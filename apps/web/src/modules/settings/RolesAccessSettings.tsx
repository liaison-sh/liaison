// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Workspace > Roles & access (settings overhaul S16, prototype v2.1 S-ROLES):
// what each role can do, who is asking for more, and which records each role
// can see, as three sections of one page. A role's own page stays at
// /settings/admin/roles/<id>. It joined the former Roles & Scopes, Access
// requests and Team & Permissions pages. Access requests keep their own
// scope (kernel:scope_requests:admin).
import { type Component, Show } from "solid-js"
import AdminScopeRequests from "~/modules/admin-scope-requests/AdminScopeRequests"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import AdminRoles from "./AdminRoles"
import DimensionGrantPage from "./dimension-grants/DimensionGrantPage"
import { SettingsPageHeader, SettingsPageSection } from "./SettingsPageParts"

export const ACCESS_REQUESTS_SCOPE = "kernel:scope_requests:admin"

const RolesAccessSettings: Component = () => {
  const i18n = useI18n()
  return (
    <div data-testid="roles-access-page">
      <SettingsPageHeader
        title={i18n.t("kernel.nav.section.rolesAccess")}
        intro={i18n.t("kernel.settingsRegroup.rolesAccessIntro")}
      />
      <SettingsPageSection
        data-testid="roles-access-section-roles"
        title={i18n.t("kernel.settingsRegroup.roles")}
        description={i18n.t("kernel.settingsRegroup.rolesHelp")}
        scope="org"
      >
        <AdminRoles />
      </SettingsPageSection>
      <Show when={canAccessScope(ACCESS_REQUESTS_SCOPE)}>
        <SettingsPageSection
          data-testid="roles-access-section-requests"
          title={i18n.t("kernel.settingsRegroup.accessRequests")}
          description={i18n.t("kernel.settingsRegroup.accessRequestsHelp")}
          scope="org"
        >
          <AdminScopeRequests />
        </SettingsPageSection>
      </Show>
      <SettingsPageSection
        data-testid="roles-access-section-data"
        title={i18n.t("kernel.settingsRegroup.dataAccess")}
        description={i18n.t("kernel.settingsRegroup.dataAccessHelp")}
        scope="org"
      >
        <DimensionGrantPage />
      </SettingsPageSection>
    </div>
  )
}

export default RolesAccessSettings
