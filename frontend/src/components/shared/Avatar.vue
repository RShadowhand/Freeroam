<script setup>
import { computed } from 'vue';
import { useWorldStore } from '../../stores/world';

const props = defineProps({
  charId: { type: String, default: null },
  size: { type: Number, default: 38 },
});
const world = useWorldStore();
const char = computed(() => world.charactersById[props.charId]);
</script>

<template>
  <img
    v-if="char?.avatarUrl" class="mini-avatar"
    :style="{ width: size + 'px', height: size + 'px' }"
    :src="char.avatarUrl" :alt="char.name"
  >
  <span
    v-else class="dot"
    :style="{ background: char ? char.color : 'var(--dim)', width: size + 'px', height: size + 'px' }"
  ></span>
</template>
