<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { usePersonaModal } from '../../composables/usePersonaModal';
import { createPersona, updatePersona, deletePersona, exportPersona } from '../../api/personas';
import CardAvatar from '../shared/CardAvatar.vue';
import ExpandableTextarea from '../shared/ExpandableTextarea.vue';

const world = useWorldStore();
const personaModal = usePersonaModal();

const name = ref('');
const description = ref('');
const avatarInput = ref(null);
const status = ref('');
const saving = ref(false);

const persona = computed(() => (
  personaModal.editingId.value ? world.personasList.find((p) => p.id === personaModal.editingId.value) || null : null
));

watch(personaModal.isOpen, (open) => {
  if (!open) return;
  const p = persona.value;
  name.value = p ? p.name : '';
  description.value = p ? (p.description || '') : '';
  status.value = '';
  saving.value = false;
});

async function save() {
  if (!name.value.trim() || saving.value) { if (!name.value.trim()) status.value = 'Name is required.'; return; }
  saving.value = true;
  try {
    if (personaModal.mode.value === 'create') {
      const { ok, data } = await createPersona({
        name: name.value.trim(), description: description.value.trim(),
        avatarFile: avatarInput.value?.files?.[0] || null,
      });
      if (!ok) { status.value = data.error || 'Could not add persona.'; return; }
      world.personasList.push(data.persona);
    } else {
      const avatarFile = avatarInput.value?.files?.[0] || null;
      const { ok, data } = await updatePersona(personaModal.editingId.value, {
        name: name.value.trim(), description: description.value.trim(), avatarFile,
      });
      if (!ok) { status.value = data.error || 'Could not save changes.'; return; }
      const idx = world.personasList.findIndex((p) => p.id === personaModal.editingId.value);
      if (idx !== -1) world.personasList[idx] = data.persona;
    }
    personaModal.close();
  } finally {
    saving.value = false;
  }
}

// Same { personas: [...] } wire shape /api/personas/import expects — see
// CharacterModal.vue's exportJson for the Blob-download pattern this mirrors.
async function exportJson() {
  const id = personaModal.editingId.value;
  if (!id) return;
  const { ok, data } = await exportPersona(id);
  if (!ok) { status.value = data.error || 'Could not export this persona.'; return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${persona.value?.name || 'persona'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function remove() {
  const id = personaModal.editingId.value;
  if (!id) return;
  if (!confirm(`Remove persona "${persona.value?.name || 'this persona'}"?`)) return;
  const { ok } = await deletePersona(id);
  if (ok) {
    world.personasList = world.personasList.filter((p) => p.id !== id);
    if (world.activePersonaId === id) world.activePersonaId = null;
    personaModal.close();
  }
}
</script>

<template>
  <div class="modal-overlay" v-if="personaModal.isOpen.value" @click="(e) => { if (e.target === e.currentTarget) personaModal.close(); }">
    <div class="modal">
      <div class="modal-head-row">
        <h2>{{ persona ? `Edit ${persona.name}` : 'New persona' }}</h2>
        <button class="modal-close" type="button" @click="personaModal.close()">✕</button>
      </div>

      <div class="char-modal-identity">
        <CardAvatar v-if="persona" :name="persona.name" :avatar-url="persona.avatarUrl" :color="persona.color" />
        <div class="field-row" v-if="persona">
          <label>Avatar</label>
          <input type="file" ref="avatarInput" accept="image/png,image/jpeg,image/webp">
        </div>
        <div class="field-row">
          <label>Name</label>
          <input type="text" v-model="name" placeholder="e.g. Kael">
        </div>
      </div>

      <div class="field-row">
        <label>Description</label>
        <ExpandableTextarea
          class="persona-edit-text" v-model="description"
          placeholder='Who are you, in this world? Folded into the system prompt as your persona description, and used to replace "the visitor" in scenes.'
        />
      </div>

      <div class="modal-tab-foot">
        <button class="btn" :disabled="saving" @click="save">Save</button>
        <button class="btn secondary" @click="personaModal.close()">Cancel</button>
        <button class="btn secondary" v-if="persona" @click="exportJson">Export</button>
        <button class="btn danger" v-if="persona" @click="remove">Remove persona</button>
        <span class="form-status">{{ status }}</span>
      </div>
    </div>
  </div>
</template>
