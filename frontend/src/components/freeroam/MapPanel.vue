<script setup>
import { computed } from 'vue';
import { useWorldStore } from '../../stores/world';
import { groupedByArea } from '../../utils/format';
import Brand from '../shared/Brand.vue';
import AddPlaceForm from './AddPlaceForm.vue';
import PlaceRow from './PlaceRow.vue';

const world = useWorldStore();
const groups = computed(() => groupedByArea(world.places));
</script>

<template>
  <div class="map-col">
    <Brand />
    <AddPlaceForm />
    <div class="map">
      <div class="empty-note" v-if="!world.places.length">
        No places yet. Add some on the <router-link to="/world/places">Places</router-link> page.
      </div>
      <template v-else>
        <div class="area-group" v-for="(list, area) in groups" :key="area">
          <div class="area-label">{{ area }}</div>
          <PlaceRow v-for="p in list" :key="p.id" :place="p" />
        </div>
        <div class="legend">dots mark who's there · private places belong to a resident</div>
      </template>
    </div>
  </div>
</template>
