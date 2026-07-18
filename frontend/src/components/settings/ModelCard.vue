<script setup>
import { computed, ref } from 'vue';
import { useSettingsStore } from '../../stores/settings';
import { formatPrice } from '../../utils/format';

const settings = useSettingsStore();
const search = ref('');

const filtered = computed(() => {
  const f = search.value.trim().toLowerCase();
  const list = f
    ? settings.allModels.filter((m) => m.id.toLowerCase().includes(f) || m.name.toLowerCase().includes(f))
    : settings.allModels;
  return list.slice(0, 200);
});

function priceLabel(m) {
  const prompt = formatPrice(m.pricing?.prompt);
  const completion = formatPrice(m.pricing?.completion);
  return prompt ? `${prompt} in / ${completion} out` : '';
}

async function pick(modelId) {
  await settings.setModel(modelId);
}

const availableToAdd = computed(() => settings.availableProviders.filter((p) => !settings.selectedProviders.includes(p.name)));

function providerPriceLabel(name) {
  const p = settings.availableProviders.find((x) => x.name === name);
  return p ? formatPrice(p.pricing?.completion) : '';
}

async function onAddProvider(e) {
  const name = e.target.value;
  e.target.value = '';
  if (name) await settings.addProvider(name);
}
</script>

<template>
  <div class="settings-card">
    <h2>Model</h2>
    <p class="hint">Pick any model id the endpoint serves. Pricing (per 1M tokens) shows when the endpoint reports it.</p>
    <div class="current-model">Current: {{ settings.model || 'loading current model…' }}</div>
    <input type="text" v-model="search" placeholder="Filter models (e.g. claude, gpt-4o, gemini)...">
    <div class="model-list">
      <div class="model-item" v-if="!settings.allModels.length">loading models…</div>
      <div class="model-item" v-else-if="!filtered.length">No models match "{{ search }}"</div>
      <div
        v-else v-for="m in filtered" :key="m.id" class="model-item"
        :class="{ selected: m.id === settings.model }" @click="pick(m.id)"
      >
        <span>{{ m.name }}</span>
        <span class="ctx">
          <template v-if="m.context_length">{{ m.context_length.toLocaleString() }} ctx</template>
          <template v-if="priceLabel(m)"> · {{ priceLabel(m) }}</template>
        </span>
      </div>
    </div>
    <div id="providerField" v-if="settings.isOpenRouter && settings.availableProviders.length">
      <label>Providers (OpenRouter routing — optional, tried in this order)</label>
      <div class="present" style="margin:0 0 8px;">
        <span class="chip" v-for="name in settings.selectedProviders" :key="name">
          {{ name }}{{ providerPriceLabel(name) ? ' — ' + providerPriceLabel(name) + ' out' : '' }}
          <button class="chip-remove" title="Remove" @click="settings.removeProvider(name)">✕</button>
        </span>
        <span class="chip empty" v-if="!settings.selectedProviders.length">let OpenRouter choose</span>
      </div>
      <select class="provider-select" @change="onAddProvider">
        <option value="" selected>+ Add a provider…</option>
        <option v-for="p in availableToAdd" :key="p.name" :value="p.name">
          {{ p.name }}{{ formatPrice(p.pricing?.completion) ? ' — ' + formatPrice(p.pricing.completion) + ' out' : '' }}
        </option>
      </select>
    </div>
  </div>
</template>
