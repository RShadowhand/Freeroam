<script setup>
defineProps({ message: { type: Object, required: true } });
</script>

<template>
  <div class="msg system" :class="{ call: message.call }" v-html="message.text"></div>
</template>
