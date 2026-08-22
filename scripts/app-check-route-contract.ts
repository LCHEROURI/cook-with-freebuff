export interface QuotaRouteContract {
  route: string;
  method: 'POST';
  attestation: 'standard' | 'single-use';
  gate: string;
  quotaBoundary: string;
  purpose: string;
}

export const QUOTA_ROUTE_CONTRACTS = [
  {
    route: 'app/api/agent/route.ts',
    method: 'POST',
    attestation: 'standard',
    gate: 'await gateAppCheck(req)',
    quotaBoundary: 'getConversationAgent()',
    purpose: 'Conversation-agent turns can invoke Gemini and state tools.',
  },
  {
    route: 'app/api/cook/route.ts',
    method: 'POST',
    attestation: 'standard',
    gate: 'await gateAppCheck(req)',
    quotaBoundary: 'await handle(userId, body)',
    purpose: 'The create_recipe action can invoke the recipe generator.',
  },
  {
    route: 'app/api/tools/route.ts',
    method: 'POST',
    attestation: 'standard',
    gate: 'await gateAppCheck(req)',
    quotaBoundary: 'await executeTool(',
    purpose: 'Direct tool dispatch includes quota-bearing AI tools.',
  },
  {
    route: 'app/api/vision/scan/route.ts',
    method: 'POST',
    attestation: 'single-use',
    gate: 'await gateAppCheck(req, { consume: true })',
    quotaBoundary: 'await scanner.detectIngredients(',
    purpose: 'Each image scan invokes the Gemini vision provider.',
  },
  {
    route: 'app/api/voice/token/route.ts',
    method: 'POST',
    attestation: 'single-use',
    gate: 'await gateAppCheck(req, { consume: true })',
    quotaBoundary: 'await fetch(MINT_URL',
    purpose: 'Each request mints an upstream Gemini Live session token.',
  },
] as const satisfies readonly QuotaRouteContract[];
