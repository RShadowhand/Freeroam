<script setup>
import { ref } from 'vue';
import { usePhoneStore } from '../../../stores/phone';
import PhoneContacts from '../PhoneContacts.vue';
import PhoneThread from '../PhoneThread.vue';

// TypeCast: RoamOS's 1-on-1 texting app.
const emit = defineEmits(['back']);
const phone = usePhoneStore();
const activeContactId = ref(null);

// The trailing icon is a separate action from the row's own click (open
// thread) — @click.stop keeps a nudge from also navigating, and this is a
// <span>, not a nested <button>, since a button can't contain one.
function nudge(characterId) {
  phone.triggerText(characterId);
}
</script>

<template>
  <div class="phone-app-screen" v-if="!activeContactId">
    <div class="phone-thread-header">
      <button class="phone-back" type="button" @click="emit('back')">‹ Home</button>
      <span class="phone-thread-name">TypeCast</span>
    </div>
    <PhoneContacts @select="activeContactId = $event">
      <template #trailing="{ character }">
        <span
          class="phone-nudge-btn" role="button" tabindex="0"
          title="Nudge them to text you now" @click.stop="nudge(character.id)"
        >📨</span>
      </template>
    </PhoneContacts>
  </div>
  <PhoneThread v-else :character-id="activeContactId" @back="activeContactId = null" />
</template>
