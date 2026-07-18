<script setup>
import { useChatStore } from '../../stores/chat';
import { useNpcModal } from '../../composables/useNpcModal';
import { useQuickAddPlace } from '../../composables/useQuickAddPlace';

// Suggestion chips from the backend's local (regex/ML, no extra LLM call)
// reading of the reply — a best-effort nudge, not a guarantee, so every
// chip is just a shortcut to an action the user could already do manually.
const props = defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();
const npcModal = useNpcModal();
const quickAddPlace = useQuickAddPlace();
</script>

<template>
  <div
    class="suggest-row"
    v-if="message.suggestions?.length && !chat.dismissedSuggestionIds.has(message.id)"
  >
    <template v-for="(s, i) in message.suggestions" :key="i">
      <template v-if="s.type === 'destination' && s.known && message.charId">
        <button class="suggest-chip" @click="chat.moveCharacter(message.charId, s.placeId)">↪ Send to {{ s.placeName }}</button>
        <button class="suggest-chip" @click="chat.goWithCharacterTo(message.charId, s.placeId)">🤝 Go with, to {{ s.placeName }}</button>
      </template>
      <button
        v-else-if="s.type === 'destination' && !s.known" class="suggest-chip"
        @click="quickAddPlace.openWithName(s.placeName)"
      >+ Add place "{{ s.placeName }}"</button>
      <button
        v-else-if="s.type === 'new-character'" class="suggest-chip"
        @click="npcModal.open({ name: s.name, placeId: chat.currentPlace })"
      >+ Add character "{{ s.name }}"</button>
    </template>
    <button class="suggest-dismiss" title="Dismiss" @click="chat.dismissSuggestion(message.id)">✕</button>
  </div>
</template>
