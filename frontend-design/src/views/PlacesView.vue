<script setup>
import { computed, onMounted, ref } from 'vue';
import { useWorldStore } from '../stores/world';
import { groupedByArea } from '../utils/format';
import { getWeather, setAreaWeather } from '../api/weather';
import { exportAllPlaces, exportPlacesByArea, importPlaces, importPlaceCard } from '../api/places';
import WorldSettingForm from '../components/world/WorldSettingForm.vue';
import AddPlaceFormFull from '../components/world/AddPlaceFormFull.vue';
import PlaceEditRow from '../components/world/PlaceEditRow.vue';

const world = useWorldStore();
const editingId = ref(null);
const groups = computed(() => groupedByArea(world.places));
const importFileInput = ref(null);
const importStatus = ref('');

function downloadPlacesJson(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function exportAll() {
  const { ok, data } = await exportAllPlaces();
  if (!ok) { alert(data.error || 'Could not export places.'); return; }
  downloadPlacesJson(data, 'places.json');
}

// "Unsorted" is groupedByArea's synthetic bucket label for places with no
// area set (format.js) — not a real area value, so an empty/blank area
// can't round-trip through the ?area= query filter (an empty string there
// is falsy and would match every place, not just the unsorted ones).
// Filtered client-side instead, since the full list is already loaded here.
async function exportArea(area) {
  if (area === 'Unsorted') {
    downloadPlacesJson({ places: world.places.filter((p) => !p.area) }, 'unsorted.json');
    return;
  }
  const { ok, data } = await exportPlacesByArea(area);
  if (!ok) { alert(data.error || 'Could not export this area.'); return; }
  downloadPlacesJson(data, `${area}.json`);
}

// Accepts either the { places: [...] } shape all three export granularities
// (single/area/all) produce, or a tavernroam_place_card_v1 PNG card.
async function importFile(file) {
  importStatus.value = '';
  try {
    const isPng = file.type === 'image/png' || /\.png$/i.test(file.name);
    let ok, data;
    if (isPng) {
      ({ ok, data } = await importPlaceCard(file));
    } else {
      const raw = JSON.parse(await file.text());
      const places = Array.isArray(raw.places) ? raw.places : [raw];
      ({ ok, data } = await importPlaces(places));
    }
    if (!ok) throw new Error(data.error || 'import failed');
    world.places.push(...data.places);
    importStatus.value = `Imported ${data.places.length} place(s).${data.warnings?.length ? ' ' + data.warnings.join(' ') : ''}`;
  } catch (err) {
    importStatus.value = `${file.name}: ${err.message}`;
  }
}
function onImportFileChange() {
  const [file] = importFileInput.value.files;
  if (file) importFile(file);
  importFileInput.value.value = '';
}

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
      <div class="toolbar-actions">
        <button class="btn secondary small" @click="importFileInput.click()">Import (.json or .png)</button>
        <input type="file" ref="importFileInput" accept="application/json,.json,image/png,.png" style="display:none;" @change="onImportFileChange">
        <button class="btn secondary small" @click="exportAll">Export all places</button>
      </div>
    </div>
    <div class="form-status" v-if="importStatus">{{ importStatus }}</div>
    <div class="empty-note" v-if="!world.places.length">No places yet — add one above.</div>
    <div class="map-columns" v-else>
      <div class="area-group" v-for="(list, area) in groups" :key="area">
        <div class="area-label-row">
          <div class="area-label">{{ area }}</div>
          <button class="btn secondary small" @click="exportArea(area)">Export area</button>
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
