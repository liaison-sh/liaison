// SPDX-License-Identifier: FSL-1.1-ALv2
//
// AI > Agent behavior (settings overhaul S16): how agents treat what they read,
// for everyone in the organisation. Two sections on one page: Outside content
// (the web content protection level) and Media analysis (which attachments
// agents look inside). They were the Agent safety and Media analysis pages.
import type { Component } from "solid-js"
import { useI18n } from "~/modules/i18n/i18n-context"
import AdminAgentSafetySettings from "./AdminAgentSafetySettings"
import AdminMediaAnalysisSettings from "./AdminMediaAnalysisSettings"
import { SettingsPageHeader, SettingsPageSection } from "./SettingsPageParts"

const AgentBehaviorSettings: Component = () => {
  const i18n = useI18n()
  return (
    <div data-testid="agent-behavior-page">
      <SettingsPageHeader
        title={i18n.t("kernel.nav.section.agentBehavior")}
        intro={i18n.t("kernel.settingsRegroup.agentBehaviorIntro")}
      />
      <SettingsPageSection
        data-testid="agent-behavior-section-outside"
        title={i18n.t("kernel.settingsRegroup.outsideContent")}
        description={i18n.t("kernel.settingsRegroup.outsideContentHelp")}
        scope="org"
      >
        <AdminAgentSafetySettings />
      </SettingsPageSection>
      <SettingsPageSection
        data-testid="agent-behavior-section-media"
        title={i18n.t("kernel.settingsRegroup.mediaAnalysis")}
        description={i18n.t("kernel.settingsRegroup.mediaAnalysisHelp")}
        scope="org"
      >
        <AdminMediaAnalysisSettings />
      </SettingsPageSection>
    </div>
  )
}

export default AgentBehaviorSettings
