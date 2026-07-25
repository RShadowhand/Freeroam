<script setup>
defineProps({ tag: { type: String, default: 'only those who share your place can hear you' } });
</script>

<template>
  <div class="brand">
    <span class="brand-name">Freeroam</span>
    <span class="brand-tag">{{ tag }}</span>
  </div>
</template>
