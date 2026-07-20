<script setup>
import { ref } from 'vue';
import { useWorldStore } from '../../stores/world';
import { createPersona } from '../../api/personas';

const world = useWorldStore();
const name = ref('');
const description = ref('');
const avatarInput = ref(null);
const status = ref('');

async function submit() {
  status.value = '';
  if (!name.value.trim()) { status.value = 'Name is required.'; return; }
  const { ok, data } = await createPersona({
    name: name.value.trim(), description: description.value.trim(),
    avatarFile: avatarInput.value.files[0] || null,
  });
  if (!ok) { status.value = data.error || 'Could not add persona.'; return; }
  world.personasList.push(data.persona);
  name.value = '';
  description.value = '';
  avatarInput.value.value = '';
}
</script>

<template>
  <div class="form-card">
    <h2>Add a persona</h2>
    <div class="form-grid">
      <div>
        <label>Name</label>
        <input type="text" v-model="name" placeholder="e.g. Kael">
      </div>
      <div>
        <label>Avatar (optional)</label>
        <input type="file" ref="avatarInput" accept="image/png,image/jpeg,image/webp">
      </div>
      <div class="span2">
        <label>Description</label>
        <textarea class="persona-edit-text" v-model="description" placeholder='Who are you, in this world? Folded into the system prompt as your persona description, and used to replace "the visitor" in scenes.'></textarea>
      </div>
    </div>
    <div class="form-actions">
      <button class="btn" @click="submit">Add persona</button>
      <span class="form-status">{{ status }}</span>
    </div>
  </div>
</template>
