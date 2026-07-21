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

onMounted(async () => {
  const { ok, data } = await getWeather();
  if (ok) weatherByArea.value = data.weather;
});
</script>

<template>
  <div class="phone-header">
    <div class="phone-time">{{ capitalize(world.time.timeOfDay) }}</div>
    <div class="phone-date">Day {{ world.time.day }}<template v-if="weekday"> · {{ weekday }}</template></div>
    <div class="phone-weather" v-if="currentWeather">
      {{ capitalize(currentWeather) }}<template v-if="currentPlace.area"> · {{ currentPlace.area }}</template>
    </div>
    <div class="phone-time-controls">
      <TimeWidget :show-label="false" />
    </div>
  </div>
</template>
