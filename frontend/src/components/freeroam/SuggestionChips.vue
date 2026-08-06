<script setup>
import { computed } from 'vue';
import { useChatStore } from '../../stores/chat';
import { useSuggestionOverflow } from '../../composables/useSuggestionOverflow';
import SuggestionButton from './SuggestionButton.vue';

// Suggestion chips from the backend's reading of the reply (regex/ML, or
// 'llm' mode's sidecar call — see settings) — a best-effort nudge, not a
// guarantee, so every chip is just a shortcut to an action the user could
// already do manually. A single suggestion renders inline as before; more
// than one collapses to a single "N suggestions" button that opens the
// grouped overflow modal — a message can carry several suggestions at
// once, and a row of 5+ chips wrapping across lines was worse than one
// tap-through button.
const props = defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();
const overflow = useSuggestionOverflow();

const suggestions = computed(() => props.message.suggestions || []);
const isOverflow = computed(() => suggestions.value.length > 1);
</script>

<template>
  <div
    class="suggest-row"
    v-if="suggestions.length && !chat.dismissedSuggestionIds.has(message.id)"
  >
    <template v-if="!isOverflow">
      <SuggestionButton v-for="(s, i) in suggestions" :key="i" :suggestion="s" :message="message" />
    </template>
    <button v-else class="suggest-chip suggest-more" @click="overflow.open(message)">
      {{ suggestions.length }} suggestions…
    </button>
    <button class="suggest-dismiss" title="Dismiss" @click="chat.dismissSuggestion(message.id)">✕</button>
  </div>
</template>
