<script setup>
import { computed, onMounted, ref } from 'vue';
import { useWorldStore } from '../stores/world';
import { groupedByArea } from '../utils/format';
import { getWeather, setAreaWeather } from '../api/weather';
import WorldSettingForm from '../components/world/WorldSettingForm.vue';
import AddPlaceFormFull from '../components/world/AddPlaceFormFull.vue';
import PlaceEditRow from '../components/world/PlaceEditRow.vue';

const world = useWorldStore();
const editingId = ref(null);
const groups = computed(() => groupedByArea(world.places));

// Weather lives outside the world store (it's Places-view-only editing UI,
// not needed anywhere else on the frontend) — loaded once here and patched
// locally after each edit rather than re-fetched, same as most of this
// view's own place-editing state.
const weatherAreas = ref([]); // areas weather actually applies to (excludes the "Unsorted" bucket)
const weatherByArea = ref({});
const conditions = ref([]);

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
function weatherSelectValue(area) {
  const entry = weatherByArea.value[area];
  return entry && entry.mode === 'manual' ? entry.condition : 'auto';
}
function weatherLabel(area) {
  const entry = weatherByArea.value[area];
  return entry ? capitalize(entry.condition) : 'Not set yet';
}
async function onWeatherChange(area, value) {
  const body = value === 'auto' ? { mode: 'auto' } : { mode: 'manual', condition: value };
  const { ok, data } = await setAreaWeather(area, body);
  if (ok) weatherByArea.value = data.weather;
}

onMounted(async () => {
  await world.loadWorldState();
  const { ok, data } = await getWeather();
  if (ok) {
    weatherAreas.value = data.areas;
    weatherByArea.value = data.weather;
    conditions.value = data.conditions;
  }
});
</script>

<template>
  <section id="view-places" class="view">
    <div class="places-top-forms">
      <WorldSettingForm />
      <AddPlaceFormFull />
    </div>

    <div class="toolbar">
      <h2>The map</h2>
    </div>
    <div class="empty-note" v-if="!world.places.length">No places yet — add one above.</div>
    <div class="map-columns" v-else>
      <div class="area-group" v-for="(list, area) in groups" :key="area">
        <div class="area-label-row">
          <div class="area-label">{{ area }}</div>
          <div class="area-weather" v-if="weatherAreas.includes(area)">
            <span class="weather-current">{{ weatherLabel(area) }}</span>
            <select :value="weatherSelectValue(area)" @change="onWeatherChange(area, $event.target.value)">
              <option value="auto">Auto</option>
              <option v-for="c in conditions" :key="c" :value="c">{{ capitalize(c) }}</option>
            </select>
          </div>
        </div>
        <PlaceEditRow
          v-for="p in list" :key="p.id" :place="p" :editing="p.id === editingId"
          @edit="editingId = p.id" @cancel="editingId = null"
        />
      </div>
    </div>
  </section>
</template>
