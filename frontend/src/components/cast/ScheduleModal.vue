<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useScheduleModal } from '../../composables/useScheduleModal';
import { saveScheduleSlot as apiSaveScheduleSlot } from '../../api/characters';
import { TIMES_OF_DAY, WEEKDAYS, weekdayFor } from '../../utils/time';
import ScheduleTable from './ScheduleTable.vue';

// One slot (day + time of day) edited at a time, with an overview table of
// everything already set for quick navigation. Edits PUT straight to
// /api/characters/:id/schedule/:day/:timeOfDay so nothing needs a separate
// "save" step at the character-modal level.
const world = useWorldStore();
const scheduleModal = useScheduleModal();

const day = ref(WEEKDAYS[0]);
const timeOfDay = ref(TIMES_OF_DAY[0]);
const place = ref('');
const reason = ref('');
const status = ref('');
const copyFromDay = ref('');
const copyStatus = ref('');

const character = computed(() => scheduleModal.characterId.value ? world.charactersById[scheduleModal.characterId.value] : null);
const copyFromOptions = computed(() => WEEKDAYS.filter((d) => d !== day.value));

watch(scheduleModal.isOpen, (open) => {
  if (!open) return;
  day.value = weekdayFor(world.time.day);
  timeOfDay.value = world.time.timeOfDay;
  status.value = '';
  loadSlotIntoForm();
  copyStatus.value = '';
});

function loadSlotIntoForm() {
  const slot = character.value?.schedule?.[day.value]?.[timeOfDay.value] || null;
  place.value = slot ? slot.placeId : '';
  reason.value = slot ? (slot.reason || '') : '';
}

function onDayChange() {
  loadSlotIntoForm();
  copyStatus.value = '';
}
function pickCell(d, t) {
  day.value = d;
  timeOfDay.value = t;
  loadSlotIntoForm();
}

function applyCharacterUpdate(updated) {
  world.charactersById[scheduleModal.characterId.value] = updated;
  const idx = world.charactersList.findIndex((c) => c.id === scheduleModal.characterId.value);
  if (idx !== -1) world.charactersList[idx] = updated;
}

async function saveSlot(placeIdValue, reasonValue) {
  const { ok, data } = await apiSaveScheduleSlot(scheduleModal.characterId.value, day.value, timeOfDay.value, { placeId: placeIdValue, reason: reasonValue });
  if (!ok) { status.value = data.error || 'Could not save.'; return; }
  applyCharacterUpdate(data.character);
  status.value = 'Saved.';
  loadSlotIntoForm();
}

function save() {
  if (!place.value) { status.value = 'Pick a place, or use Clear slot to remove it.'; return; }
  saveSlot(place.value, reason.value.trim());
}
function clear() {
  saveSlot(null, '');
}

// Copies every set time-of-day slot from another day onto the day
// currently selected in the editor — a slot the source day doesn't have
// set is left untouched on the target, rather than clearing it.
async function copyFrom() {
  if (!copyFromDay.value || copyFromDay.value === day.value) return;
  const source = character.value.schedule?.[copyFromDay.value] || {};
  const slots = TIMES_OF_DAY.filter((t) => source[t] && source[t].placeId);
  if (!slots.length) { copyStatus.value = `${copyFromDay.value} has nothing set.`; return; }

  copyStatus.value = 'Copying…';
  for (const t of slots) {
    const { ok, data } = await apiSaveScheduleSlot(scheduleModal.characterId.value, day.value, t, {
      placeId: source[t].placeId, reason: source[t].reason || '',
    });
    if (ok) applyCharacterUpdate(data.character);
  }
  copyStatus.value = `Copied ${slots.length} slot${slots.length === 1 ? '' : 's'} from ${copyFromDay.value}.`;
  loadSlotIntoForm();
}
</script>

<template>
  <div class="modal-overlay" v-if="scheduleModal.isOpen.value && character" @click="(e) => { if (e.target === e.currentTarget) scheduleModal.close(); }">
    <div class="modal">
      <h2>Schedule — {{ character.name }}</h2>
      <p class="hint">Where this character should be for a given day and time of day. Characters move to their scheduled place automatically when you advance or jump the world clock. A slot with nothing set just leaves them wherever they already are.</p>
      <div class="form-grid">
        <div class="field-row">
          <label>Day</label>
          <select v-model="day" @change="onDayChange">
            <option v-for="d in WEEKDAYS" :key="d" :value="d">{{ d }}</option>
          </select>
        </div>
        <div class="field-row">
          <label>Time of day</label>
          <select v-model="timeOfDay" @change="loadSlotIntoForm">
            <option v-for="t in TIMES_OF_DAY" :key="t" :value="t">{{ t }}</option>
          </select>
        </div>
        <div class="field-row">
          <label>Place</label>
          <select v-model="place">
            <option value="">— pick a place —</option>
            <option v-for="p in world.places" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
        <div class="field-row">
          <label>Reason <span class="hint-inline">(pick one or type your own)</span></label>
          <input type="text" v-model="reason" list="scheduleReasonOptions" placeholder="e.g. Work">
          <datalist id="scheduleReasonOptions">
            <option value="Home"></option>
            <option value="Work"></option>
            <option value="Meal"></option>
            <option value="Errand"></option>
            <option value="Leisure"></option>
            <option value="Sleep"></option>
            <option value="Social"></option>
          </datalist>
        </div>
      </div>
      <div class="form-actions">
        <button class="btn small" @click="save">Save slot</button>
        <button class="btn secondary small" @click="clear">Clear slot</button>
        <span class="form-status">{{ status }}</span>
      </div>
      <ScheduleTable :character="character" @pick="pickCell" />
      <div class="form-actions schedule-copy-row">
        <label style="margin:0;">Copy all slots from</label>
        <select v-model="copyFromDay">
          <option v-for="d in copyFromOptions" :key="d" :value="d">{{ d }}</option>
        </select>
        <button class="btn secondary small" @click="copyFrom">Copy</button>
        <span class="form-status">{{ copyStatus }}</span>
      </div>
      <div class="form-actions">
        <button class="btn secondary" @click="scheduleModal.close()">Close</button>
      </div>
    </div>
  </div>
</template>
