// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UI barrel — re-exports every component named in the manifest
// views/tabTypes/detail/settings/activityBar by exact name so that
// registerAppFromManifest can resolve them (apps/web/src/framework/define-app.ts:403-407).
// Missing export → "UI export <name> not found" at install time.
export { MetaAdsIcon } from "./icon"
export { MetaAdsSidebar } from "./sidebar"
export { CampaignsTab, CampaignDetailPanel } from "./Campaigns"
export { AdsDashboard } from "./Dashboard"
export { GuideTab } from "./Guide"
export { AdsTab } from "./Ads"
export { AudiencesTab } from "./Audiences"
export { AdsAccountStatus } from "./AccountStatus"
