<script setup>
import { computed } from 'vue';
import { useSuggestionOverflow } from '../../composables/useSuggestionOverflow';
import SuggestionButton from './SuggestionButton.vue';

const overflow = useSuggestionOverflow();

// Fixed display order rather than alphabetical — Conversation (who's
// talking right now) reads as the most immediately actionable, New
// (things that don't exist yet) as the least urgent.
const CATEGORY_ORDER = ['Conversation', 'Messaging', 'Movement', 'New'];
function categoryFor(s) {
  if (s.type === 'promote' || s.type === 'demote' || s.type === 'call-to-scene') return 'Conversation';
  if (s.type === 'text-someone' || s.type === 'scheduled-text') return 'Messaging';
  if (s.type === 'destination' && s.known) return 'Movement';
  return 'New'; // unknown destination, new-character
}

const groups = computed(() => {
  const msg = overflow.message.value;
  if (!msg) return [];
  const byCategory = {};
  (msg.suggestions || []).forEach((s) => {
    const cat = categoryFor(s);
    (byCategory[cat] = byCategory[cat] || []).push(s);
  });
  return CATEGORY_ORDER.filter((c) => byCategory[c]).map((c) => ({ label: c, items: byCategory[c] }));
});
</script>

<template>
  <div
    class="modal-overlay suggest-overlay" v-if="overflow.isOpen.value"
    @click="(e) => { if (e.target === e.currentTarget) overflow.close(); }"
  >
    <div class="modal suggest-modal">
      <h2>Suggestions</h2>
      <div class="suggest-group" v-for="g in groups" :key="g.label">
        <div class="suggest-group-label">{{ g.label }}</div>
        <div class="suggest-group-items">
          <SuggestionButton
            v-for="(s, i) in g.items" :key="i" :suggestion="s" :message="overflow.message.value"
            @acted="overflow.close()"
          />
        </div>
      </div>
      <button class="btn secondary small" @click="overflow.close()">Close</button>
    </div>
  </div>
</template>
