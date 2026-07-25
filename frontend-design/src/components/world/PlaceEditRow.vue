<script setup>
import { ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { updatePlace, deletePlace, exportPlace } from '../../api/places';
import { apiBlobGet } from '../../api/http';
import { joinNames } from '../../utils/format';

const props = defineProps({ place: { type: Object, required: true }, editing: { type: Boolean, default: false } });
const emit = defineEmits(['edit', 'cancel']);
const world = useWorldStore();

const name = ref(props.place.name);
const area = ref(props.place.area || '');
const desc = ref(props.place.desc || '');
const type = ref(props.place.type);
const ownerIds = ref([...(props.place.ownerIds || [])]);
const status = ref('');

function startEdit() {
  name.value = props.place.name;
  area.value = props.place.area || '';
  desc.value = props.place.desc || '';
  type.value = props.place.type;
  ownerIds.value = [...(props.place.ownerIds || [])];
  status.value = '';
  emit('edit');
}

async function save() {
  const body = {
    name: name.value.trim(), area: area.value.trim(), desc: desc.value.trim(),
    type: type.value, ownerIds: ownerIds.value,
  };
  const { ok, data } = await updatePlace(props.place.id, body);
  if (!ok) { status.value = data.error || 'Could not save changes.'; return; }
  const idx = world.places.findIndex((p) => p.id === props.place.id);
  world.places[idx] = data.place;
  emit('cancel');
}

function ownerNames(place) {
  return place.ownerIds.map((id) => world.charName(id)).filter(Boolean);
}

// Same { places: [...] } wire shape /api/places/import expects.
async function exportJson() {
  const { ok, data } = await exportPlace(props.place.id);
  if (!ok) { alert(data.error || 'Could not export this place.'); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.place.name || 'place'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// New tavernroam_place_card_v1 PNG spec — same data as exportJson, embedded
// in a generated placeholder image (places have no avatar concept).
async function exportPng() {
  const { ok, data, blob } = await apiBlobGet(`/api/places/${props.place.id}/card.png`);
  if (!ok) { alert(data.error || 'Could not export this place as a card.'); return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${props.place.name || 'place'}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function remove() {
  if (!confirm(`Remove "${props.place.name}"? Anyone placed there will become unplaced.`)) return;
  const { ok } = await deletePlace(props.place.id);
  if (ok) world.places = world.places.filter((p) => p.id !== props.place.id);
}
</script>

<template>
  <div class="place-row" :class="{ editing }">
    <template v-if="editing">
      <div class="form-grid">
        <div>
          <label>Name</label>
          <input type="text" v-model="name">
        </div>
        <div>
          <label>Area</label>
          <input type="text" v-model="area">
        </div>
        <div class="span2">
          <label>Description</label>
          <textarea v-model="desc"></textarea>
        </div>
        <div>
          <label>Type</label>
          <select v-model="type">
            <option value="communal">Communal</option>
            <option value="private">Private</option>
          </select>
        </div>
        <div class="span2" v-if="type === 'private'">
          <label>Residents</label>
          <div class="checkbox-list">
            <div class="checkbox-field" v-for="c in world.charactersList" :key="c.id">
              <input type="checkbox" :id="`edit-place-owner-${place.id}-${c.id}`" :value="c.id" v-model="ownerIds">
              <label :for="`edit-place-owner-${place.id}-${c.id}`">{{ c.name }}</label>
            </div>
          </div>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn small" @click="save">Save</button>
        <button class="btn secondary small" @click="emit('cancel')">Cancel</button>
        <span class="form-status">{{ status }}</span>
      </div>
    </template>
    <div class="row-view" v-else>
      <div>
        <div class="row-title">
          {{ place.name }}
          <span class="type-badge private" v-if="place.type === 'private'">
            private<template v-if="ownerNames(place).length"> · {{ joinNames(ownerNames(place)) }}</template>
          </span>
          <span class="type-badge" v-else>communal</span>
        </div>
        <div class="row-desc" v-if="place.desc">{{ place.desc }}</div>
        <div class="row-desc" v-else><em>No description yet.</em></div>
      </div>
      <div class="row-actions">
        <button @click="startEdit">Edit</button>
        <button @click="exportJson">Export</button>
        <button @click="exportPng">Export as PNG</button>
        <button class="danger" @click="remove">Remove</button>
      </div>
    </div>
  </div>
</template>
