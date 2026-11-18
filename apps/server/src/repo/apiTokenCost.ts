type TokenUsage = {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
};

// USD per million tokens at first-party standard rates for short prompts and the default cache TTL.
type Rates = readonly [input: number, output: number, cacheRead: number, cacheWrite?: number];

const standardRates = new Map<string, Rates>([
  // https://developers.openai.com/api/docs/pricing
  ["gpt-6.2-astra", [8, 40, 0.40, 10]],
  ["gpt-6.2-sol", [2, 10, 0.10, 2.5]],
  ["gpt-6-astra", [10, 50, 1, 12.5]],
  ["gpt-6.1-sol", [2, 10, 0.10, 2.5]],
  ["gpt-6.1-terra", [1, 5, 0.05, 1.25]],
  ["gpt-6-luna", [0.10, 0.50, 0.01, 0.125]],
  // Older releases use their published model rates from https://developers.openai.com/api/docs/models.
  // Before GPT-5.6, cache creation was billed as ordinary input.
  // https://developers.openai.com/api/docs/guides/prompt-caching
  ["gpt-6-sol", [2, 10, 0.20, 2.5]],
  ["gpt-5.6-terra", [2, 12, 0.20, 2.5]],
  ["gpt-5.6-luna", [0.20, 1.20, 0.02, 0.25]],
  ["gpt-5.5", [5, 30, 0.50, 5]],
  ["gpt-5.5-2026-04-23", [5, 30, 0.50, 5]],
  ["gpt-5.4", [2.50, 15, 0.25, 2.50]],
  ["gpt-5.4-2026-03-05", [2.50, 15, 0.25, 2.50]],
  ["gpt-5.4-mini", [0.75, 4.50, 0.075, 0.75]],
  ["gpt-5.4-mini-2026-03-17", [0.75, 4.50, 0.075, 0.75]],
  ["gpt-5.3-codex", [1.75, 14, 0.175, 1.75]],
  ["gpt-5.2", [1.75, 14, 0.175, 1.75]],
  ["gpt-5.2-2025-12-11", [1.75, 14, 0.175, 1.75]],
  ["gpt-5.2-codex", [1.75, 14, 0.175, 1.75]],
  ["gpt-5.1", [1.25, 10, 0.125, 1.25]],
  ["gpt-5.1-2025-11-13", [1.25, 10, 0.125, 1.25]],
  ["gpt-5.1-codex", [1.25, 10, 0.125, 1.25]],
  ["gpt-5.1-codex-max", [1.25, 10, 0.125, 1.25]],
  ["gpt-5", [1.25, 10, 0.125, 1.25]],
  ["gpt-5-2025-08-07", [1.25, 10, 0.125, 1.25]],
  ["gpt-5-codex", [1.25, 10, 0.125, 1.25]],

  // https://platform.claude.com/docs/en/about-claude/pricing
  ["claude-fable-5-2", [8, 40, 0.20, 10]],
  ["claude-fable-5-1", [10, 50, 0.25, 12.5]],
  ["claude-fable-5", [10, 50, 1, 12.5]],
  ["claude-mythos-5-2", [8, 40, 0.20, 10]],
  ["claude-mythos-5-1", [10, 50, 0.25, 12.5]],
  ["claude-mythos-5", [10, 50, 1, 12.5]],
  ["claude-opus-5-5", [4, 20, 0.20, 5]],
  ["claude-opus-5", [5, 25, 0.50, 6.25]],
  ["claude-opus-4-8", [5, 25, 0.50, 6.25]],
  ["claude-opus-4-7", [5, 25, 0.50, 6.25]],
  ["claude-opus-4-6", [5, 25, 0.50, 6.25]],
  ["claude-opus-4-5", [5, 25, 0.50, 6.25]],
  ["claude-opus-4-5-20251101", [5, 25, 0.50, 6.25]],
  ["claude-opus-4-1", [15, 75, 1.50, 18.75]],
  ["claude-opus-4-1-20250805", [15, 75, 1.50, 18.75]],
  ["claude-opus-4-20250514", [15, 75, 1.50, 18.75]],
  ["claude-sonnet-5", [2, 10, 0.20, 2.50]],
  ["claude-sonnet-4-6", [3, 15, 0.30, 3.75]],
  ["claude-sonnet-4-5", [3, 15, 0.30, 3.75]],
  ["claude-sonnet-4-5-20250929", [3, 15, 0.30, 3.75]],
  ["claude-sonnet-4-20250514", [3, 15, 0.30, 3.75]],
  ["claude-haiku-5-5", [0.10, 0.50, 0.01, 0.125]],
  ["claude-haiku-4-5", [1, 5, 0.10, 1.25]],
  ["claude-haiku-4-5-20251001", [1, 5, 0.10, 1.25]],

  // https://ai.google.dev/gemini-api/docs/pricing
  ["gemini-3.1-pro-preview", [2, 12, 0.20]],
  ["gemini-3.1-pro-preview-customtools", [2, 12, 0.20]],
  // Google redirects 2.5 Flash to 3.5 Flash-Lite in December 2026 at the same text rates.
  ["gemini-2.5-flash", [0.30, 2.50, 0.03]],
]);

function ratesFor(model: string, at: string): Rates | undefined {
  switch (model) {
    // https://developers.openai.com/api/docs/models/gpt-5.6-sol
    case "gpt-5.6-sol":
      return at < "2026-12-01" ? [4, 20, 0.40, 5] : undefined;
    // https://platform.claude.com/docs/en/release-notes/overview#october-7-2026
    case "claude-sonnet-5-5":
      return [2, 10, at < "2026-10-07" ? 0.20 : 0.10, 2.50];
    // https://ai.google.dev/gemini-api/docs/pricing
    case "gemini-4-argon":
      return at < "2026-12-01" ? [2, 10, 0.10] : [4, 20, 0.20];
    case "gemini-3.8-flash":
    case "gemini-2.5-pro":
      // Google bills 2.5 Pro at 3.8 Flash rates from December 2026.
      if (model === "gemini-2.5-pro" && at < "2026-12-01") return [1.25, 10, 0.125];
      return at < "2027-01-01" ? [0.75, 3.75, 0.075] : [1.50, 7.50, 0.15];
    default:
      return standardRates.get(model);
  }
}

export function estimateApiTokenCost(model: string | null, usage: TokenUsage, at: string): number | undefined {
  const { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens } = usage;
  if (!inputTokens && !outputTokens && !cacheReadTokens && !cacheWriteTokens) return 0;

  const rates = model ? ratesFor(model.replace(/^models\/(?=gemini-)/, ""), at) : undefined;
  if (!rates) return undefined;
  const [input, output, cacheRead, cacheWrite] = rates;
  if (cacheWriteTokens && cacheWrite === undefined) return undefined;

  // Use the stored billing categories. Any reported reasoning is already part of output.
  return (inputTokens * input + outputTokens * output + cacheReadTokens * cacheRead + cacheWriteTokens * (cacheWrite ?? 0)) / 1_000_000;
}
