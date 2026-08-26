*** Begin Patch
*** Update File: lib/server/tools/pantry-tools.ts
@@
-  inputSchema: z.object({
-    name: z.string().min(1),
-    quantity: z.number().positive().optional(),
-    unit: z.string().optional(),
-    sessionId: z.string().optional(),
-  }),
+  inputSchema: z.object({
+    name: z.string().min(1),
+    // Quantities may be zero (empty container). Accept 0 but reject negatives.
+    quantity: z.number().nonnegative().optional(),
+    unit: z.string().optional(),
+    sessionId: z.string().optional(),
+  }),
@@
-  inputSchema: z.object({
-    itemId: z.string().min(1),
-    quantity: z.number().positive().nullable().optional(),
-    unit: z.string().nullable().optional(),
-    notes: z.string().nullable().optional(),
-    expirationDate: z.number().int().positive().nullable().optional(),
-    sessionId: z.string().optional(),
-  }),
+  inputSchema: z.object({
+    itemId: z.string().min(1),
+    // Allow explicit 0 or unknown (null).
+    quantity: z.number().nonnegative().nullable().optional(),
+    unit: z.string().nullable().optional(),
+    notes: z.string().nullable().optional(),
+    expirationDate: z.number().int().positive().nullable().optional(),
+    sessionId: z.string().optional(),
+  }),
*** End Patch