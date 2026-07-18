<script setup>
import { computed } from 'vue';

// Per-message generation stats — tokens, tokens/sec, total time (and time
// to first token when the endpoint reported it), reasoning tokens broken
// out from the answer when available. Any field the endpoint didn't report
// is just omitted rather than showing a misleading 0 or "NaN".
const props = defineProps({ stats: { type: Object, default: null } });

const parts = computed(() => {
  const s = props.stats;
  if (!s) return [];
  const out = [];
  if (s.completionTokens != null) {
    const reasoningNote = s.reasoningTokens ? ` (${s.reasoningTokens} reasoning + ${s.completionTokens - s.reasoningTokens} answer)` : '';
    out.push(`${s.completionTokens} tok${reasoningNote}`);
  }
  if (s.tokensPerSec != null) out.push(`${s.tokensPerSec} tok/s`);
  if (s.totalMs != null) out.push(`${(s.totalMs / 1000).toFixed(1)}s total`);
  if (s.ttftMs != null) out.push(`${(s.ttftMs / 1000).toFixed(1)}s to first token`);
  return out;
});
</script>

<template>
  <div class="msg-stats" title="Generation stats" v-if="parts.length">{{ parts.join(' · ') }}</div>
</template>
