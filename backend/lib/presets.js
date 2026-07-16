// Mirrors SillyTavern's openai_max_context / openai_max_tokens — the total
// context window budget and the reply token reservation. The frontend
// (frontend/lib/context.mjs) uses these to decide how much chat history
// fits alongside the system prompt; this module just normalizes/validates
// what's stored per preset.
export const DEFAULT_CONTEXT_LENGTH = 8192;
export const DEFAULT_MAX_REPLY_TOKENS = 1000;

export function normalizeContextNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

export function normalizePromptList(prompts) {
  if (!Array.isArray(prompts)) return [];
  return prompts.map((p, i) => ({
    identifier: typeof p.identifier === 'string' && p.identifier.trim() ? p.identifier.trim() : `prompt-${i}`,
    name: typeof p.name === 'string' && p.name.trim() ? p.name.trim() : `Prompt ${i + 1}`,
    role: ['system', 'user', 'assistant'].includes(p.role) ? p.role : 'system',
    content: typeof p.content === 'string' ? p.content : '',
    marker: !!p.marker,
    enabled: p.enabled !== false,
  }));
}
