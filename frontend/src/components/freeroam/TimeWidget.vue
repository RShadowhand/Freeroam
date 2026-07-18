<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { TIMES_OF_DAY, weekdayFor } from '../../utils/time';

const world = useWorldStore();
const jumpOpen = ref(false);
const jumpDay = ref(world.time.day);
const jumpTimeOfDay = ref(world.time.timeOfDay);

watch(() => world.time.day, (d) => { jumpDay.value = d; });
watch(() => world.time.timeOfDay, (t) => { jumpTimeOfDay.value = t; });

const weekday = computed(() => weekdayFor(world.time.day));
const jumpWeekday = computed(() => weekdayFor(parseInt(jumpDay.value, 10)));

function retreat() {
  world.advanceOrRetreatTime({ retreat: true });
}
function advance() {
  world.advanceOrRetreatTime({ advance: true });
}
async function jump() {
  const day = parseInt(jumpDay.value, 10);
  if (!Number.isInteger(day) || day < 1) return;
  jumpOpen.value = false;
  await world.advanceOrRetreatTime({ day, timeOfDay: jumpTimeOfDay.value });
}
</script>

<template>
  <span class="time-widget">
    Day {{ world.time.day }}<template v-if="weekday"> ({{ weekday }})</template> · {{ world.time.timeOfDay }}
    <button type="button" title="Step back to the previous time of day" @click="retreat">◀</button>
    <button type="button" title="Advance to the next time of day" @click="advance">▶</button>
    <button type="button" title="Jump to any day/time — including the past, for time-travel scenarios" @click="jumpOpen = !jumpOpen">🕐</button>
  </span>
  <div class="time-jump-row" v-if="jumpOpen">
    <label for="timeJumpDay">Day</label>
    <input type="number" min="1" id="timeJumpDay" v-model="jumpDay">
    <span class="time-jump-weekday">{{ jumpWeekday || '' }}</span>
    <select v-model="jumpTimeOfDay">
      <option v-for="t in TIMES_OF_DAY" :key="t" :value="t">{{ t }}</option>
    </select>
    <button class="btn small" @click="jump">Jump</button>
  </div>
</template>
