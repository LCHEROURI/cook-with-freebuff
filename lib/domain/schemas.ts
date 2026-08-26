---
*** Begin Patch
*** Update File: lib/domain/schemas.ts
@@
-  quantity: z.number().positive().nullable(),
+  // Quantities may be zero (explicitly measured as 0) or unknown (null).
+  // Use nonnegative to accept 0 while still rejecting negative values.
+  quantity: z.number().nonnegative().nullable(),
@@
-      quantity: z.number().positive().optional(),
+      // Pending pantry items may be declared with zero quantity in some
+      // workflows (e.g. placeholders). Accept zero values.
+      quantity: z.number().nonnegative().optional(),
@@
-  quantity: z.number().positive().optional(),
+  // Pantry quantities can be zero (empty container). Accept nonnegative.
+  quantity: z.number().nonnegative().optional(),
@@
-  quantity: z.number().positive().optional(),
+  // Grocery-list quantities may be zero in edge cases; allow 0.
+  quantity: z.number().nonnegative().optional(),
*** End Patch
