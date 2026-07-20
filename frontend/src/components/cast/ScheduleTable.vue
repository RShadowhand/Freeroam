<script setup>
import { useWorldStore } from '../../stores/world';
import { TIMES_OF_DAY, WEEKDAYS, timeOfDayEmoji } from '../../utils/time';
import { initials } from '../../utils/format';

const props = defineProps({ character: { type: Object, required: true } });
const emit = defineEmits(['pick']);
const world = useWorldStore();

function slotFor(day, t) {
  return props.character.schedule?.[day]?.[t] || null;
}
function cellLabel(day, t) {
  const slot = slotFor(day, t);
  const place = slot ? world.placeById(slot.placeId) : null;
  return place ? initials(place.name) : '—';
}
function cellTitle(day, t) {
  const slot = slotFor(day, t);
  const place = slot ? world.placeById(slot.placeId) : null;
  return place ? `${place.name}${slot.reason ? ' — ' + slot.reason : ''}` : 'Not scheduled';
}
</script>

<template>
  <table class="schedule-table">
    <thead>
      <tr>
        <th></th>
        <th v-for="t in TIMES_OF_DAY" :key="t" :title="t">
          <span class="tod-full">{{ t }}</span>
          <span class="tod-emoji" aria-hidden="true">{{ timeOfDayEmoji(t) }}</span>
        </th>
      </tr>
    </thead>
    <tbody>
      <tr v-for="day in WEEKDAYS" :key="day">
        <th>{{ day.slice(0, 3) }}</th>
        <td
          v-for="t in TIMES_OF_DAY" :key="t"
          :class="{ set: slotFor(day, t) }" :title="cellTitle(day, t)"
          @click="emit('pick', day, t)"
        >{{ cellLabel(day, t) }}</td>
      </tr>
    </tbody>
  </table>
</template>
