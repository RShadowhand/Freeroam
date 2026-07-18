<script setup>
import { initials } from '../../utils/format';

defineProps({
  name: { type: String, required: true },
  avatarUrl: { type: String, default: null },
  color: { type: String, default: 'var(--dim)' },
});
</script>

<template>
  <img v-if="avatarUrl" class="avatar" :src="avatarUrl" :alt="name">
  <div v-else class="avatar-fallback" :style="{ background: color }">{{ initials(name) }}</div>
</template>
