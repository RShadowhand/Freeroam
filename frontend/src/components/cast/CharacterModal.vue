<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useCharacterModal } from '../../composables/useCharacterModal';
import { createCharacter, updateCharacter, deleteCharacter, exportCharacter } from '../../api/characters';
import { apiBlobGet } from '../../api/http';
import CardAvatar from '../shared/CardAvatar.vue';
import RelationshipsSection from './RelationshipsSection.vue';
import MemoriesSection from './MemoriesSection.vue';
import PlaceScheduleSection from './PlaceScheduleSection.vue';

const world = useWorldStore();
const characterModal = useCharacterModal();

const name = ref('');
const description = ref('');
const personality = ref('');
const scenario = ref('');
const exampleDialogue = ref('');
const status = ref('');

const character = computed(() => characterModal.editingId.value ? world.charactersById[characterModal.editingId.value] : null);

// Details / Relationships / Memories / Place & Schedule — see the CharacterModal.vue template
// comment above the tab bar for why this replaced one long scroll.
const activeTab = ref('details');
const memoryCount = ref(null); // null until MemoriesSection's own fetch reports in — see its total-change emit
// Mirrors RelationshipsSection's own relatedIds logic (relationships where
// this character is the source) so the tab badge matches what that tab
// actually shows, rather than recomputing a different definition of
// "how many relationships."
const relationshipCount = computed(() => {
  if (!character.value) return 0;
  return world.relationships.filter((r) => r.characterId === character.value.id && r.labels.length).length;
});

watch(characterModal.isOpen, (open) => {
  if (!open) return;
  const c = character.value;
  name.value = c ? c.name : '';
  description.value = c ? (c.description || '') : '';
  personality.value = c ? (c.personality || '') : '';
  scenario.value = c ? (c.scenario || '') : '';
  exampleDialogue.value = c ? (c.exampleDialogue || '') : '';
  status.value = '';
  activeTab.value = 'details';
  memoryCount.value = null;
});

async function save() {
  if (!name.value.trim()) { status.value = 'Name is required.'; return; }
  const body = {
    name: name.value.trim(),
    description: description.value.trim(),
    personality: personality.value.trim(),
    scenario: scenario.value.trim(),
    exampleDialogue: exampleDialogue.value.trim(),
  };
  if (characterModal.mode.value === 'create') {
    const { ok, data } = await createCharacter(body);
    if (!ok) { status.value = data.error || 'request failed'; return; }
    world.charactersList.push(data.character);
    world.charactersById[data.character.id] = data.character;
  } else {
    const { ok, data } = await updateCharacter(characterModal.editingId.value, body);
    if (!ok) { status.value = data.error || 'request failed'; return; }
    const idx = world.charactersList.findIndex((c) => c.id === characterModal.editingId.value);
    if (idx !== -1) world.charactersList[idx] = data.character;
    world.charactersById[characterModal.editingId.value] = data.character;
  }
  characterModal.close();
}

