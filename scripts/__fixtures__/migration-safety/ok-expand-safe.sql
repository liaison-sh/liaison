-- SPDX-License-Identifier: FSL-1.1-ALv2
SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- expand-safe: the previous release never writes widget_run_id, so the new key refuses none of its writes
ALTER TABLE kernel.threads
  ADD CONSTRAINT threads_widget_run_fk FOREIGN KEY (widget_run_id) REFERENCES kernel.widget_runs(id) NOT VALID;
