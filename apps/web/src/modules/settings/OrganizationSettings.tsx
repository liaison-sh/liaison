// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Workspace > Organization (settings overhaul S16): the organisation's details,
// then Usage and limits (read only, kernel:org:admin), then Export your data, then Export organization (the whole-org archive,
// kernel:org:admin), then the import runs (Imports). The per-app export keeps
// its own scope (kernel:users:admin): an org admin without it does not see it.
import { type Component, Show } from "solid-js"
import { canAccessScope } from "~/modules/auth/auth-store"
import { useI18n } from "~/modules/i18n/i18n-context"
import AdminDataExport from "./AdminDataExport"
import AdminOrgSettings from "./AdminOrgSettings"
import ImportsSettings from "./imports/ImportsSettings"
import OrgExportSection from "./OrgExportSection"
import OrgUsageSection from "./OrgUsageSection"
import { SettingsPageHeader, SettingsPageSection } from "./SettingsPageParts"

export const DATA_EXPORT_SCOPE = "kernel:users:admin"
export const IMPORTS_READ_SCOPE = "kernel:imports:read"
export const ORG_EXPORT_SCOPE = "kernel:org:admin"

const OrganizationSettings: Component = () => {
  const i18n = useI18n()
  return (
    <div data-testid="organization-page">
      <SettingsPageHeader title={i18n.t("kernel.nav.section.org")} />
      <SettingsPageSection
        data-testid="organization-section-details"
        title={i18n.t("kernel.settingsRegroup.orgDetails")}
        scope="org"
      >
        <AdminOrgSettings />
      </SettingsPageSection>
      <Show when={canAccessScope(ORG_EXPORT_SCOPE)}>
        <SettingsPageSection
          data-testid="organization-section-usage"
          title={i18n.t("kernel.orgUsage.title")}
          scope="org"
        >
          <OrgUsageSection />
        </SettingsPageSection>
      </Show>
      <Show when={canAccessScope(DATA_EXPORT_SCOPE)}>
        <SettingsPageSection
          data-testid="organization-section-export"
          title={i18n.t("kernel.settingsRegroup.exportData")}
          description={i18n.t("kernel.settingsRegroup.exportDataHelp")}
          scope="org"
        >
          <AdminDataExport />
        </SettingsPageSection>
      </Show>
      <Show when={canAccessScope(ORG_EXPORT_SCOPE)}>
        <SettingsPageSection
          data-testid="organization-section-org-export"
          title={i18n.t("kernel.orgExport.title")}
          scope="org"
        >
          <OrgExportSection />
        </SettingsPageSection>
      </Show>
      <Show when={canAccessScope(IMPORTS_READ_SCOPE)}>
        <SettingsPageSection
          data-testid="organization-section-imports"
          title={i18n.t("kernel.imports.title")}
          description={i18n.t("kernel.imports.help")}
          scope="org"
        >
          <ImportsSettings />
        </SettingsPageSection>
      </Show>
    </div>
  )
}

export default OrganizationSettings
