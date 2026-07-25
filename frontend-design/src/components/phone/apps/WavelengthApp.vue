<script setup>
import { computed } from 'vue';
import { useChatStore } from '../../../stores/chat';
import PhoneContacts from '../PhoneContacts.vue';

// Wavelength: RoamOS's calling app. Tapping a contact calls them directly
// (no separate "open thread, then hit Call" step) — bystanders in the
// user's current place get demoted for the call's duration, same as
// before; see stores/chat.js's startCall for the mechanics.
const emit = defineEmits(['back', 'call-started']);
const chat = useChatStore();

const canCall = computed(() => !!chat.currentPlace && !chat.activeCall && !chat.loading);

async function call(characterId) {
  if (!canCall.value) return;
  await chat.startCall(characterId);
  if (chat.activeCall) emit('call-started');
}
</script>

<template>
  <div class="phone-app-screen">
    <div class="phone-thread-header">
      <button class="phone-back" type="button" @click="emit('back')">‹ Home</button>
      <span class="phone-thread-name">Wavelength</span>
    </div>
    <p class="hint phone-app-hint" v-if="!chat.currentPlace">Enter a place before you can make a call.</p>
    <p class="hint phone-app-hint" v-else-if="chat.activeCall">Already on a call — hang up first.</p>
    <PhoneContacts @select="call">
      <template #trailing>
        <span class="phone-call-icon" :class="{ disabled: !canCall }">📞</span>
      </template>
    </PhoneContacts>
  </div>
</template>
