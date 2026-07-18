<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';

const route = useRoute();

const worldTabs = [
  { path: '/world/places', label: 'Places' },
  { path: '/world/cast', label: 'Cast' },
  { path: '/world/persona', label: 'Personas' },
];
const settingsTabs = [
  { path: '/settings/connection', label: 'Connection' },
  { path: '/settings/prompts', label: 'Prompts' },
  { path: '/settings/variables', label: 'Variables' },
];

const tabs = computed(() => {
  if (route.meta.top === '/world') return worldTabs;
  if (route.meta.top === '/settings') return settingsTabs;
  return null;
});
</script>

<template>
  <nav class="sub-nav" v-if="tabs">
    <router-link
      v-for="tab in tabs" :key="tab.path"
      class="sub-tab" :class="{ active: route.path === tab.path }"
      :to="tab.path"
    >{{ tab.label }}</router-link>
  </nav>
</template>
