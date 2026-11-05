// SPDX-License-Identifier: FSL-1.1-ALv2
//
// A house packaging policy for tests: the carton ladder, stacking thresholds and nominal proforma
// value the resolver carried as constants before they became org data. The resolver's worked
// examples and the characterization golden are pinned against it.

import type { PackagingPolicy } from "../packaging-policy"

export const HOUSE_PACKAGING_POLICY: PackagingPolicy = {
  raw_stack_max_height: 16,
  cartons: [
    { max_stack_height: 22, length: 60, width: 40, height: 20, tare_weight: 0.5 },
    { max_stack_height: 26, length: 60, width: 40, height: 25, tare_weight: 0.5 },
    { max_stack_height: 38, length: 60, width: 40, height: 38, tare_weight: 1.0 },
  ],
  merge_leftovers_into_packs: true,
  pack_merge_height_allowance: 1,
  nominal_proforma_value_minor: 100,
  master_cartons: [],
}
