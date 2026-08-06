<script setup>
import { ref } from 'vue';
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();

const customApiBase = ref(settings.suggestedActionsLlmCustomApiBase);
const customModel = ref(settings.suggestedActionsLlmCustomModel);
const customApiKey = ref('');

function saveCustom() {
  settings.setSuggestedActionsLlmCustom({ apiBase: customApiBase.value, model: customModel.value, apiKey: customApiKey.value });
  customApiKey.value = '';
}
</script>

<template>
  <div class="settings-card">
    <h2>Suggested actions</h2>
    <p class="hint">
      How replies are scanned for quick-action suggestions ("send to", "add place", "add character", "text someone") —
      <strong>Regex only</strong> is instant but only fires on specific phrasing. <strong>ML only</strong> uses a local NER +
      intent-classification model, more robust to varied phrasing but slower per message. <strong>Regex + ML</strong> runs both and
      merges the results. <strong>LLM</strong> asks an actual language model to classify intents (including texting/scheduling
      actions the other modes can't detect) — more accurate, but costs a call per message.
    </p>
    <div class="endpoint-row">
      <label style="flex-shrink:0;">Detection mode</label>
      <select v-model="settings.suggestedActionsMode" @change="settings.setSuggestedActionsMode(settings.suggestedActionsMode)">
        <option value="regex">Regex only</option>
        <option value="hybrid">Regex + ML</option>
        <option value="ml">ML only</option>
        <option value="llm">LLM</option>
      </select>
    </div>

    <div v-if="settings.suggestedActionsMode === 'llm'" class="llm-source-block">
      <p class="hint">Which model answers the LLM sidecar call:</p>
      <div class="endpoint-row">
        <label style="flex-shrink:0;">Model source</label>
        <select
          v-model="settings.suggestedActionsLlmSource"
          @change="settings.setSuggestedActionsLlmSource(settings.suggestedActionsLlmSource)"
        >
          <option value="builtin">Built-in (Gemma4-E2B-QAT, runs locally)</option>
          <option value="same">Same backend/model as replies</option>
          <option value="custom">Custom endpoint</option>
        </select>
      </div>
      <p class="hint" v-if="settings.suggestedActionsLlmSource === 'builtin'">
        Runs fully offline via a small local model — no extra API cost, but a one-time ~3.3GB download the first time it's used,
        and this call runs on CPU alongside everything else.
      </p>
      <p class="hint" v-else-if="settings.suggestedActionsLlmSource === 'same'">
        Reuses whichever endpoint/model/key is already configured for character replies. Simple, but adds one more paid call per
        message on top of the reply itself.
      </p>
      <template v-else-if="settings.suggestedActionsLlmSource === 'custom'">
        <p class="hint">Point this at a separate, usually cheaper/faster model — pinning something small here keeps the extra call's cost down.</p>
        <div class="endpoint-row">
          <label style="flex-shrink:0;">Endpoint</label>
          <input v-model="customApiBase" type="text" placeholder="https://openrouter.ai/api/v1" @blur="saveCustom" />
        </div>
        <div class="endpoint-row">
          <label style="flex-shrink:0;">Model</label>
          <input v-model="customModel" type="text" placeholder="e.g. openai/gpt-4o-mini" @blur="saveCustom" />
        </div>
        <div class="endpoint-row">
          <label style="flex-shrink:0;">API key</label>
          <input
            v-model="customApiKey" type="password"
            :placeholder="settings.hasCustomLlmKey ? 'Set — leave blank to keep, or type to replace' : 'Blank = reuse the main API key'"
            @blur="saveCustom"
          />
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.llm-source-block { margin-top: 12px; padding-top: 12px; border-top: 1px solid var(--border, rgba(128,128,128,0.25)); }
</style>
