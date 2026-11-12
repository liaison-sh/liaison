// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UI barrel — re-exports every component named in the manifest
// views/tabTypes/detail/settings/activityBar so freeze-app's UI bundling
// resolves them by name.

export { ContactSocialPanel } from "./ContactSocialPanel"
export { FindingDetailPanel, Findings } from "./Findings"
export { SocialAppIcon } from "./icon"
export { ConversationDetailPanel, Messages } from "./Messages"
export { SocialQuota } from "./Quota"
export { SocialSidebar } from "./sidebar"
export { Watched } from "./Watched"
