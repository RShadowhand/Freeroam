<script setup>
import { useRoute } from 'vue-router';
import { useWorldsStore } from '../../stores/worlds';

const route = useRoute();
const worlds = useWorldsStore();
</script>

<template>
  <nav class="main-nav">
    <router-link class="nav-tab" :class="{ active: route.meta.top === '/' }" to="/">🏠 Freeroam</router-link>
    <router-link class="nav-tab" :class="{ active: route.meta.top === '/world' }" to="/world/places">🌍 World</router-link>
    <router-link class="nav-tab" :class="{ active: route.meta.top === '/settings' }" to="/settings/connection">⚙ Settings</router-link>
    <router-link
      class="nav-tab world-chip" :class="{ active: route.meta.top === '/worlds' }"
      to="/worlds" title="Switch or manage worlds (save slots)"
    >💾 {{ worlds.current?.name || 'World' }}</router-link>
  </nav>
</template>
