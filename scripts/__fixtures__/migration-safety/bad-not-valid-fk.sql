-- SPDX-License-Identifier: FSL-1.1-ALv2
ALTER TABLE kernel.threads
  ADD CONSTRAINT threads_widget_run_fk FOREIGN KEY (widget_run_id) REFERENCES kernel.widget_runs(id) NOT VALID;
