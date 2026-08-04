<script setup>
import { computed } from 'vue';
import { useRoute } from 'vue-router';
import MainNav from './components/layout/MainNav.vue';
import SubNav from './components/layout/SubNav.vue';
import ErrorBanner from './components/layout/ErrorBanner.vue';
import OnboardingModal from './components/onboarding/OnboardingModal.vue';
import CharacterModal from './components/cast/CharacterModal.vue';
import PersonaModal from './components/persona/PersonaModal.vue';
import WorldPickerOverlay from './components/worlds/WorldPickerOverlay.vue';
import { useOnboardingModal } from './composables/useOnboardingModal';
import { useWorldPicker } from './composables/useWorldPicker';

const route = useRoute();
const onboarding = useOnboardingModal();
const worldPicker = useWorldPicker();

// Only the Freeroam view is pinned to exactly one viewport's height with
// its own internal scrolling on mobile (see src/styles/main.css's
// .app.freeroam-view rules) — every other view is a normal page that
// should grow past one viewport and let the whole page scroll.
const isFreeroam = computed(() => route.path === '/');

// The onboarding tour can itself create a second world (its "start blank"
// step) — if it's open, it's already handling world setup, so the picker
// stays suppressed until onboarding is dismissed or finished.
const showWorldPicker = computed(() => worldPicker.isOpen.value && !onboarding.isOpen.value);
</script>

<template>
  <div class="app" :class="{ 'freeroam-view': isFreeroam }">
    <MainNav />
    <SubNav />
    <ErrorBanner />
    <router-view />
    <OnboardingModal />
    <WorldPickerOverlay v-if="showWorldPicker" />
    <CharacterModal />
    <PersonaModal />
  </div>
</template>
