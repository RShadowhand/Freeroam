<script setup>
import { useSettingsStore } from '../../stores/settings';

const settings = useSettingsStore();
</script>

<template>
  <div class="settings-card">
    <h2>Suggested actions</h2>
    <p class="hint">
      How replies are scanned for quick-action suggestions ("send to", "add place", "add character") — all local, no extra LLM call.
      <strong>Regex only</strong> is instant but only fires on specific phrasing. <strong>ML only</strong> uses a local NER +
      intent-classification model, more robust to varied phrasing but slower per message. <strong>Regex + ML</strong> runs both and
      merges the results.
    </p>
    <div class="endpoint-row">
      <label style="flex-shrink:0;">Detection mode</label>
      <select v-model="settings.suggestedActionsMode" @change="settings.setSuggestedActionsMode(settings.suggestedActionsMode)">
        <option value="regex">Regex only</option>
        <option value="hybrid">Regex + ML</option>
        <option value="ml">ML only</option>
      </select>
    </div>
  </div>
</template>
