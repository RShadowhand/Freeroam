<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import { useWorldStore } from '../stores/world';
import { useChatStore } from '../stores/chat';
import { usePhoneStore } from '../stores/phone';
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
const phone = usePhoneStore();
const ready = ref(false);

// Mobile only: which single panel currently owns the screen. A plain
// string, not two independent booleans, so Map and Phone can never both
// claim "open" at once — there's only one value to be wrong.
const mobilePanel = ref('chat');
function toggleMobilePanel(panel) {
  mobilePanel.value = mobilePanel.value === panel ? 'chat' : panel;
}

// Proactive texts (Phase 5) land as a background side effect of some
// other request — nothing pushes the badge update to the client, so this
// polls for it instead. No WebSocket/SSE channel exists for "just tell me
// when something changes," and a 20s cadence is frequent enough to feel
// live without hammering the server over something this infrequent.
let unreadPollId = null;

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
  phone.refreshUnreadCount();
  unreadPollId = setInterval(() => phone.refreshUnreadCount(), 20000);
});

onUnmounted(() => {
  if (unreadPollId) clearInterval(unreadPollId);
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
    <!-- v-if, not v-show: mounting only once data is ready means MessageList's
    initial scroll-to-bottom runs against a visible container. Under v-show
    the log finishes loading while this is still display:none, so scrollHeight
    reads 0 and the chat silently opens scrolled to the top. -->
    <div
      class="layout" id="layout"
      :class="{ 'map-open': mobilePanel === 'map' || mobilePanel === 'area', 'phone-open': mobilePanel === 'phone' }"
      v-if="ready"
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
