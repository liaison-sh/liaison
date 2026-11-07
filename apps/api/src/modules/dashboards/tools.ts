// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's dashboard tools (dashboards_create, _update, _get, _list,
// _delete, _preview_block) over kernel.dashboards. Registered once per org
// from agent/tools/kernel-tools.ts; the tools land with their own change, so
// this hook registers nothing yet.

/** Registers the kernel's dashboard tools for `orgId`. */
export function registerDashboardTools(_orgId: string): void {}
