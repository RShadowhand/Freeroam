<script setup>
import { computed, ref, watch } from 'vue';
import { useWorldStore, RELATIONSHIP_LABELS } from '../../stores/world';
import { setRelationshipLabels, queryRelationships } from '../../api/relationships';
import CardAvatar from '../shared/CardAvatar.vue';

// Relationships live inside the character modal — only the character being
// edited is ever "the source", so instead of listing every other character
// as a row (unusable once there are dozens), only already-set relationships
// show as rows; a dropdown of everyone NOT already related is how a new one
// gets started.
const props = defineProps({ characterId: { type: String, required: true } });
const world = useWorldStore();
const pendingTargetId = ref(null);
const customInputs = ref({}); // targetId -> in-progress custom label text
// Rows are collapsed to name + chips by default (see the template) — only
// one row's add-label controls are expanded at a time, toggled by its own
// +/− button, so adding several labels doesn't require re-clicking after
// each one but browsing the list doesn't cost a whole edit-form's worth of
// height per person either.
const expandedId = ref(null);

watch(() => props.characterId, () => { pendingTargetId.value = null; expandedId.value = null; resetDebug(); });

// --- Debug: test a relationship query ------------------------------------
// Ranks every one of this character's relationships (forward and reverse)
// against a free-text description — e.g. "your friend with the blue eyes"
// — using the same label + identity-embedding scoring real generation
// uses, so you can see the score breakdown for a candidate that didn't
// surface, not just the winners. No LLM call, just the local embedder.
const debugQuery = ref('');
const debugResults = ref([]);
const debugBusy = ref(false);
const debugRan = ref(false);
const debugError = ref('');

function resetDebug() {
  debugQuery.value = '';
  debugResults.value = [];
  debugRan.value = false;
  debugError.value = '';
}

async function runDebugQuery() {
  const query = debugQuery.value.trim();
  if (!query) return;
  debugBusy.value = true;
  debugError.value = '';
  try {
    const { ok, data } = await queryRelationships(props.characterId, { query });
    if (!ok) { debugError.value = data.error || 'Query failed.'; return; }
    debugResults.value = data.results || [];
    debugRan.value = true;
  } finally {
    debugBusy.value = false;
  }
}

// Carries avatarUrl/color alongside the name — with no surname field, two
// characters both named "Megan" read as identical text; the avatar is
// what actually tells them apart, matching how the Cast grid identifies
// people everywhere else.
const allTargets = computed(() => {
  const persona = world.activePersona;
  const targets = [{
    id: 'user',
    name: (persona ? persona.name : 'The visitor') + ' (you)',
    avatarUrl: persona ? persona.avatarUrl : null,
    color: persona ? persona.color : null,
  }];
  world.charactersList.filter((c) => c.id !== props.characterId)
    .forEach((c) => targets.push({ id: c.id, name: c.name, avatarUrl: c.avatarUrl, color: c.color }));
  return targets;
});
const targetsById = computed(() => Object.fromEntries(allTargets.value.map((t) => [t.id, t])));

function labelsFor(targetId) {
  const r = world.relationships.find((x) => x.characterId === props.characterId && x.targetId === targetId);
  return r ? r.labels : [];
}

const relatedIds = computed(() => {
  const ids = new Set(
    world.relationships.filter((r) => r.characterId === props.characterId && r.labels.length).map((r) => r.targetId),
  );
  // A target just picked from the "add" dropdown shows its row immediately
  // (with nothing set yet) so labels can be added right there; it never
  // actually persists until a label is, via setLabels.
  if (pendingTargetId.value && targetsById.value[pendingTargetId.value]) ids.add(pendingTargetId.value);
  return [...ids];
});

const availableTargets = computed(() => allTargets.value.filter((t) => !relatedIds.value.includes(t.id)));

const groupedStandardOptions = (targetId) => Object.entries(RELATIONSHIP_LABELS).map(([group, labels]) => ({
  group, options: labels.filter((l) => !labelsFor(targetId).includes(l)),
})).filter((g) => g.options.length);

async function setLabels(targetId, labels) {
  const { ok } = await setRelationshipLabels(props.characterId, targetId, labels);
  if (!ok) return;
  world.relationships = world.relationships.filter((r) => !(r.characterId === props.characterId && r.targetId === targetId));
  if (labels.length) world.relationships.push({ characterId: props.characterId, targetId, labels });
  pendingTargetId.value = null;
}

