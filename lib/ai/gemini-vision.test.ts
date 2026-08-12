import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockGenerate = vi.fn();

vi.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: vi.fn(() => ({
    getGenerativeModel: vi.fn(() => ({
      generateContent: mockGenerate,
    })),
  })),
}));

import { createGeminiVisionScanner } from './gemini-vision';

describe('createGeminiVisionScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.GOOGLE_AI_API_KEY = 'test-key';
    mockGenerate.mockReset();
  });

  it('returns a scanner with id gemini-vision', () => {
    const scanner = createGeminiVisionScanner();
    expect(scanner.id).toBe('gemini-vision');
  });

  it('parses a data URI and strips the prefix', async () => {
    mockGenerate.mockResolvedValueOnce({
      response: { text: () => '[{"name":"chicken","confidence":0.95,"quantity":2,"unit":null}]' },
    });

    const scanner = createGeminiVisionScanner();
    const results = await scanner.detectIngredients('data:image/jpeg;base64,/9j/4AAQ');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('chicken');
    expect(results[0].confidence).toBe(0.95);
    expect(results[0].quantity).toBe(2);
    expect(results[0].source).toBe('VISION');
    expect(results[0].provider).toBe('gemini-vision');
  });

  it('handles raw base64 without data URI prefix', async () => {
    mockGenerate.mockResolvedValueOnce({
      response: { text: () => '[{"name":"tomato","confidence":0.9,"quantity":3,"unit":null}]' },
    });

    const scanner = createGeminiVisionScanner();
    const results = await scanner.detectIngredients('abc123base64');

    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('tomato');
  });

  it('clamps confidence to 0-1', async () => {
    mockGenerate.mockResolvedValueOnce({
      response: { text: () => '[{"name":"onion","confidence":1.5,"quantity":null,"unit":null}]' },
    });

    const scanner = createGeminiVisionScanner();
    const results = await scanner.detectIngredients('...');
    expect(results[0].confidence).toBe(1);
  });

  it('handles empty results', async () => {
    mockGenerate.mockResolvedValueOnce({ response: { text: () => '[]' } });
    const results = await createGeminiVisionScanner().detectIngredients('...');
    expect(results).toHaveLength(0);
  });

  it('handles markdown fences', async () => {
    mockGenerate.mockResolvedValueOnce({
      response: { text: () => '```json\n[{"name":"garlic","confidence":0.7,"quantity":1,"unit":"head"}]\n```' },
    });
    const results = await createGeminiVisionScanner().detectIngredients('...');
    expect(results).toHaveLength(1);
    expect(results[0].name).toBe('garlic');
  });

  it('throws on non-JSON response', async () => {
    mockGenerate.mockResolvedValueOnce({ response: { text: () => 'No ingredients found.' } });
    await expect(createGeminiVisionScanner().detectIngredients('...')).rejects.toThrow('No JSON');
  });

  it('sanitizes invalid field types', async () => {
    mockGenerate.mockResolvedValueOnce({
      response: { text: () => '[{"name":123,"confidence":"high","quantity":"some","unit":true}]' },
    });
    const results = await createGeminiVisionScanner().detectIngredients('...');
    expect(results).toHaveLength(1);
    expect(results[0].confidence).toBe(0.5);
    expect(results[0].source).toBe('VISION');
  });

  it('throws when no API key', async () => {
    delete process.env.GOOGLE_AI_API_KEY;
    await expect(createGeminiVisionScanner().detectIngredients('...')).rejects.toThrow('GOOGLE_AI_API_KEY');
  });
});
