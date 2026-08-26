*** Begin Patch
*** Update File: lib/server/tools/grocery-tools.ts
@@
   inputSchema: z.object({
-    name: z.string().min(1).max(200),
-    quantity: z.number().positive().optional(),
-    unit: z.string().max(50).optional(),
+    name: z.string().min(1).max(200),
+    // Grocery-list quantities may be zero in edge cases; allow 0.
+    quantity: z.number().nonnegative().optional(),
+    unit: z.string().max(50).optional(),
   }),
*** End Patch