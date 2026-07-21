<script setup>
import { ref } from 'vue';
import PhoneContacts from '../PhoneContacts.vue';
import PhoneThread from '../PhoneThread.vue';

// TypeCast: RoamOS's 1-on-1 texting app.
const emit = defineEmits(['back']);
const activeContactId = ref(null);
</script>

<template>
  <div class="phone-app-screen" v-if="!activeContactId">
    <div class="phone-thread-header">
      <button class="phone-back" type="button" @click="emit('back')">‹ Home</button>
      <span class="phone-thread-name">TypeCast</span>
    </div>
    <PhoneContacts @select="activeContactId = $event" />
  </div>
  <PhoneThread v-else :character-id="activeContactId" @back="activeContactId = null" />
</template>
