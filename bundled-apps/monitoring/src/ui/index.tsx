// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UI barrel — re-exports every component named in the manifest
// views/slots/detail so freeze-app's UI bundling resolves them by name.
export { MonitoringAppIcon } from "./icon"
export { MonitoringSidebar } from "./sidebar"
export { MonitoringDashboard } from "./Dashboard"
export { IncidentDetailPanel } from "./IncidentDetail"
export { MonitoringSourcePage } from "./SourcePage"
export { MonitoringStatusList } from "./StatusList"
export { resolveSourceTabLabel } from "./tab-labels"
export { MonitoringSources } from "./SourcesSettings"
