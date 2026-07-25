<script setup>
import { ref } from 'vue';
import PhoneHeader from './PhoneHeader.vue';
import PhoneHomeScreen from './PhoneHomeScreen.vue';
import WavelengthApp from './apps/WavelengthApp.vue';
import TypeCastApp from './apps/TypeCastApp.vue';
import PartyLineApp from './apps/PartyLineApp.vue';

// Right column of the Freeroam layout, mirroring MapAreaPanel.vue on the
// left — always visible on desktop, shown full-screen on mobile via
// PhoneStrip's toggle (see FreeroamView.vue). RoamOS's home screen (app
// grid) sits below the always-visible PhoneHeader "status bar"; each app
// owns its own back-to-home button rather than a shared chrome, same as
// a real phone's apps each having their own back affordance.
const screen = ref('home'); // 'home' | 'wavelength' | 'typecast' | 'party-line'
const emit = defineEmits(['call-started']);
</script>

<template>
  <div class="phone-col">
    <PhoneHeader />
    <PhoneHomeScreen v-if="screen === 'home'" @open="screen = $event" />
    <WavelengthApp v-else-if="screen === 'wavelength'" @back="screen = 'home'" @call-started="emit('call-started')" />
    <TypeCastApp v-else-if="screen === 'typecast'" @back="screen = 'home'" />
    <PartyLineApp v-else-if="screen === 'party-line'" @back="screen = 'home'" />
  </div>
</template>
