<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import MainNav from './components/layout/MainNav.vue';
import SubNav from './components/layout/SubNav.vue';
import ErrorBanner from './components/layout/ErrorBanner.vue';

const route = useRoute();

// Only the Freeroam view is pinned to exactly one viewport's height with
// its own internal scrolling on mobile (see src/styles/main.css's
// .app.freeroam-view rules) — every other view is a normal page that
// should grow past one viewport and let the whole page scroll.
const isFreeroam = computed(() => route.path === '/');
</script>

<template>
  <div class="app" :class="{ 'freeroam-view': isFreeroam }">
    <MainNav />
    <SubNav />
    <ErrorBanner />
    <router-view />
  </div>
</template>
