<script setup>
import { computed, reactive, watch } from 'vue';
import { useWorldStore } from '../../stores/world';
import {
  updatePreset, deletePreset, setActivePreset, createPreset, exportPreset,
} from '../../api/presets';
import PromptBlockEditor from './PromptBlockEditor.vue';

const DEFAULT_CONTEXT_LENGTH = 8192;
const DEFAULT_MAX_REPLY_TOKENS = 1000;

const props = defineProps({
  preset: { type: Object, required: true },
  standardBlocks: { type: Array, required: true },
  markerLabels: { type: Object, required: true },
});
const world = useWorldStore();

function freshDraft() {
  return reactive({
    name: props.preset.name,
    contextLength: props.preset.contextLength || DEFAULT_CONTEXT_LENGTH,
    maxReplyTokens: props.preset.maxReplyTokens || DEFAULT_MAX_REPLY_TOKENS,
    memoryAsSeparateMessage: !!props.preset.memoryAsSeparateMessage,
    prompts: props.preset.prompts.map((p) => ({ ...p })),
  });
}

const draft = freshDraft();
// A fresh draft any time the underlying preset identity changes (switching
// which preset this card renders).
watch(() => props.preset.id, () => { Object.assign(draft, freshDraft()); });

const isActive = computed(() => props.preset.id === world.activePresetId);
const addBlockValue = reactive({ value: '' });
const status = reactive({ text: '' });

const availableStandardBlocks = computed(() => {
  const present = new Set(draft.prompts.map((p) => p.identifier));
  return props.standardBlocks.filter((b) => !present.has(b.identifier));
});

function uniqueIdentifier(base, existingIds) {
  let id = base, n = 2;
  const ids = new Set(existingIds);
  while (ids.has(id)) { id = `${base}-${n}`; n += 1; }
  return id;
}

function addBlock() {
  const value = addBlockValue.value;
  addBlockValue.value = '';
  if (!value) return;
  const ids = draft.prompts.map((p) => p.identifier);
  if (value === '__custom__') {
    draft.prompts.push({ identifier: uniqueIdentifier('custom', ids), name: 'New block', role: 'system', content: '', marker: false, enabled: true });
    return;
  }
  const b = props.standardBlocks.find((x) => x.identifier === value);
  if (b) {
    draft.prompts.push({
      identifier: uniqueIdentifier(b.identifier, ids),
      name: b.name, role: 'system', content: b.marker ? '' : (b.defaultContent || ''),
      marker: !!b.marker, enabled: true,
    });
  }
}

function moveUp(i) { if (i > 0) [draft.prompts[i - 1], draft.prompts[i]] = [draft.prompts[i], draft.prompts[i - 1]]; }
function moveDown(i) { if (i < draft.prompts.length - 1) [draft.prompts[i + 1], draft.prompts[i]] = [draft.prompts[i], draft.prompts[i + 1]]; }
function removeBlock(i) { draft.prompts.splice(i, 1); }

async function activate() {
  const { ok, data } = await setActivePreset(props.preset.id);
  if (ok) world.activePresetId = data.activePresetId;
}

async function save() {
  const { ok, data } = await updatePreset(props.preset.id, {
    name: draft.name, contextLength: draft.contextLength, maxReplyTokens: draft.maxReplyTokens,
    memoryAsSeparateMessage: draft.memoryAsSeparateMessage, prompts: draft.prompts,
  });
  if (!ok) { status.text = data.error || 'Could not save.'; return; }
  const i = world.presetsList.findIndex((p) => p.id === props.preset.id);
  world.presetsList[i] = data.preset;
  status.text = 'Saved.';
}

async function duplicate() {
  const { ok, data } = await createPreset({
    name: draft.name + ' (copy)', contextLength: draft.contextLength, maxReplyTokens: draft.maxReplyTokens, prompts: draft.prompts,
  });
  if (ok) world.presetsList.push(data.preset);
}

async function exportJson() {
  const { ok, data } = await exportPreset({ name: draft.name, contextLength: draft.contextLength, maxReplyTokens: draft.maxReplyTokens, prompts: draft.prompts });
  if (!ok) { alert(data.error || 'Could not export this preset.'); return; }
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `${draft.name || 'preset'}.json`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

async function remove() {
  if (!confirm(`Delete preset "${draft.name}"?`)) return;
  const { ok } = await deletePreset(props.preset.id);
  if (ok) {
    world.presetsList = world.presetsList.filter((p) => p.id !== props.preset.id);
    if (world.activePresetId === props.preset.id) world.activePresetId = null;
  }
}
</script>

<template>
  <div class="preset-card" :class="{ active: isActive }">
    <div class="preset-head">
      <input type="text" class="preset-name-input" v-model="draft.name">
      <span class="active-badge" v-if="isActive">Active</span>
      <div class="preset-actions">
        <button class="btn secondary small" v-if="!isActive" @click="activate">Set active</button>
        <select v-model="addBlockValue.value" @change="addBlock">
          <option value="" selected disabled>+ Add block…</option>
          <option v-for="b in availableStandardBlocks" :key="b.identifier" :value="b.identifier" :title="b.description || ''">{{ b.name }}</option>
          <option value="__custom__">Custom text block</option>
        </select>
        <button class="btn secondary small" @click="exportJson">Export</button>
        <button class="btn secondary small" @click="duplicate">Duplicate</button>
        <button class="btn secondary small" @click="remove">Delete</button>
      </div>
    </div>
    <div class="context-settings-row">
      <div class="field-row">
        <label>Context length (tokens)</label>
        <input type="number" min="1" v-model.number="draft.contextLength">
      </div>
      <div class="field-row">
        <label>Max reply tokens</label>
        <input type="number" min="1" v-model.number="draft.maxReplyTokens">
      </div>
      <div class="marker-note context-settings-hint">Chat history is trimmed to fit whatever's left of the context length after the system prompt and reply budget are reserved.</div>
    </div>
    <div class="checkbox-field">
      <input type="checkbox" :id="`memSeparate-${preset.id}`" v-model="draft.memoryAsSeparateMessage">
      <label :for="`memSeparate-${preset.id}`">Send Character Memory as its own separate system message, instead of merged with neighboring blocks</label>
    </div>
    <div class="empty-note" v-if="!draft.prompts.length">No prompt blocks yet — add one.</div>
    <PromptBlockEditor
      v-for="(block, i) in draft.prompts" :key="block.identifier"
      :block="block" :index="i" :total="draft.prompts.length"
      :marker-label="markerLabels[block.identifier]"
      @move-up="moveUp(i)" @move-down="moveDown(i)" @remove="removeBlock(i)"
    />
    <div class="preset-footer">
      <span class="form-status">{{ status.text }}</span>
      <button class="btn small" @click="save">Save changes</button>
    </div>
  </div>
</template>
