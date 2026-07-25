<script setup>
defineProps({ message: { type: Object, required: true } });
</script>

<template>
  <div class="msg error">{{ message.text }}</div>
</template>
