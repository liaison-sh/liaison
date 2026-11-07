// SPDX-License-Identifier: FSL-1.1-ALv2
//
// The agent's data store tools (data_collections_list, data_query, data_get,
// data_set, data_update, data_delete) over modules/data-store/service.ts.
// Registered once per org from agent/tools/kernel-tools.ts; the tools land
// with their own change, so this hook registers nothing yet.

/** Registers the kernel's data store tools for `orgId`. */
export function registerDataStoreTools(_orgId: string): void {}
