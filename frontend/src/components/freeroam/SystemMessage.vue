<script setup>
defineProps({ message: { type: Object, required: true } });
</script>

<template>
  <!-- Plain text interpolation, never v-html: system text embeds place and
       character names, which can come from imported cards — untrusted input
       that must not be able to inject markup into the app origin. -->
  <div class="msg system" :class="{ call: message.call }">{{ message.text }}</div>
</template>
