<script setup>
import { computed, ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { updatePersona, deletePersona, setActivePersona } from '../../api/personas';
import CardAvatar from '../shared/CardAvatar.vue';
import ExpandableTextarea from '../shared/ExpandableTextarea.vue';

const props = defineProps({ persona: { type: Object, required: true } });
const world = useWorldStore();
const editing = ref(false);
const name = ref(props.persona.name);
const description = ref(props.persona.description || '');
const status = ref('');

const isActive = computed(() => props.persona.id === world.activePersonaId);

function startEdit() {
  name.value = props.persona.name;
  description.value = props.persona.description || '';
  status.value = '';
  editing.value = true;
}

async function save() {
  const { ok, data } = await updatePersona(props.persona.id, { name: name.value.trim(), description: description.value.trim() });
  if (!ok) { status.value = data.error || 'Could not save changes.'; return; }
  const i = world.personasList.findIndex((p) => p.id === props.persona.id);
  world.personasList[i] = data.persona;
  editing.value = false;
}

async function activate() {
  const { ok, data } = await setActivePersona(props.persona.id);
  if (ok) world.activePersonaId = data.activePersonaId;
}
async function deactivate() {
  const { ok, data } = await setActivePersona(null);
  if (ok) world.activePersonaId = data.activePersonaId;
}
async function remove() {
  if (!confirm(`Remove persona "${props.persona.name}"?`)) return;
  const { ok } = await deletePersona(props.persona.id);
  if (ok) {
    world.personasList = world.personasList.filter((p) => p.id !== props.persona.id);
    if (world.activePersonaId === props.persona.id) world.activePersonaId = null;
  }
}
</script>

<template>
  <div class="char-card">
    <template v-if="editing">
      <div class="form-grid">
        <div class="span2">
          <label>Name</label>
          <input type="text" v-model="name">
        </div>
        <div class="span2">
          <label>Description</label>
          <ExpandableTextarea class="persona-edit-text" v-model="description" />
        </div>
      </div>
      <div class="card-actions">
        <button class="btn small" @click="save">Save</button>
        <button class="btn secondary small" @click="editing = false">Cancel</button>
      </div>
      <div class="form-status" v-if="status">{{ status }}</div>
    </template>
    <template v-else>
      <div class="card-top">
        <CardAvatar :name="persona.name" :avatar-url="persona.avatarUrl" :color="persona.color" />
        <div>
          <div class="card-name">{{ persona.name }}</div>
          <span class="active-badge" v-if="isActive">Active</span>
        </div>
      </div>
      <div class="card-persona">
        <template v-if="persona.description">{{ persona.description }}</template>
        <em v-else>No description yet.</em>
      </div>
      <div class="card-actions">
        <button class="btn secondary small" v-if="isActive" @click="deactivate">Clear active</button>
        <button class="btn secondary small" v-else @click="activate">Set active</button>
        <span style="display:flex;gap:10px;">
          <button @click="startEdit">Edit</button>
          <button class="delete-btn" @click="remove">Remove</button>
        </span>
      </div>
    </template>
  </div>
</template>
