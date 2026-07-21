<script setup>
import { computed, onMounted, ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useChatStore } from '../../stores/chat';
import { getWeather } from '../../api/weather';

// Mobile-only: a single persistent control that's an info strip when
// collapsed (time/weather/area/notifications) and a back button once the
// Phone panel is expanded over the chat — same always-visible, always-
// toggles role the "🗺 Map" button already has, just richer when closed.
const props = defineProps({ expanded: { type: Boolean, default: false } });
defineEmits(['toggle']);

const world = useWorldStore();
const chat = useChatStore();
const weatherByArea = ref({});

const currentPlace = computed(() => (chat.currentPlace ? world.placeById(chat.currentPlace) : null));
const currentWeather = computed(() => {
  const area = currentPlace.value?.area;
  return area ? weatherByArea.value[area]?.condition || null : null;
});

// Nothing generates an unread text yet (Phase 2 is user-initiated only —
// you're always already looking at whatever you just sent) — this becomes
// real once Phase 5 (proactive texts) exists. Left at 0 rather than
// invented store state with no producer.
const unreadCount = 0;

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

onMounted(async () => {
  const { ok, data } = await getWeather();
  if (ok) weatherByArea.value = data.weather;
});
</script>

<template>
  <button class="phone-strip" type="button" @click="$emit('toggle')">
    <template v-if="expanded">‹ Back to chat</template>
    <template v-else>
      <span class="phone-strip-icon">📱</span>
      <span class="phone-strip-time">{{ capitalize(world.time.timeOfDay) }}</span>
      <template v-if="currentWeather">· {{ capitalize(currentWeather) }}</template>
      <template v-if="currentPlace?.area">· {{ currentPlace.area }}</template>
      <span class="phone-strip-badge" v-if="unreadCount > 0">🔔 {{ unreadCount }}</span>
    </template>
  </button>
</template>
