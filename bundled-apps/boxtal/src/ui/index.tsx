// SPDX-License-Identifier: FSL-1.1-ALv2
//
// UI barrel — re-exports every component named in the manifest
// views/slots/detail so freeze-app's UI bundling resolves them by name.
export { BoxtalAppIcon } from "./icon"
export { BoxtalSidebar } from "./sidebar"
export { BoxtalShipmentTab } from "./BoxtalShipmentTab"
export { Shipments, ShipmentDetailPanel } from "./Shipments"
export { BoxtalQueue, ReadyToShip } from "./Queues"
export { PrepGrid } from "./PrepGrid"
export { Returns } from "./Returns"
export { Catalog } from "./Catalog"
export { CreateDraft } from "./CreateDraft"
