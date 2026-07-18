<script setup>
import { onMounted } from 'vue';
import { useWorldStore } from '../stores/world';
import { useCharacterModal } from '../composables/useCharacterModal';
import { randomizePlacements } from '../api/world';
import UploadZone from '../components/cast/UploadZone.vue';
import CastCard from '../components/cast/CastCard.vue';
import CharacterModal from '../components/cast/CharacterModal.vue';
import ScheduleModal from '../components/cast/ScheduleModal.vue';

const world = useWorldStore();
const characterModal = useCharacterModal();

onMounted(async () => {
  await world.loadWorldState();
});

async function randomize() {
  const { ok, data } = await randomizePlacements();
  if (ok) world.placements = data.placements;
}
</script>

<template>
  <section id="view-cast" class="view">
    <UploadZone />

    <div class="toolbar">
      <h2>Everyone in the cast</h2>
      <div class="toolbar-actions">
        <button class="btn secondary" @click="randomize">🎲 Randomize placements</button>
        <button class="btn" type="button" @click="characterModal.open(null)">+ New character</button>
      </div>
    </div>

    <div class="empty-note" v-if="!world.charactersList.length">No characters yet — upload a card above, or add one.</div>
    <div class="grid cast-grid" v-else>
      <CastCard v-for="c in world.charactersList" :key="c.id" :character="c" />
    </div>
  </section>
  <CharacterModal />
  <ScheduleModal />
</template>
