<script setup>
import { useChatStore } from '../../stores/chat';

const chat = useChatStore();
</script>

<template>
  <div class="call-bar" v-if="chat.activeCall">
    <span class="call-bar-label">📞 On a call with {{ chat.activeCall.name }}</span>
    <button class="btn secondary small" type="button" :disabled="chat.loading" @click="chat.endCall()">Hang up</button>
  </div>
</template>
