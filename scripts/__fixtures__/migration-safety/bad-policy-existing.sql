-- SPDX-License-Identifier: FSL-1.1-ALv2
CREATE POLICY threads_extra ON kernel.threads FOR SELECT TO liaison_rls USING (true);
