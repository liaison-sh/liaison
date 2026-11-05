// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UI barrel — re-exports every component named in the manifest
// views/tabTypes/detail/settings/activityBar so freeze-app's UI bundling
// resolves them by name.
export { SocialAppIcon } from "./icon"
export { SocialSidebar } from "./sidebar"
export { Findings, FindingDetailPanel } from "./Findings"
export { Messages, ConversationDetailPanel } from "./Messages"
export { Watched } from "./Watched"
export { SocialQuota } from "./Quota"
export { ContactSocialPanel } from "./ContactSocialPanel"
