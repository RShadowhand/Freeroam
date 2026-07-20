<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useCharacterModal } from '../../composables/useCharacterModal';
import { useScheduleModal } from '../../composables/useScheduleModal';
import { createCharacter, updateCharacter, deleteCharacter, placeCharacter } from '../../api/characters';
import { groupedByArea, castPreview } from '../../utils/format';
import CardAvatar from '../shared/CardAvatar.vue';
import RelationshipsSection from './RelationshipsSection.vue';
import MemoriesSection from './MemoriesSection.vue';

const world = useWorldStore();
const characterModal = useCharacterModal();
const scheduleModal = useScheduleModal();

const name = ref('');
const description = ref('');
const personality = ref('');
const scenario = ref('');
const exampleDialogue = ref('');
const status = ref('');

const character = computed(() => characterModal.editingId.value ? world.charactersById[characterModal.editingId.value] : null);
const placement = computed(() => character.value ? world.placements[character.value.id] || null : null);

const placeId = ref('');
const greetingIndex = ref('');

// Details / Relationships / Memories — see the CharacterModal.vue template
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
  placeId.value = placement.value ? placement.value.placeId : '';
  greetingIndex.value = placement.value && placement.value.greetingIndex != null ? String(placement.value.greetingIndex) : '';
  activeTab.value = 'details';
  memoryCount.value = null;
});

const placeGroups = computed(() => groupedByArea(world.places));
const greetings = computed(() => character.value?.greetings || []);

function greetingLabel(g, i) {
  return `${i === 0 ? 'Default' : `Alternate ${i}`}: "${castPreview(g, 40)}"`;
}

async function onPlaceChange() {
  if (!characterModal.editingId.value) return;
  const { ok, data } = await placeCharacter(characterModal.editingId.value, { placeId: placeId.value || null });
  if (ok) world.placements = data.placements;
}
async function onGreetingChange() {
  if (!characterModal.editingId.value) return;
  const { ok, data } = await placeCharacter(characterModal.editingId.value, {
    greetingIndex: greetingIndex.value === '' ? null : parseInt(greetingIndex.value, 10),
  });
  if (ok) world.placements = data.placements;
}

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

          <div v-if="character">
            <div class="form-grid">
              <div class="field-row">
                <label>Place</label>
                <select v-model="placeId" @change="onPlaceChange">
                  <option value="">— not placed —</option>
                  <optgroup v-for="(list, area) in placeGroups" :key="area" :label="area">
                    <option v-for="p in list" :key="p.id" :value="p.id">
                      {{ p.name }} ({{ p.type === 'private' ? `private${p.ownerId ? ' · ' + (world.charName(p.ownerId) || '') : ''}` : 'communal' }})
                    </option>
                  </optgroup>
                </select>
              </div>
              <div class="field-row" v-if="greetings.length">
                <label>Opening line</label>
                <select v-model="greetingIndex" :disabled="!placeId" @change="onGreetingChange">
                  <option value="">No greeting — improvise on arrival</option>
                  <option v-for="(g, i) in greetings" :key="i" :value="String(i)">{{ greetingLabel(g, i) }}</option>
                </select>
              </div>
            </div>
            <button class="btn secondary small" type="button" @click="scheduleModal.open(character.id)">📅 Weekly schedule</button>
          </div>
        </div>

        <!-- Mounted together (not per-tab) once the character exists, so
             both load in the background and their tab badges are accurate
             the moment the modal opens — v-show just picks which one shows. -->
        <template v-if="character">
          <div class="modal-tab-pane" v-show="activeTab === 'relationships'">
            <RelationshipsSection :character-id="character.id" />
          </div>
          <div class="modal-tab-pane" v-show="activeTab === 'memories'">
            <MemoriesSection :character-id="character.id" @total-change="memoryCount = $event" />
          </div>
        </template>
      </div>

      <div class="modal-tab-foot">
        <button class="btn" @click="save">Save</button>
        <button class="btn secondary" @click="characterModal.close()">Cancel</button>
        <button class="btn danger" v-if="character && character.source !== 'builtin'" @click="remove">Remove character</button>
        <span class="form-status">{{ status }}</span>
      </div>
    </div>
  </div>
</template>
