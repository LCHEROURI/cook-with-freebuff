*** Begin Patch
*** Update File: lib/server/tools/grocery-tools.ts
@@
-    quantity: z.number().positive().optional(),
+    // Grocery-list quantities may be zero in edge cases; allow 0.
+    quantity: z.number().nonnegative().optional(),
*** End Patch