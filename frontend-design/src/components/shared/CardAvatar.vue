<script setup>
import { computed } from 'vue';
import { initials } from '../../utils/format';

// color's declared default only ever kicks in for an *undefined* prop —
// callers that explicitly pass null (e.g. "no active persona yet, showing
// the generic visitor placeholder") bypass it, leaving the fallback circle
// with no background at all. Falling back here, on the actual value
// instead of on definedness, covers both cases the same way.
const props = defineProps({
  name: { type: String, required: true },
  avatarUrl: { type: String, default: null },
  color: { type: String, default: 'var(--dim)' },
});
const resolvedColor = computed(() => props.color || 'var(--dim)');
</script>

<template>
  <img v-if="avatarUrl" class="avatar" :src="avatarUrl" :alt="name">
  <div v-else class="avatar-fallback" :style="{ background: resolvedColor }">{{ initials(name) }}</div>
</template>
