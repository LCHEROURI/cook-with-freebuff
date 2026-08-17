const NUMBER_WORDS: Array<[string, number]> = [
  ['twenty-four', 24],
  ['twenty four', 24],
  ['twenty-three', 23],
  ['twenty three', 23],
  ['twenty-two', 22],
  ['twenty two', 22],
  ['twenty-one', 21],
  ['twenty one', 21],
  ['twenty', 20],
  ['nineteen', 19],
  ['eighteen', 18],
  ['seventeen', 17],
  ['sixteen', 16],
  ['fifteen', 15],
  ['fourteen', 14],
  ['thirteen', 13],
  ['twelve', 12],
  ['eleven', 11],
  ['ten', 10],
  ['nine', 9],
  ['eight', 8],
  ['seven', 7],
  ['six', 6],
  ['five', 5],
  ['four', 4],
  ['three', 3],
  ['two', 2],
  ['one', 1],
];

function clampServings(n: number): number {
  return Math.min(24, Math.max(1, Math.floor(n)));
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseServings(text: string): number | null {
  const normalized = text.trim().toLowerCase();
  const digitMatch = normalized.match(/\b(\d+)\b/);
  if (digitMatch) return clampServings(Number(digitMatch[1]));

  for (const [word, value] of NUMBER_WORDS) {
    const pattern = new RegExp(`(?:^|[^a-z])${escapeRegExp(word)}(?:$|[^a-z])`, 'i');
    if (pattern.test(normalized)) return value;
  }

  return null;
}
