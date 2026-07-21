<script setup>
import { ref } from 'vue';
import PhoneHeader from './PhoneHeader.vue';
import PhoneContacts from './PhoneContacts.vue';
import PhoneThread from './PhoneThread.vue';

// Right column of the Freeroam layout, mirroring MapAreaPanel.vue on the
// left — always visible on desktop, shown full-screen on mobile via
// PhoneStrip's toggle (see FreeroamView.vue). World state is already
// loaded by the time this mounts (it's inside .layout, which only
// renders once FreeroamView's own onMounted has resolved).
const activeContactId = ref(null);
const emit = defineEmits(['call-started']);
</script>

<template>
  <div class="phone-col">
    <PhoneHeader />
    <PhoneContacts v-if="!activeContactId" @open="activeContactId = $event" />
    <PhoneThread v-else :character-id="activeContactId" @back="activeContactId = null" @call-started="emit('call-started')" />
  </div>
</template>
