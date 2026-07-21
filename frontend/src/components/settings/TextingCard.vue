<script setup>
import { ref, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();
const text = ref(settings.textingPromptTemplate);
const status = ref('');

// Keeps the textarea in sync after save()/reset() update the store (the
// backend is the source of truth for the "effective" text, e.g. falling
// back to the built-in default after a reset) — same pattern as
// DraftPersonaPromptCard.vue.
watch(() => settings.textingPromptTemplate, (v) => { text.value = v; });

async function save() {
  await settings.setTextingPromptTemplate(text.value.trim());
  status.value = 'Saved.';
}
async function reset() {
  await settings.resetTextingPromptTemplate();
  status.value = 'Reset to default.';
}
</script>

<template>
  <div class="settings-card">
    <h2>Texting</h2>
    <p class="hint">
      Style instructions for how characters reply when texting (see the Phone tab) — separate from the main roleplay
      prompt, since a text message should read like a text message rather than a scene. Character description,
      personality, relevant memories, and relationships are still fed in automatically, same as a normal reply.
    </p>
    <textarea v-model="text" rows="5"></textarea>
    <div class="form-actions">
      <button class="btn small" @click="save">Save</button>
      <button class="btn secondary small" v-if="settings.textingPromptTemplateIsCustom" @click="reset">Reset to default</button>
      <span class="form-status">{{ status }}</span>
    </div>

    <div class="checkbox-field" style="margin-top:16px;">
      <input
        type="checkbox" id="textingTypingIndicator" v-model="settings.textingTypingIndicator"
        @change="settings.setTextingTypingIndicator(settings.textingTypingIndicator)"
      >
      <label for="textingTypingIndicator">Show a "typing…" indicator while a reply is coming in</label>
    </div>
    <p class="hint" v-if="settings.textingTypingIndicator && !settings.streaming">
      This needs <router-link to="/settings/connection">Streaming</router-link> turned on to do anything — it'll stay
      quietly off until then.
    </p>
  </div>
</template>
