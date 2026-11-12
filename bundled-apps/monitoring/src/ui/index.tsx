// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UI barrel — re-exports every component named in the manifest
// views/slots/detail so freeze-app's UI bundling resolves them by name.

export { MonitoringDashboard } from "./Dashboard"
export { IncidentDetailPanel } from "./IncidentDetail"
export { MonitoringAppIcon } from "./icon"
export { MonitoringSourcePage } from "./SourcePage"
export { MonitoringSources } from "./SourcesSettings"
export { MonitoringStatusList } from "./StatusList"
export { MonitoringSidebar } from "./sidebar"
export { resolveSourceTabLabel } from "./tab-labels"