// Same { characters: [...] } wire shape /api/characters/import expects —
// see PresetCard.vue's exportJson for the Blob-download pattern this mirrors.
async function exportJson() {
  const id = characterModal.editingId.value;
  if (!id) return;
  const { ok, data } = await exportCharacter(id);
  if (!ok) { status.value = data.error || 'Could not export this character.'; return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${character.value?.name || 'character'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

// TavernCard-style PNG export — embeds the same data exportJson downloads
// as JSON into a chunk on the character's own avatar (or a generated
// placeholder), via GET /api/characters/:id/card.png.
async function exportPng() {
  const id = characterModal.editingId.value;
  if (!id) return;
  const { ok, data, blob } = await apiBlobGet(`/api/characters/${id}/card.png`);
  if (!ok) { status.value = data.error || 'Could not export this character as a card.'; return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${character.value?.name || 'character'}.png`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function remove() {
  const id = characterModal.editingId.value;
  if (!id) return;
  if (!confirm(`Remove ${character.value?.name || 'this character'} from the cast?`)) return;
  const { ok } = await deleteCharacter(id);
  if (ok) {
    world.charactersList = world.charactersList.filter((c) => c.id !== id);
    delete world.charactersById[id];
    delete world.placements[id];
    characterModal.close();
  }
}
</script>

<template>
  <div class="modal-overlay" v-if="characterModal.isOpen.value" @click="(e) => { if (e.target === e.currentTarget) characterModal.close(); }">
    <div class="modal wide tabbed">
      <div class="modal-head-row">
        <h2>{{ character ? `Edit ${character.name}` : 'New character' }}</h2>
        <button class="modal-close" type="button" @click="characterModal.close()">✕</button>
      </div>

      <!-- In create mode there's no character id yet for Relationships/
           Memories to attach to, so only Details is shown until Save. -->
      <div class="modal-tabs">
        <button class="modal-tab" :class="{ active: activeTab === 'details' }" type="button" @click="activeTab = 'details'">Details</button>
        <template v-if="character">
          <button class="modal-tab" :class="{ active: activeTab === 'relationships' }" type="button" @click="activeTab = 'relationships'">
            Relationships <span class="count" v-if="relationshipCount">{{ relationshipCount }}</span>
          </button>
          <button class="modal-tab" :class="{ active: activeTab === 'memories' }" type="button" @click="activeTab = 'memories'">
            Memories <span class="count" v-if="memoryCount">{{ memoryCount }}</span>
          </button>
          <button class="modal-tab" :class="{ active: activeTab === 'place' }" type="button" @click="activeTab = 'place'">Place &amp; Schedule</button>
        </template>
      </div>

      <div class="modal-tab-body">
        <div class="modal-tab-pane" v-show="activeTab === 'details'">
          <div class="char-modal-identity">
            <CardAvatar v-if="character" :name="character.name" :avatar-url="character.avatarUrl" :color="character.color" />
            <div class="field-row">
              <label>Name</label>
              <input type="text" v-model="name" placeholder="e.g. Marrow">
            </div>
          </div>
          <div class="field-row">
            <label>Description</label>
            <textarea v-model="description" rows="6" placeholder="Who are they? Role in the world, appearance, background."></textarea>
          </div>
          <div class="form-grid">
            <div>
              <label>Personality <span class="hint-inline">(optional)</span></label>
              <textarea v-model="personality" rows="4" placeholder="Traits, manner of speaking."></textarea>
            </div>
            <div>
              <label>Scenario <span class="hint-inline">(optional, opt-in — see Variables page)</span></label>
              <textarea v-model="scenario" rows="4" placeholder="A specific situation they're in, if any."></textarea>
            </div>
          </div>
          <div class="field-row">
            <label>Example dialogue <span class="hint-inline">(optional, opt-in)</span></label>
            <textarea v-model="exampleDialogue" rows="4" placeholder="A sample of how they talk."></textarea>
          </div>
          <p class="hint">Only Description (and Personality, if a preset asks for it) are sent by default. Scenario and Example dialogue are opt-in — they're only included if the active prompt preset has a block for them.</p>
        </div>

        <!-- Mounted together (not per-tab) once the character exists, so
             all tabs load in the background and their badges are accurate
             the moment the modal opens — v-show just picks which one shows. -->
        <template v-if="character">
          <div class="modal-tab-pane" v-show="activeTab === 'relationships'">
            <RelationshipsSection :character-id="character.id" />
          </div>
          <div class="modal-tab-pane" v-show="activeTab === 'memories'">
            <MemoriesSection :character-id="character.id" @total-change="memoryCount = $event" />
          </div>
          <div class="modal-tab-pane" v-show="activeTab === 'place'">
            <PlaceScheduleSection :character-id="character.id" />
          </div>
        </template>
      </div>

      <div class="modal-tab-foot">
        <button class="btn" @click="save">Save</button>
        <button class="btn secondary" @click="characterModal.close()">Cancel</button>
        <button class="btn secondary" v-if="character" @click="exportJson">Export</button>
        <button class="btn secondary" v-if="character" @click="exportPng">Export as PNG</button>
        <button class="btn danger" v-if="character && character.source !== 'builtin'" @click="remove">Remove character</button>
        <span class="form-status">{{ status }}</span>
      </div>
    </div>
  </div>
</template>
