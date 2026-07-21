<script setup>
import { onMounted, ref, watch } from 'vue';
import { useWorldStore } from '../stores/world';
import { useChatStore } from '../stores/chat';
import MapAreaPanel from '../components/freeroam/MapAreaPanel.vue';
import ChatPanel from '../components/freeroam/ChatPanel.vue';
import PhonePanel from '../components/phone/PhonePanel.vue';
import PhoneStrip from '../components/phone/PhoneStrip.vue';
import QuickMoveMenu from '../components/freeroam/QuickMoveMenu.vue';
import NpcModal from '../components/freeroam/NpcModal.vue';
import SuggestionOverflowModal from '../components/freeroam/SuggestionOverflowModal.vue';
import FreeroamBanner from '../components/freeroam/FreeroamBanner.vue';

const world = useWorldStore();
const chat = useChatStore();
const ready = ref(false);

// Mobile only: which single panel currently owns the screen. A plain
// string, not two independent booleans, so Map and Phone can never both
// claim "open" at once — there's only one value to be wrong.
const mobilePanel = ref('chat');
function toggleMobilePanel(panel) {
  mobilePanel.value = mobilePanel.value === panel ? 'chat' : panel;
}

onMounted(async () => {
  if (!chat.currentPlace) {
    // First time this session — resume wherever the visitor left off (or
    // enter the first place for a genuinely new world).
    await chat.initFreeroam();
  } else {
    // Returning to this view — refresh shared data without re-entering
    // (which would be a no-op anyway) or re-fetching the chat log.
    await world.loadWorldState();
    await chat.checkApiKeyBanner();
  }
  ready.value = true;
});

// On mobile, picking a room flips back from the map (or phone) to the chat.
watch(() => chat.currentPlace, () => { mobilePanel.value = 'chat'; });
</script>

<template>
  <section id="view-freeroam" class="view">
    <FreeroamBanner />
    <div class="mobile-panel-toggles">
      <button class="btn secondary small" type="button" @click="toggleMobilePanel('map')">🗺 Map</button>
      <button class="btn secondary small" type="button" @click="toggleMobilePanel('area')">Current area</button>
    </div>
    <div
      class="layout" id="layout"
      :class="{ 'map-open': mobilePanel === 'map' || mobilePanel === 'area', 'phone-open': mobilePanel === 'phone' }"
      v-show="ready"
    >
      <MapAreaPanel :open-tab="mobilePanel === 'map' ? 'map' : mobilePanel === 'area' ? 'area' : null" />
      <ChatPanel />
      <PhonePanel @call-started="mobilePanel = 'chat'" />
      <QuickMoveMenu />
    </div>
    <PhoneStrip class="phone-strip-mobile" :expanded="mobilePanel === 'phone'" @toggle="toggleMobilePanel('phone')" />
    <div class="loading-note" v-if="!ready">Finding your way around…</div>
  </section>
  <NpcModal />
  <SuggestionOverflowModal />
</template>
