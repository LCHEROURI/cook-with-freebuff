*** Begin Patch
*** Update File: lib/domain/schemas.ts
@@
-  quantity: z.number().positive().optional(),
+  // Pantry quantities can be zero (empty container). Accept 0 but reject negatives.
+  quantity: z.number().nonnegative().optional(),
   unit: z.string().optional(),
@@
-  quantity: z.number().positive().optional(),
+  // Grocery-list quantities may be zero in edge cases; allow 0.
+  quantity: z.number().nonnegative().optional(),
   unit: z.string().optional(),
*** End Patch