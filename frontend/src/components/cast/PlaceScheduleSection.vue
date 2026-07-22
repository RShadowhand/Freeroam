<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import { placeCharacter, saveScheduleSlot as apiSaveScheduleSlot } from '../../api/characters';
import { groupedByArea, castPreview, joinNames } from '../../utils/format';
import { TIMES_OF_DAY, WEEKDAYS, weekdayFor } from '../../utils/time';
import ScheduleTable from './ScheduleTable.vue';

// Place + Opening line + the weekly schedule editor, formerly split across
// the Details tab and a separate ScheduleModal squeezed into the default
// 480px modal width. Both are "where is this character" concerns, so they
// share a tab now, and the schedule grid (7 days x 7 times of day) finally
// gets the width of the wide character modal instead of a cramped 2-col
// form-grid.
const props = defineProps({ characterId: { type: String, required: true } });
const world = useWorldStore();

const character = computed(() => world.charactersById[props.characterId] || null);
const placement = computed(() => world.placements[props.characterId] || null);
const placeGroups = computed(() => groupedByArea(world.places));
const greetings = computed(() => character.value?.greetings || []);

function placeTypeLabel(p) {
  if (p.type !== 'private') return 'communal';
  const owners = (p.ownerIds || []).map((id) => world.charName(id)).filter(Boolean);
  return `private${owners.length ? ' · ' + joinNames(owners) : ''}`;
}

const placeId = ref('');
const greetingIndex = ref('');

const day = ref(WEEKDAYS[0]);
const timeOfDay = ref(TIMES_OF_DAY[0]);
const slotPlaceId = ref('');
const reason = ref('');
const status = ref('');
const copyFromDay = ref('');
const copyStatus = ref('');
const copyFromOptions = computed(() => WEEKDAYS.filter((d) => d !== day.value));

watch(() => props.characterId, () => {
  placeId.value = placement.value ? placement.value.placeId : '';
  greetingIndex.value = placement.value && placement.value.greetingIndex != null ? String(placement.value.greetingIndex) : '';
  day.value = weekdayFor(world.time.day);
  timeOfDay.value = world.time.timeOfDay;
  status.value = '';
  copyStatus.value = '';
  loadSlotIntoForm();
}, { immediate: true });

function greetingLabel(g, i) {
  return `${i === 0 ? 'Default' : `Alternate ${i}`}: "${castPreview(g, 40)}"`;
}

async function onPlaceChange() {
  const { ok, data } = await placeCharacter(props.characterId, { placeId: placeId.value || null });
  if (ok) world.placements = data.placements;
}
async function onGreetingChange() {
  const { ok, data } = await placeCharacter(props.characterId, {
    greetingIndex: greetingIndex.value === '' ? null : parseInt(greetingIndex.value, 10),
  });
  if (ok) world.placements = data.placements;
}

function loadSlotIntoForm() {
  const slot = character.value?.schedule?.[day.value]?.[timeOfDay.value] || null;
  slotPlaceId.value = slot ? slot.placeId : '';
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
  world.charactersById[props.characterId] = updated;
  const idx = world.charactersList.findIndex((c) => c.id === props.characterId);
  if (idx !== -1) world.charactersList[idx] = updated;
}

async function saveSlot(placeIdValue, reasonValue) {
  const { ok, data } = await apiSaveScheduleSlot(props.characterId, day.value, timeOfDay.value, { placeId: placeIdValue, reason: reasonValue });
  if (!ok) { status.value = data.error || 'Could not save.'; return; }
  applyCharacterUpdate(data.character);
  status.value = 'Saved.';
  loadSlotIntoForm();
}
function save() {
  if (!slotPlaceId.value) { status.value = 'Pick a place, or use Clear slot to remove it.'; return; }
  saveSlot(slotPlaceId.value, reason.value.trim());
}
function clear() {
  saveSlot(null, '');
}

async function copyFrom() {
  if (!copyFromDay.value || copyFromDay.value === day.value) return;
  const source = character.value.schedule?.[copyFromDay.value] || {};
  const slots = TIMES_OF_DAY.filter((t) => source[t] && source[t].placeId);
  if (!slots.length) { copyStatus.value = `${copyFromDay.value} has nothing set.`; return; }

  copyStatus.value = 'Copying…';
  for (const t of slots) {
    const { ok, data } = await apiSaveScheduleSlot(props.characterId, day.value, t, {
      placeId: source[t].placeId, reason: source[t].reason || '',
    });
    if (ok) applyCharacterUpdate(data.character);
  }
  copyStatus.value = `Copied ${slots.length} slot${slots.length === 1 ? '' : 's'} from ${copyFromDay.value}.`;
  loadSlotIntoForm();
}
</script>

<template>
  <div v-if="character">
    <div class="form-grid">
      <div class="field-row">
        <label>Place</label>
        <select v-model="placeId" @change="onPlaceChange">
          <option value="">— not placed —</option>
          <optgroup v-for="(list, area) in placeGroups" :key="area" :label="area">
            <option v-for="p in list" :key="p.id" :value="p.id">
              {{ p.name }} ({{ placeTypeLabel(p) }})
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

    <div class="section-divider">
      <h3>Weekly schedule</h3>
      <p class="hint">Where this character should be for a given day and time of day. Characters move to their scheduled place automatically when you advance or jump the world clock. A slot with nothing set just leaves them wherever they already are.</p>
    </div>

    <div class="schedule-editor">
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
          <select v-model="slotPlaceId">
            <option value="">— pick a place —</option>
            <option v-for="p in world.places" :key="p.id" :value="p.id">{{ p.name }}</option>
          </select>
        </div>
      </div>
      <div class="field-row schedule-reason-row">
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
      <div class="form-actions">
        <button class="btn small" type="button" @click="save">Save slot</button>
        <button class="btn secondary small" type="button" @click="clear">Clear slot</button>
        <span class="form-status">{{ status }}</span>
      </div>

      <ScheduleTable :character="character" @pick="pickCell" />

      <div class="form-actions schedule-copy-row">
        <label style="margin:0;">Copy all slots from</label>
        <select v-model="copyFromDay">
          <option v-for="d in copyFromOptions" :key="d" :value="d">{{ d }}</option>
        </select>
        <button class="btn secondary small" type="button" @click="copyFrom">Copy</button>
        <span class="form-status">{{ copyStatus }}</span>
      </div>
    </div>
  </div>
</template>
