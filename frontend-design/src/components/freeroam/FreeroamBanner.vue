<script setup>
import { useChatStore } from '../../stores/chat';

const chat = useChatStore();
</script>

<template>
  <div class="banner" v-if="chat.bannerMessage === 'no-key'">
    No API key configured yet — characters will stay silent until you add one in <router-link to="/settings/connection">Settings</router-link>.
  </div>
  <div class="banner" v-else-if="chat.bannerMessage === 'unreachable'">
    Can't reach the backend. Is the server running?
  </div>
</template>
