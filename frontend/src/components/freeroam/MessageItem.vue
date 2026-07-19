<script setup>
import SystemMessage from './SystemMessage.vue';
import ErrorMessage from './ErrorMessage.vue';
import UserMessage from './UserMessage.vue';
import NpcMessage from './NpcMessage.vue';
import NarratorMessage from './NarratorMessage.vue';
import CharMessage from './CharMessage.vue';

defineProps({
  message: { type: Object, required: true },
  isLast: { type: Boolean, default: false },
  offerSave: { type: Boolean, default: false },
});
</script>

<template>
  <SystemMessage v-if="message.type === 'system'" :message="message" />
  <ErrorMessage v-else-if="message.type === 'error'" :message="message" />
  <UserMessage v-else-if="message.type === 'user'" :message="message" :is-last="isLast" />
  <NarratorMessage v-else-if="message.type === 'narrator'" :message="message" />
  <NpcMessage v-else-if="message.isNPC" :message="message" :offer-save="offerSave" />
  <CharMessage v-else :message="message" />
</template>
