<script setup>
import { useRoute } from 'vue-router';

const route = useRoute();
</script>

<template>
  <nav class="main-nav">
    <router-link class="nav-tab" :class="{ active: route.meta.top === '/' }" to="/">🏠 Freeroam</router-link>
    <router-link class="nav-tab" :class="{ active: route.meta.top === '/world' }" to="/world/places">🌍 World</router-link>
    <router-link class="nav-tab" :class="{ active: route.meta.top === '/settings' }" to="/settings/connection">⚙ Settings</router-link>
  </nav>
</template>
