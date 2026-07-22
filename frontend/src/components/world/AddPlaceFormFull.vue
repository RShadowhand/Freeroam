<script setup>
import { ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { addPlace } from '../../api/places';

const world = useWorldStore();
const name = ref('');
const area = ref('');
const desc = ref('');
const type = ref('communal');
const ownerIds = ref([]);
const status = ref('');

async function submit() {
  status.value = '';
  if (!name.value.trim()) { status.value = 'Name is required.'; return; }
  const body = {
    name: name.value.trim(),
    area: area.value.trim(),
    desc: desc.value.trim(),
    type: type.value,
    ownerIds: ownerIds.value,
  };
  const { ok, data } = await addPlace(body);
  if (!ok) { status.value = data.error || 'Could not add place.'; return; }
  world.places.push(data.place);
  name.value = '';
  area.value = '';
  desc.value = '';
  type.value = 'communal';
  ownerIds.value = [];
}
</script>

<template>
  <div class="form-card">
    <h2>Add a place</h2>
    <div class="form-grid">
      <div>
        <label>Name</label>
        <input type="text" v-model="name" placeholder="e.g. The Night Market">
      </div>
      <div>
        <label>Area (optional grouping)</label>
        <input type="text" v-model="area" placeholder="e.g. Riverside, Uptown...">
      </div>
      <div class="span2">
        <label>Description</label>
        <textarea v-model="desc" placeholder="What does this place feel like?"></textarea>
      </div>
      <div>
        <label>Type</label>
        <select v-model="type">
          <option value="communal">Communal — open to anyone</option>
          <option value="private">Private — belongs to a resident</option>
        </select>
      </div>
      <div class="span2" v-if="type === 'private'">
        <label>Residents</label>
        <div class="checkbox-list">
          <div class="checkbox-field" v-for="c in world.charactersList" :key="c.id">
            <input type="checkbox" :id="`new-place-owner-${c.id}`" :value="c.id" v-model="ownerIds">
            <label :for="`new-place-owner-${c.id}`">{{ c.name }}</label>
          </div>
        </div>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn" @click="submit">Add place</button>
      <span class="form-status">{{ status }}</span>
    </div>
  </div>
</template>
