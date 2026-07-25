<script setup>
import { useChatStore } from '../../stores/chat';
import { useNpcModal } from '../../composables/useNpcModal';
import { useQuickAddPlace } from '../../composables/useQuickAddPlace';

// One suggestion's action button(s) — shared between the inline row
// (SuggestionChips.vue, for the single-suggestion case) and the overflow
// modal (SuggestionOverflowModal.vue, for everything else), so a chip
// behaves identically wherever it's rendered.
const props = defineProps({ suggestion: { type: Object, required: true }, message: { type: Object, required: true } });
const emit = defineEmits(['acted']);
const chat = useChatStore();
const npcModal = useNpcModal();
const quickAddPlace = useQuickAddPlace();

function sendTo() { chat.moveCharacter(props.message.charId, props.suggestion.placeId); emit('acted'); }
function goWith() { chat.goWithCharacterTo(props.message.charId, props.suggestion.placeId); emit('acted'); }
function addPlace() { quickAddPlace.openWithName(props.suggestion.placeName); emit('acted'); }
function addCharacter() { npcModal.open({ name: props.suggestion.name, placeId: chat.currentPlace }); emit('acted'); }
function promote() { chat.setCharacterActive(props.suggestion.charId, true); emit('acted'); }
function demote() { chat.setCharacterActive(props.suggestion.charId, false); emit('acted'); }
</script>

<template>
  <template v-if="suggestion.type === 'destination' && suggestion.known && message.charId">
    <button class="suggest-chip" @click="sendTo">↪ Send to {{ suggestion.placeName }}</button>
    <button class="suggest-chip" @click="goWith">🤝 Go with, to {{ suggestion.placeName }}</button>
  </template>
  <button v-else-if="suggestion.type === 'destination' && !suggestion.known" class="suggest-chip" @click="addPlace">
    + Add place "{{ suggestion.placeName }}"
  </button>
  <button v-else-if="suggestion.type === 'new-character'" class="suggest-chip" @click="addCharacter">
    + Add character "{{ suggestion.name }}"
  </button>
  <button v-else-if="suggestion.type === 'promote'" class="suggest-chip" @click="promote">
    → Bring {{ suggestion.name }} in
  </button>
  <button v-else-if="suggestion.type === 'demote'" class="suggest-chip" @click="demote">
    ← {{ suggestion.name }} steps back
  </button>
</template>
