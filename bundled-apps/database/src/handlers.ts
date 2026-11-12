// SPDX-License-Identifier: FSL-1.1-ALv2
//
// Named-export barrel: every handler the manifest references (tools, the
// connect-event subscriber, the knowledge source, provisioning) appears here.
import { syncCatalogArticles } from "./knowledge"
import {
  provisionDatabase,
  reportAccessFindPeople,
  reportAccessGet,
  reportAccessSet,
} from "./report-access"
import { dbDescribe, dbListReads, dbProbe, dbQuery, dbRead, onDatabaseConnected } from "./tools"

export {
  dbDescribe,
  dbListReads,
  dbProbe,
  dbQuery,
  dbRead,
  onDatabaseConnected,
  provisionDatabase,
  reportAccessFindPeople,
  reportAccessGet,
  reportAccessSet,
  syncCatalogArticles,
}
