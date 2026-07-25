<script setup>
import { ref, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();
const text = ref(settings.draftPersonaPrompt);
const status = ref('');

// Vue's mustache tokenizer can't have literal "{{"/"}}" text inside an
// interpolation expression itself (it does simple brace-matching, not full
// JS parsing, so it reads the first "}}" it finds as the close) — kept as
// plain variables and interpolated as a whole instead of writing the
// braces directly in the template (see VariablesView.vue for the same fix).
const variablesExample = '{{variables}}';
const charExample = '{{char}}';
const worldExample = '{{world}}';

// Keeps the textarea in sync after save()/reset() update the store (the
// backend is the source of truth for what the "effective" text actually is,
// e.g. falling back to the built-in default after a reset).
watch(() => settings.draftPersonaPrompt, (v) => { text.value = v; });

async function save() {
  await settings.setDraftPersonaPrompt(text.value.trim());
  status.value = 'Saved.';
}
async function reset() {
  await settings.resetDraftPersonaPrompt();
  status.value = 'Reset to default.';
}
</script>

<template>
  <div class="settings-card">
    <h2>Draft persona prompt</h2>
    <p class="hint">
      The system instruction sent to the model when you click "✨ Draft description from this scene" in the
      Save-as-character modal. Supports the same <code>{{ variablesExample }}</code> as everywhere else — see the
      <router-link to="/settings/guides">Variables</router-link> guide. <code>{{ charExample }}</code> is the
      character being drafted; <code>{{ worldExample }}</code> is your World Setting text.
    </p>
    <textarea v-model="text" rows="5"></textarea>
    <div class="form-actions">
      <button class="btn small" @click="save">Save</button>
      <button class="btn secondary small" v-if="settings.draftPersonaPromptIsCustom" @click="reset">Reset to default</button>
      <span class="form-status">{{ status }}</span>
    </div>
  </div>
</template>
