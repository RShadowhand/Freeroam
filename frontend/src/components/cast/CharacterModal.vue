<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useCharacterModal } from '../../composables/useCharacterModal';
import { useScheduleModal } from '../../composables/useScheduleModal';
import { createCharacter, updateCharacter, deleteCharacter, placeCharacter } from '../../api/characters';
import { groupedByArea, castPreview } from '../../utils/format';
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
    <div class="modal wide">
      <h2>{{ character ? `Edit ${character.name}` : 'New character' }}</h2>
      <div class="form-grid">
        <div>
          <label>Name</label>
          <input type="text" v-model="name" placeholder="e.g. Marrow">
        </div>
        <div class="span2">
          <label>Description</label>
          <textarea v-model="description" placeholder="Who are they? Role in the world, appearance, background."></textarea>
        </div>
        <div class="span2">
          <label>Personality <span class="hint-inline">(optional)</span></label>
          <textarea v-model="personality" placeholder="Traits, manner of speaking."></textarea>
        </div>
        <div class="span2">
          <label>Scenario <span class="hint-inline">(optional, opt-in — see Variables page)</span></label>
          <textarea v-model="scenario" placeholder="A specific situation they're in, if any."></textarea>
        </div>
        <div class="span2">
          <label>Example dialogue <span class="hint-inline">(optional, opt-in)</span></label>
          <textarea v-model="exampleDialogue" placeholder="A sample of how they talk."></textarea>
        </div>
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

      <div class="form-actions">
        <button class="btn" @click="save">Save</button>
        <button class="btn secondary" @click="characterModal.close()">Cancel</button>
        <button class="btn danger" v-if="character && character.source !== 'builtin'" @click="remove">Remove character</button>
        <span class="form-status">{{ status }}</span>
      </div>

      <RelationshipsSection v-if="character" :character-id="character.id" />
      <MemoriesSection v-if="character" :character-id="character.id" />
    </div>
  </div>
</template>
