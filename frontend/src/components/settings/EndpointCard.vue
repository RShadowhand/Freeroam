<script setup>
import { ref, watch } from 'vue';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();
const apiKeyInput = ref('');

// Blank the field (locally only — nothing saves until the user types and
// blurs) when switching into custom mode with the OpenRouter URL still
// sitting in it, so it doesn't look like "custom" is already pointed at
// OpenRouter.
watch(() => settings.endpointMode, (mode) => {
  if (mode === 'custom' && settings.isOpenRouter) settings.apiBase = '';
});

async function saveKey() {
  const value = apiKeyInput.value.trim();
  if (!value) return;
  await settings.saveApiKey(value);
  apiKeyInput.value = '';
}
</script>

<template>
  <div class="settings-card">
    <h2>Endpoint</h2>
    <p class="hint">Defaults to OpenRouter, but any OpenAI Chat Completions–compatible endpoint works — point it elsewhere and use that service's key below.</p>
    <div class="endpoint-fields">
      <div class="field-row">
        <label>Endpoint</label>
        <select :value="settings.endpointMode" @change="settings.setEndpointMode($event.target.value)">
          <option value="openrouter">OpenRouter</option>
          <option value="custom">Custom endpoint</option>
        </select>
      </div>
      <div v-if="settings.endpointMode === 'custom'">
        <label>API base URL</label>
        <input type="text" v-model="settings.apiBase" placeholder="https://api.example.com/v1" @change="settings.setApiBase(settings.apiBase.trim())">
      </div>
      <div class="row">
        <input v-model="apiKeyInput" type="password" placeholder="sk-or-v1-...">
        <button class="btn" @click="saveKey">Save</button>
      </div>
      <div class="row">
        <button class="btn secondary" @click="settings.clearKey()">Clear key</button>
      </div>
      <div class="status">
        <span :class="settings.hasKey ? 'status ok' : 'status warn'">{{ settings.hasKey ? '✓ Key saved' : 'No key set yet' }}</span>
      </div>
    </div>
    <div class="endpoint-row">
      <div class="checkbox-field">
        <input type="checkbox" id="streamingToggle" v-model="settings.streaming" @change="settings.setStreaming(settings.streaming)">
        <label for="streamingToggle">Stream replies (some endpoints don't support this — leave off if replies stop arriving)</label>
      </div>
    </div>
    <div class="endpoint-row">
      <label for="reasoningSelect">Reasoning effort</label>
      <select id="reasoningSelect" style="width:auto;" v-model="settings.reasoning" @change="settings.setReasoning(settings.reasoning)">
        <option value="off">Off</option>
        <option value="low">Low</option>
        <option value="medium">Medium</option>
        <option value="high">High</option>
      </select>
    </div>
    <p class="hint" style="margin:6px 0 0;">Reasoning effort only applies on OpenRouter. When a model returns a thinking trace, it shows as a collapsible "Show thinking" note above its reply.</p>
  </div>
</template>
