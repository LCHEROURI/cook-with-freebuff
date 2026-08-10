import { describe, it, expect } from 'vitest';
import { TOOL_DECLARATIONS } from './conversation';

type Declaration = {
  name: string;
  description?: string;
  parameters?: {
    type: string;
    properties?: Record<string, { type?: string | string[]; nullable?: boolean }>;
  };
};

const K8_TOOLS = [
  'get_pantry',
  'add_pantry_item',
  'update_pantry_item',
  'remove_pantry_item',
  'confirm_pantry_item',
  'confirm_pending_pantry_items',
  'get_dietary_profile',
  'update_dietary_profile',
];

describe('Gemini tool declarations (K8 surface)', () => {
  it('declares every pantry + dietary profile tool', () => {
    const names = TOOL_DECLARATIONS.map((t) => (t as Declaration).name);
    for (const tool of K8_TOOLS) {
      expect(names).toContain(tool);
    }
  });

  it('never uses union-type arrays in schemas (Gemini 2.5 rejects them)', () => {
    // Regression lock for the earlier "Proto field is not repeating" bug:
    // nullable fields must use `nullable: true`, never `type: ['number','null']`.
    const walk = (params: Declaration['parameters']): string[] => {
      if (!params?.properties) return [];
      return Object.values(params.properties).flatMap((prop) => {
        const found: string[] = [];
        if (Array.isArray(prop.type)) found.push(prop.type.join('|'));
        return found;
      });
    };
    const unionTypes = TOOL_DECLARATIONS.flatMap((t) => walk((t as Declaration).parameters));
    expect(unionTypes).toEqual([]);
  });
});
