<script setup>
import { computed, ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useChatStore } from '../../stores/chat';
import { useNpcModal } from '../../composables/useNpcModal';
import TimeWidget from './TimeWidget.vue';
import PresentChip from './PresentChip.vue';

const world = useWorldStore();
const chat = useChatStore();
const npcModal = useNpcModal();
const expanded = ref(false);

const place = computed(() => world.placeById(chat.currentPlace));
const presentIds = computed(() => place.value ? world.charsInPlace(place.value.id) : []);
const typeLabel = computed(() => {
  if (!place.value) return '';
  if (place.value.type !== 'private') return 'Communal space';
  const owner = place.value.ownerId && world.charactersById[place.value.ownerId];
  return `Private place${owner ? ' — ' + owner.name : ''}`;
});
const absentCharacters = computed(() => world.charactersList.filter((c) => !presentIds.value.includes(c.id)));

function absentLabel(c) {
  const placement = world.placements[c.id];
  const from = placement && world.placeById(placement.placeId) ? ` (from ${world.placeById(placement.placeId).name})` : ' (unplaced)';
  return `${c.name}${from}`;
}

function onBring(e) {
  if (e.target.value) chat.moveCharacter(e.target.value, chat.currentPlace);
  e.target.value = '';
}
</script>

<template>
  <div class="topbar" v-if="place">
    <div class="topbar-main">
      <span class="pname">{{ place.name }}</span>
      <TimeWidget />
      <button type="button" class="topbar-toggle" @click="expanded = !expanded">{{ expanded ? 'Less ▴' : 'Details ▾' }}</button>
    </div>
    <div class="topbar-details" :class="{ collapsed: !expanded }">
      <div class="area-context">{{ typeLabel }}<template v-if="place.area"> · {{ place.area }}</template></div>
      <div class="pdesc">{{ place.desc }}</div>
      <div class="present">
        <PresentChip v-for="cid in presentIds" :key="cid" :char-id="cid" :place-id="place.id" />
        <span class="chip empty" v-if="!presentIds.length">no one else is here</span>
      </div>
      <div class="header-actions">
        <select class="bring-select" v-if="absentCharacters.length" @change="onBring">
          <option value="" selected>+ Bring someone here…</option>
          <option v-for="c in absentCharacters" :key="c.id" :value="c.id">{{ absentLabel(c) }}</option>
        </select>
        <button class="btn secondary small new-character-btn" @click="npcModal.open({ name: '', placeId: chat.currentPlace })">+ New character</button>
      </div>
      <div class="persona-tag" v-if="world.activePersona">Playing as {{ world.activePersona.name }}</div>
    </div>
  </div>
  <div class="topbar" v-else>
    <div class="pname">Nowhere yet</div>
    <div class="pdesc">Add a place on the Places page to get started.</div>
  </div>
</template>
