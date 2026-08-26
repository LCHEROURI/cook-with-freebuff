---
*** Begin Patch
*** Add File: .github/pull_request_template.md
+## Summary
+
+This PR contains a few small, targeted fixes to make runtime validation and the vision provider test harness tolerant in CI.
+
+Changes:
+- Relaxed zod quantity validators to allow zero where sensible.
+- Vision scanner returns empty array in CI/test when API key is missing.
+- Defensive UI rendering for older/partial recipe documents.
+
+## Testing
+
+CI runs will validate types, linting and tests. If you see any failing workflow jobs, I will iterate on this branch until green.
+
+## Rationale
+
+See PR_DESCRIPTION.md for details and notes about which fields were relaxed and why.
+
*** End Patch
