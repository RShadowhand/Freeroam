<script setup>
import { computed, onMounted, ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useChatStore } from '../../stores/chat';
import { weekdayFor } from '../../utils/time';
import { getWeather } from '../../api/weather';
import TimeWidget from '../freeroam/TimeWidget.vue';

// "Lock screen" style summary: day/time always available from the world
// clock; weather is the current place's own area (wherever the user
// physically is in Freeroam right now), falling back to nothing shown at
// all if they haven't entered a place this session or that area has never
// been rolled — same weather data Phase 1 already built, just displayed
// here instead of (or in addition to) the Places view.
const world = useWorldStore();
const chat = useChatStore();
const weatherByArea = ref({});

const weekday = computed(() => weekdayFor(world.time.day));
const currentPlace = computed(() => (chat.currentPlace ? world.placeById(chat.currentPlace) : null));
const currentWeather = computed(() => {
  const area = currentPlace.value?.area;
  return area ? weatherByArea.value[area]?.condition || null : null;
});

function capitalize(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : '';
}

// Place leads (most useful at a glance), then weekday/day, then weather —
// whichever gets clipped by .phone-date's ellipsis on narrow screens is
// now the least useful part, not the place name. Built as a computed join
// rather than template v-ifs so a missing part never leaves a stray
// leading/double separator.
const dateLine = computed(() => {
  const parts = [];
  if (currentPlace.value?.area) parts.push(currentPlace.value.area);
  if (weekday.value) parts.push(`${weekday.value} (${world.time.day})`);
  if (currentWeather.value) parts.push(capitalize(currentWeather.value));
  return parts.join(' · ');
});

onMounted(async () => {
  const { ok, data } = await getWeather();
  if (ok) weatherByArea.value = data.weather;
});
</script>

<template>
  <div class="phone-header">
    <div class="phone-info">
      <div class="phone-time">{{ capitalize(world.time.timeOfDay) }}</div>
      <div class="phone-date">{{ dateLine }}</div>
    </div>
    <div class="phone-time-controls">
      <TimeWidget :show-label="false" />
    </div>
  </div>
</template>
