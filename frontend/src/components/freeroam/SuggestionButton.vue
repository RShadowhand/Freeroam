<script setup>
import { useChatStore } from '../../stores/chat';
import { usePhoneStore } from '../../stores/phone';
import { useNpcModal } from '../../composables/useNpcModal';
import { useQuickAddPlace } from '../../composables/useQuickAddPlace';

// One suggestion's action button(s) — shared between the inline row
// (SuggestionChips.vue, for the single-suggestion case) and the overflow
// modal (SuggestionOverflowModal.vue, for everything else), so a chip
// behaves identically wherever it's rendered.
const props = defineProps({ suggestion: { type: Object, required: true }, message: { type: Object, required: true } });
const emit = defineEmits(['acted']);
const chat = useChatStore();
const phone = usePhoneStore();
const npcModal = useNpcModal();
const quickAddPlace = useQuickAddPlace();

function sendTo() { chat.moveCharacter(props.message.charId, props.suggestion.placeId); emit('acted'); }
function goWith() { chat.goWithCharacterTo(props.message.charId, props.suggestion.placeId); emit('acted'); }
function addPlace() { quickAddPlace.openWithName(props.suggestion.placeName); emit('acted'); }
function addCharacter() { npcModal.open({ name: props.suggestion.name, placeId: chat.currentPlace }); emit('acted'); }
function promote() { chat.setCharacterActive(props.suggestion.charId, true); emit('acted'); }
function demote() { chat.setCharacterActive(props.suggestion.charId, false); emit('acted'); }
// call-to-scene reuses the same "send this character here" primitive
// destination suggestions use, just aimed at the *current* place instead of
// a chip-supplied one — moving the beckoned character to wherever this chip
// was clicked. text-someone splits by target: a character-target opens
// their phone thread (never auto-writes on the user's behalf); a
// persona-target means the SPEAKER promised to text the user, so the chip
// makes good on the promise via the existing proactive-text trigger
// (phone.triggerText → POST /api/texts/:id/trigger) — fire-and-forget, the
// unread badge signals arrival like any other proactive text.
function callToScene() { chat.moveCharacter(props.suggestion.charId, chat.currentPlace); emit('acted'); }
function openThread() { phone.openConversation(props.suggestion.charId); emit('acted'); }
function textMe() { phone.triggerText(props.message.charId, props.suggestion.summary || null); emit('acted'); }
// Stores the promise server-side; it fires as a real proactive text (with
// the suggestion's reason steering content) once world time reaches the
// scheduled day/timeOfDay. The SPEAKER sends it, hence message.charId.
function scheduleIt() {
  phone.scheduleText({
    characterId: props.message.charId,
    day: props.suggestion.day,
    timeOfDay: props.suggestion.timeOfDay,
    reason: props.suggestion.reason || '',
  });
  emit('acted');
}
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
  <button v-else-if="suggestion.type === 'call-to-scene'" class="suggest-chip" @click="callToScene">
    → Bring {{ suggestion.name }} here
  </button>
  <button v-else-if="suggestion.type === 'text-someone' && suggestion.targetKind === 'character' && suggestion.charId" class="suggest-chip" @click="openThread">
    💬 Open chat with {{ suggestion.targetName }}
  </button>
  <button v-else-if="suggestion.type === 'text-someone' && suggestion.targetKind === 'persona' && message.charId" class="suggest-chip" @click="textMe">
    💬 Have {{ message.name || 'them' }} send that text
  </button>
  <button
    v-else-if="suggestion.type === 'scheduled-text' && suggestion.targetKind === 'persona' && message.charId"
    class="suggest-chip" @click="scheduleIt"
  >
    🕐 Text arrives {{ suggestion.timeOfDay }}, day {{ suggestion.day }} — schedule it
  </button>
  <span v-else-if="suggestion.type === 'scheduled-text'" class="suggest-chip suggest-chip-info">
    🕐 {{ suggestion.targetName }} — {{ suggestion.timeOfDay }} (day {{ suggestion.day }})
  </span>
</template>
