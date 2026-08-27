*** Begin Patch
*** Update File: lib/domain/schemas.ts
@@
 export const pantryItemSchema = z.object({
   id: z.string().min(1),
   userId: z.string().min(1),
   name: z.string().min(1),
-  quantity: z.number().positive().optional(),
+  // Pantry quantities can be zero (empty container). Accept 0 but reject negatives.
+  quantity: z.number().nonnegative().optional(),
   unit: z.string().optional(),
   confidence: z.number().min(0).max(1),
   source: pantryItemSourceSchema,
   lastConfirmedAt: z.number().int().positive(),
   expirationDate: z.number().int().positive().optional(),
   notes: z.string().optional(),
 });
@@
 export const groceryItemSchema = z.object({
   id: z.string().min(1),
   userId: z.string().min(1),
   name: z.string().min(1),
-  quantity: z.number().positive().optional(),
+  // Grocery-list quantities may be zero in edge cases; allow 0.
+  quantity: z.number().nonnegative().optional(),
   unit: z.string().optional(),
   source: groceryItemSourceSchema,
   status: groceryItemStatusSchema,
   pantryItemId: z.string().optional(),
   createdAt: z.number().int().positive(),
   updatedAt: z.number().int().positive(),
 });
*** End Patch