function removeLabel(targetId, label) {
  setLabels(targetId, labelsFor(targetId).filter((l) => l !== label));
}
function addStandardLabel(targetId, e) {
  const value = e.target.value;
  e.target.value = '';
  if (!value) return;
  setLabels(targetId, [...labelsFor(targetId), value]);
}
function addCustomLabel(targetId) {
  const val = (customInputs.value[targetId] || '').trim();
  if (!val) return;
  setLabels(targetId, [...labelsFor(targetId), val]);
  customInputs.value[targetId] = '';
}
function onAddTarget(e) {
  const value = e.target.value;
  e.target.value = '';
  if (!value) return;
  pendingTargetId.value = value;
  expandedId.value = value; // a freshly-added row has no labels yet — open straight to where you'd add one
}
function toggleExpand(targetId) {
  expandedId.value = expandedId.value === targetId ? null : targetId;
}
</script>

<template>
  <div>
    <p class="hint">Multiple labels are fine at once (e.g. "ex-wife, friend") — pick from the standard list or type your own.</p>

    <div class="memory-debug">
      <h3 class="memory-debug-title">Debug: test a relationship query</h3>
      <p class="hint">Ranks every one of this character's relationships against a description, so you can see the label vs. person score split — not just what would actually be recalled.</p>
      <div class="row">
        <input
          type="text" v-model="debugQuery" placeholder="e.g. that friend of yours with the blue eyes"
          @keyup.enter="runDebugQuery"
        >
        <button class="btn small" :disabled="debugBusy || !debugQuery.trim()" @click="runDebugQuery">Test</button>
      </div>
      <div class="form-status" v-if="debugError">{{ debugError }}</div>
      <div class="empty-note" v-if="debugRan && !debugResults.length">This character has no relationships to search.</div>
      <div class="memory-row" v-for="r in debugResults" :key="`${r.direction}:${r.otherId}`">
        <div class="memory-meta">
          <span class="badge" :class="r.selected ? 'badge-recalled' : 'badge-dim'">{{ r.selected ? `✓ ${r.selectionReason}` : 'not recalled' }}</span>
          <span class="badge">score {{ r.score.toFixed(3) }}</span>
          <span class="badge" v-if="r.characterScore !== null">label {{ r.labelScore.toFixed(2) }} / person {{ r.characterScore.toFixed(2) }}</span>
          <span class="badge">{{ r.direction === 'forward' ? `${world.charName(characterId) || 'they'} → ${r.otherName}` : `${r.otherName} → ${world.charName(characterId) || 'they'}` }}</span>
        </div>
        <div class="memory-text">{{ r.otherName }}: {{ r.labels.join(', ') || '(no labels)' }}</div>
      </div>
    </div>

    <div class="empty-note" v-if="!relatedIds.length">No relationships set yet — pick someone below to add one.</div>
    <div class="rel-row" v-for="tid in relatedIds" :key="tid">
      <div class="rel-row-main">
        <CardAvatar class="rel-avatar" :name="targetsById[tid]?.name || 'Unknown'" :avatar-url="targetsById[tid]?.avatarUrl" :color="targetsById[tid]?.color" />
        <div class="rel-target">{{ targetsById[tid]?.name || 'Unknown' }}</div>
        <div class="rel-chips">
          <span class="chip" v-for="l in labelsFor(tid)" :key="l">
            {{ l }}<button class="chip-remove" @click="removeLabel(tid, l)">✕</button>
          </span>
          <span class="chip empty" v-if="!labelsFor(tid).length">no relation set</span>
        </div>
        <button
          class="rel-expand-toggle" :class="{ active: expandedId === tid }" type="button"
          :title="expandedId === tid ? 'Hide label controls' : 'Add or edit labels'"
          @click="toggleExpand(tid)"
        >{{ expandedId === tid ? '−' : '+' }}</button>
      </div>
      <div class="rel-add" v-show="expandedId === tid">
        <select @change="addStandardLabel(tid, $event)">
          <option value="">+ add standard label…</option>
          <optgroup v-for="g in groupedStandardOptions(tid)" :key="g.group" :label="g.group">
            <option v-for="l in g.options" :key="l" :value="l">{{ l }}</option>
          </optgroup>
        </select>
        <input
          type="text" placeholder="or type a custom label"
          :value="customInputs[tid] || ''" @input="customInputs[tid] = $event.target.value"
          @keydown.enter.prevent="addCustomLabel(tid)"
        >
        <button class="btn secondary small" @click="addCustomLabel(tid)">Add</button>
      </div>
    </div>
    <div class="field-row">
      <label>Add a relationship</label>
      <select @change="onAddTarget">
        <option value="">+ Add relationship to…</option>
        <option v-for="t in availableTargets" :key="t.id" :value="t.id">{{ t.name }}</option>
      </select>
    </div>
  </div>
</template>
