<script setup>
import { computed, onMounted, ref } from 'vue';
import { useWorldStore } from '../stores/world';
import { groupedByArea } from '../utils/format';
import WorldSettingForm from '../components/world/WorldSettingForm.vue';
import AddPlaceFormFull from '../components/world/AddPlaceFormFull.vue';
import PlaceEditRow from '../components/world/PlaceEditRow.vue';

const world = useWorldStore();
const editingId = ref(null);
const groups = computed(() => groupedByArea(world.places));

onMounted(async () => {
  await world.loadWorldState();
});
</script>

<template>
  <section id="view-places" class="view">
    <WorldSettingForm />
    <AddPlaceFormFull />

    <div class="toolbar">
      <h2>The map</h2>
    </div>
    <div class="empty-note" v-if="!world.places.length">No places yet — add one above.</div>
    <div class="area-group" v-for="(list, area) in groups" :key="area">
      <div class="area-label">{{ area }}</div>
      <PlaceEditRow
        v-for="p in list" :key="p.id" :place="p" :editing="p.id === editingId"
        @edit="editingId = p.id" @cancel="editingId = null"
      />
    </div>
  </section>
</template>
