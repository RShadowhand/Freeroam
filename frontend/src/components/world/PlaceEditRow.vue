<script setup>
import { ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { updatePlace, deletePlace } from '../../api/places';

const props = defineProps({ place: { type: Object, required: true }, editing: { type: Boolean, default: false } });
const emit = defineEmits(['edit', 'cancel']);
const world = useWorldStore();

const name = ref(props.place.name);
const area = ref(props.place.area || '');
const desc = ref(props.place.desc || '');
const type = ref(props.place.type);
const ownerId = ref(props.place.ownerId || '');
const status = ref('');

function startEdit() {
  name.value = props.place.name;
  area.value = props.place.area || '';
  desc.value = props.place.desc || '';
  type.value = props.place.type;
  ownerId.value = props.place.ownerId || '';
  status.value = '';
  emit('edit');
}

async function save() {
  const body = {
    name: name.value.trim(), area: area.value.trim(), desc: desc.value.trim(),
    type: type.value, ownerId: ownerId.value || null,
  };
  const { ok, data } = await updatePlace(props.place.id, body);
  if (!ok) { status.value = data.error || 'Could not save changes.'; return; }
  const idx = world.places.findIndex((p) => p.id === props.place.id);
  world.places[idx] = data.place;
  emit('cancel');
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
        <div v-if="type === 'private'">
          <label>Resident</label>
          <select v-model="ownerId">
            <option value="">— unassigned —</option>
            <option v-for="c in world.charactersList" :key="c.id" :value="c.id">{{ c.name }}</option>
          </select>
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
            private<template v-if="place.ownerId"> · {{ world.charName(place.ownerId) || '?' }}</template>
          </span>
          <span class="type-badge" v-else>communal</span>
        </div>
        <div class="row-desc" v-if="place.desc">{{ place.desc }}</div>
        <div class="row-desc" v-else><em>No description yet.</em></div>
      </div>
      <div class="row-actions">
        <button @click="startEdit">Edit</button>
        <button class="danger" @click="remove">Remove</button>
      </div>
    </div>
  </div>
</template>
