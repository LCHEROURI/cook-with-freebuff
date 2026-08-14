// ============================================================================
// scripts/stub-server-only.mjs — make `server-only` a no-op outside Next.
//
// The server-only npm package THROWS when imported outside Next's bundler
// (its default export is a guard for client-component misuse). Next's own
// build handles it server-side, but the CLI scripts that import the server
// repository layer (e.g. scripts/cleanup-correlation-markers.ts) run under
// plain node + tsx, where the throw would break them. This preload patches
// Module._load so `import 'server-only'` resolves to an empty module — the
// same effect Next's server build applies — without touching anything else.
//
// Usage: node --import ./scripts/stub-server-only.mjs --import tsx <script>
// ============================================================================

import Module from 'node:module';

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === 'server-only') return {};
  return originalLoad.call(this, request, ...rest);
};
