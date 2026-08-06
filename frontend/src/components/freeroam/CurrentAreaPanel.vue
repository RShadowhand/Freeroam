<script setup>
import { computed } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useChatStore } from '../../stores/chat';
import { useNpcModal } from '../../composables/useNpcModal';
import PresentChip from './PresentChip.vue';
import { joinNames } from '../../utils/format';

// The old ChatHeader.vue "Details" content, minus the time widget (moved
// to the Phone panel) and the expand/collapse mechanic (the Map/Current
// area tab switch already does that job — no point collapsing content
// that's only ever shown when its own tab is active).
const world = useWorldStore();
const chat = useChatStore();
const npcModal = useNpcModal();

const place = computed(() => world.placeById(chat.currentPlace));
const presentIds = computed(() => (place.value ? world.charsInPlace(place.value.id) : []));

// Swaps two adjacent present characters and persists the resulting order —
// see stores/world.js's setPlaceOrder / PUT /api/places/:placeId/order.
// This is the manual half of response ordering; a message that explicitly
// names/nicknames someone still overrides it for that one round (see
// server.js's reactOrderForMessage), same as the backend does.
function moveInOrder(index, delta) {
  const ids = presentIds.value.slice();
  const j = index + delta;
  if (j < 0 || j >= ids.length) return;
  [ids[index], ids[j]] = [ids[j], ids[index]];
  world.setPlaceOrder(place.value.id, ids);
}
const typeLabel = computed(() => {
  if (!place.value) return '';
  if (place.value.type !== 'private') return 'Communal space';
  const owners = (place.value.ownerIds || []).map((id) => world.charName(id)).filter(Boolean);
  return `Private place${owners.length ? ' — ' + joinNames(owners) : ''}`;
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
  <div class="current-area" v-if="place">
    <div class="pname">{{ place.name }}</div>
    <div class="area-context">{{ typeLabel }}<template v-if="place.area"> · {{ place.area }}</template></div>
    <div class="pdesc">{{ place.desc }}</div>
    <div class="present">
      <PresentChip
        v-for="(cid, i) in presentIds" :key="cid" :char-id="cid" :place-id="place.id"
        :can-move-up="i > 0" :can-move-down="i < presentIds.length - 1"
        @move-up="moveInOrder(i, -1)" @move-down="moveInOrder(i, 1)"
      />
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
  <div class="current-area" v-else>
    <div class="pname">Nowhere yet</div>
    <div class="pdesc">Add a place on the Places page to get started.</div>
  </div>
</template>
