<script setup>
// A shared sky-arc with a dot marking the sun's position — distinguishes
// each time-of-day by where the dot sits rather than by pictogram detail,
// so it stays legible at table-header size regardless of the device's own
// emoji font (see ScheduleTable.vue for why that mattered). Night swaps
// the dot for a moon below the horizon instead of extending the arc.
defineProps({ timeOfDay: { type: String, required: true } });

const SUN_POSITION = {
  sunrise: { cx: 2.4, cy: 18.6, r: 2.6 },
  morning: { cx: 6.2, cy: 10.3, r: 2.6 },
  noon: { cx: 12, cy: 3.4, r: 2.8 },
  afternoon: { cx: 17.8, cy: 10.3, r: 2.6 },
  evening: { cx: 20.8, cy: 15.5, r: 2.6 },
  sunset: { cx: 21.6, cy: 18.6, r: 2.6 },
};
</script>

<template>
  <svg viewBox="0 0 24 24" class="tod-icon" aria-hidden="true">
    <template v-if="timeOfDay === 'night'">
      <line x1="2" y1="19" x2="22" y2="19" class="tod-horizon" />
      <path d="M14 6.5a5 5 0 1 0 4.2 7.8 4 4 0 0 1-4.2-7.8z" class="tod-moon" />
      <circle cx="7" cy="6" r="0.7" class="tod-star" />
      <circle cx="19" cy="4.5" r="0.5" class="tod-star" />
    </template>
    <template v-else-if="SUN_POSITION[timeOfDay]">
      <path d="M2,19 Q12,3 22,19" class="tod-arc" />
      <line x1="2" y1="19" x2="22" y2="19" class="tod-horizon" />
      <circle :cx="SUN_POSITION[timeOfDay].cx" :cy="SUN_POSITION[timeOfDay].cy" :r="SUN_POSITION[timeOfDay].r" class="tod-sun" />
    </template>
  </svg>
</template>
