<script setup>
import { computed } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useChatStore } from '../../stores/chat';
import { groupedByArea } from '../../utils/format';
import { nextTimeSlot, scheduledSlotFor } from '../../utils/time';
import Avatar from '../shared/Avatar.vue';

const props = defineProps({ charId: { type: String, required: true }, placeId: { type: String, required: true } });
const world = useWorldStore();
const chat = useChatStore();

const character = computed(() => world.charactersById[props.charId]);
const active = computed(() => world.isActive(props.charId));

// Options for sending this present character to a different place, grouped
// by area, excluding wherever they already are. "Scheduled now"/"Scheduled
// next" appear first when they have a schedule slot set for the current or
// upcoming time of day.
const nowSlot = computed(() => scheduledSlotFor(character.value, world.time.day, world.time.timeOfDay));
const upcoming = computed(() => nextTimeSlot(world.time.day, world.time.timeOfDay));
const nextSlot = computed(() => scheduledSlotFor(character.value, upcoming.value.day, upcoming.value.timeOfDay));

const scheduledNowPlace = computed(() => nowSlot.value && nowSlot.value.placeId !== props.placeId ? world.placeById(nowSlot.value.placeId) : null);
const scheduledNextPlace = computed(() => {
  if (!nextSlot.value || nextSlot.value.placeId === props.placeId) return null;
  if (nowSlot.value && nextSlot.value.placeId === nowSlot.value.placeId) return null;
  return world.placeById(nextSlot.value.placeId);
});

const groups = computed(() => groupedByArea(world.places.filter((p) => p.id !== props.placeId)));

function onSend(e) {
  if (e.target.value) chat.moveCharacter(props.charId, e.target.value);
  e.target.value = '';
}
function remove() {
  chat.moveCharacter(props.charId, null);
}
function toggleActive() {
  chat.setCharacterActive(props.charId, !active.value);
}
</script>

<template>
  <span class="chip" :class="{ inactive: !active }" v-if="character">
    <Avatar :char-id="charId" :size="18" />
    {{ character.name }}
    <button
      class="chip-active-toggle" :class="{ active }"
      :title="active ? 'In the conversation — tap to step back' : 'Not in the conversation — tap to bring in'"
      @click="toggleActive"
    >{{ active ? '●' : '○' }}</button>
    <select class="chip-send-select" title="Send elsewhere" @change="onSend">
      <option value="" disabled selected>↪</option>
      <option v-if="scheduledNowPlace" :value="scheduledNowPlace.id">
        📅 Scheduled now: {{ scheduledNowPlace.name }}{{ nowSlot.reason ? ' — ' + nowSlot.reason : '' }}
      </option>
      <option v-if="scheduledNextPlace" :value="scheduledNextPlace.id">
        📅 Scheduled next ({{ upcoming.timeOfDay }}): {{ scheduledNextPlace.name }}{{ nextSlot.reason ? ' — ' + nextSlot.reason : '' }}
      </option>
      <optgroup v-for="(list, area) in groups" :key="area" :label="area">
        <option v-for="p in list" :key="p.id" :value="p.id">{{ p.name }}</option>
      </optgroup>
    </select>
    <button class="chip-remove" title="Send them away (unplace)" @click="remove">✕</button>
  </span>
</template>
