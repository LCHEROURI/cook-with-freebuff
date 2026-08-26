*** Begin Patch
*** Update File: lib/domain/schemas.ts
@@
   pendingPantryItems: z
     .array(z.object({
       itemId: z.string().min(1),
       name: z.string().min(1),
-      quantity: z.number().positive().optional(),
+      // Pending pantry items may be declared with zero quantity (placeholders).
+      // Accept 0 while still rejecting negative values.
+      quantity: z.number().nonnegative().optional(),
       unit: z.string().optional(),
     }))
     .optional(),
*** End Patch