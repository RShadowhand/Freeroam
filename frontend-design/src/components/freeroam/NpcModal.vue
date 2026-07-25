<script setup>
import { ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useChatStore } from '../../stores/chat';
import { useNpcModal } from '../../composables/useNpcModal';
import { createCharacter, draftCharacterDescription, placeCharacter } from '../../api/characters';

// Save-as-character modal — promotes an NPC line (or any typed name) to a
// real character card. "Draft persona" asks the backend to write a starting
// persona from the current place's transcript; placement covers the three
// framings a new character can appear as: showing up here, encountered
// randomly elsewhere, or just mentioned (left unplaced for Cast later).
const world = useWorldStore();
const chat = useChatStore();
const npcModal = useNpcModal();

const name = ref('');
const description = ref('');
const placement = ref('here');
const draftStatus = ref('');
const saveStatus = ref('');

watch(npcModal.isOpen, (open) => {
  if (open) {
    name.value = npcModal.context.value.name;
    description.value = '';
    placement.value = 'here';
    draftStatus.value = '';
    saveStatus.value = '';
  }
});

async function draft() {
  if (!name.value.trim()) { draftStatus.value = 'Enter a name first.'; return; }
  draftStatus.value = 'Drafting…';
  const log = chat.logs[npcModal.context.value.placeId] || [];
  const { ok, data } = await draftCharacterDescription({
    name: name.value.trim(), log, userLabel: world.activePersona?.name || 'Visitor',
  });
  if (!ok) { draftStatus.value = data.error || 'Could not draft a persona.'; return; }
  description.value = data.description;
  draftStatus.value = '';
}

async function save() {
  if (!name.value.trim()) { saveStatus.value = 'Name is required.'; return; }
  const { ok, data } = await createCharacter({ name: name.value.trim(), description: description.value.trim() });
  if (!ok) { saveStatus.value = data.error || 'Could not save character.'; return; }

  world.charactersList.push(data.character);
  world.charactersById[data.character.id] = data.character;
  chat.savedNpcNames.add(name.value.trim().toLowerCase());

  let placeId = null;
  if (placement.value === 'here' && npcModal.context.value.placeId) {
    placeId = npcModal.context.value.placeId;
  } else if (placement.value === 'random' && world.places.length) {
    placeId = world.places[Math.floor(Math.random() * world.places.length)].id;
  }
  if (placeId) {
    const placeRes = await placeCharacter(data.character.id, { placeId });
    if (placeRes.ok) world.placements = placeRes.data.placements;
  }

  npcModal.close();
}
</script>

<template>
  <div class="modal-overlay" v-if="npcModal.isOpen.value" @click="(e) => { if (e.target === e.currentTarget) npcModal.close(); }">
    <div class="modal">
      <h2>Save as character</h2>
      <div class="form-grid">
        <div class="span2">
          <label>Name</label>
          <input type="text" v-model="name" placeholder="Who are they?">
        </div>
        <div class="span2">
          <label>Description</label>
          <textarea v-model="description" placeholder="What are they like? Leave blank and draft one from the scene."></textarea>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn secondary small" type="button" @click="draft">✨ Draft description from this scene</button>
        <span class="form-status">{{ draftStatus }}</span>
      </div>
      <div class="span2">
        <label>Placement</label>
        <div class="placement-options">
          <label><input type="radio" value="here" v-model="placement"> Here — they showed up in this place</label>
          <label><input type="radio" value="random" v-model="placement"> Somewhere random — encountered in the wild</label>
          <label><input type="radio" value="manual" v-model="placement"> Leave unplaced — just mentioned, place later via Cast</label>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn" type="button" @click="save">Save character</button>
        <button class="btn secondary" type="button" @click="npcModal.close()">Cancel</button>
        <span class="form-status">{{ saveStatus }}</span>
      </div>
    </div>
  </div>
</template>
