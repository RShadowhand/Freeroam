<script setup>
import { onMounted, ref, watch } from 'vue';
import { useWorldStore } from '../stores/world';
import { useChatStore } from '../stores/chat';
import MapPanel from '../components/freeroam/MapPanel.vue';
import ChatPanel from '../components/freeroam/ChatPanel.vue';
import QuickMoveMenu from '../components/freeroam/QuickMoveMenu.vue';
import NpcModal from '../components/freeroam/NpcModal.vue';
import FreeroamBanner from '../components/freeroam/FreeroamBanner.vue';

const world = useWorldStore();
const chat = useChatStore();
const ready = ref(false);
const mapOpen = ref(false);

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

// On mobile, picking a room flips back from the map to the chat.
watch(() => chat.currentPlace, () => { mapOpen.value = false; });
</script>

<template>
  <section id="view-freeroam" class="view">
    <FreeroamBanner />
    <button class="btn secondary small map-toggle" type="button" @click="mapOpen = !mapOpen">🗺 Map</button>
    <div class="layout" id="layout" :class="{ 'map-open': mapOpen }" v-show="ready">
      <MapPanel />
      <ChatPanel />
      <QuickMoveMenu />
    </div>
    <div class="loading-note" v-if="!ready">Finding your way around…</div>
  </section>
  <NpcModal />
</template>
