<script setup>
import { useChatStore } from '../../stores/chat';

defineProps({ message: { type: Object, required: true } });
const chat = useChatStore();
</script>

<template>
  <div class="msg error">
    {{ message.text }}
    <button class="msg-delete-btn error-dismiss" title="Dismiss" @click="chat.removeError(message.id)">✕</button>
  </div>
</template>
