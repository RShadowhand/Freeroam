<script setup>
defineProps({ message: { type: Object, required: true } });
</script>

<template>
  <div class="msg system" v-html="message.text"></div>
</template>
