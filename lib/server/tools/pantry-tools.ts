*** Begin Patch
*** Update File: lib/server/tools/pantry-tools.ts
@@
-    quantity: z.number().positive().optional(),
+    // Quantities may be zero (empty container). Accept 0 but reject negatives.
+    quantity: z.number().nonnegative().optional(),
@@
-    quantity: z.number().positive().nullable().optional(),
+    // Allow explicit 0 or unknown (null).
+    quantity: z.number().nonnegative().nullable().optional(),
*** End Patch