import { defineStore } from 'pinia';
import { getSettings, saveSettings, clearApiKey, getModels, getModelProviders, rebuildEmbeddings as rebuildEmbeddingsRequest } from '../api/settings';

export const OPENROUTER_API_BASE = 'https://openrouter.ai/api/v1';

export const useSettingsStore = defineStore('settings', {
  state: () => ({
    hasKey: false,
    model: '',
    apiBase: '',
    streaming: false,
    reasoning: 'off',
    memoryMinScore: 0.35,
    suggestedActionsMode: 'regex',
    selectedProviders: [], // cfg.providers — pinned OpenRouter providers, tried in this order
    allModels: [],
    availableProviders: [], // candidate providers for the current model, fetched from OpenRouter
    // A separate, locally-tracked field rather than a getter derived from
    // apiBase: the backend refuses to persist an empty apiBase (it falls
    // back to the OpenRouter default rather than store nothing — a
    // sensible safety net elsewhere, but it means "save an empty apiBase
    // to signal custom mode" bounces straight back to OpenRouter and the
    // picker could never actually leave OpenRouter mode). Picking "Custom"
    // just flips this flag and reveals the field for typing; nothing gets
    // saved until the user actually enters a real URL.
    endpointMode: 'openrouter', // 'openrouter' | 'custom'
    draftPersonaPrompt: '', // the effective text (backend already falls back to its built-in default)
    draftPersonaPromptIsCustom: false,
    embeddingModel: '',
    embeddingsStale: false, // true when stored memory/relationship vectors were built with a different model
    narratorEnabled: true,
    textingPromptTemplate: '', // the effective text (backend already falls back to its built-in default)
    textingPromptTemplateIsCustom: false,
    textingTypingIndicator: false,
    cascadeBaseChance: 0.85,
    cascadeDecayRate: 0.98,
    cascadePerCharacterCap: 1,
  }),
  getters: {
    // Providers are an OpenRouter-only concept — a custom OpenAI-spec
    // endpoint has no equivalent, so the whole picker only makes sense here.
    isOpenRouter: (state) => (state.apiBase || '').includes('openrouter.ai'),
  },
  actions: {
    async load() {
      const { data } = await getSettings();
      this.hasKey = !!data.hasKey;
      this.model = data.model;
      this.apiBase = data.apiBase || '';
      this.endpointMode = this.isOpenRouter ? 'openrouter' : 'custom';
      this.streaming = !!data.streaming;
      this.reasoning = data.reasoning || 'off';
      this.memoryMinScore = Number.isFinite(data.memoryMinScore) ? data.memoryMinScore : 0.35;
      this.suggestedActionsMode = data.suggestedActionsMode || 'regex';
      this.selectedProviders = Array.isArray(data.providers) ? data.providers : [];
      this.draftPersonaPrompt = data.draftPersonaPrompt || '';
      this.draftPersonaPromptIsCustom = !!data.draftPersonaPromptIsCustom;
      this.embeddingModel = data.embeddingModel || '';
      this.embeddingsStale = !!data.embeddingsStale;
      this.narratorEnabled = data.narratorEnabled !== false;
      this.textingPromptTemplate = data.textingPromptTemplate || '';
      this.textingPromptTemplateIsCustom = !!data.textingPromptTemplateIsCustom;
      this.textingTypingIndicator = !!data.textingTypingIndicator;
      this.cascadeBaseChance = Number.isFinite(data.cascadeBaseChance) ? data.cascadeBaseChance : 0.85;
      this.cascadeDecayRate = Number.isFinite(data.cascadeDecayRate) ? data.cascadeDecayRate : 0.98;
      this.cascadePerCharacterCap = Number.isInteger(data.cascadePerCharacterCap) ? data.cascadePerCharacterCap : 1;
      await this.loadAvailableProviders();
    },
    async loadModels() {
      const { ok, data } = await getModels();
      this.allModels = ok ? (data.models || []) : [];
      return ok;
    },
    async loadAvailableProviders() {
      if (!this.model || !this.isOpenRouter) { this.availableProviders = []; return; }
      try {
        const { data } = await getModelProviders(this.model);
        this.availableProviders = data.providers || [];
      } catch {
        this.availableProviders = [];
      }
    },
    async setModel(modelId) {
      const { data } = await saveSettings({ model: modelId });
      this.model = data.model;
      await this.loadAvailableProviders();
    },
    // Switches between OpenRouter and a custom endpoint. OpenRouter
    // immediately saves the canonical URL (a real, valid value — no
    // ambiguity); Custom just reveals the URL field for typing and saves
    // nothing until the user actually enters one. Either way this doesn't
    // touch the pinned provider list — it's simply inert (and hidden) while
    // a custom endpoint is active, not discarded.
    async setEndpointMode(mode) {
      this.endpointMode = mode;
      if (mode === 'openrouter') await this.setApiBase(OPENROUTER_API_BASE);
    },
    async setApiBase(apiBase) {
      const { data } = await saveSettings({ apiBase });
      this.apiBase = data.apiBase || '';
      this.endpointMode = this.isOpenRouter ? 'openrouter' : 'custom';
      await this.loadModels();
      await this.loadAvailableProviders();
    },
    async addProvider(name) {
      if (!name || this.selectedProviders.includes(name)) return;
      this.selectedProviders = [...this.selectedProviders, name];
      await saveSettings({ providers: this.selectedProviders });
    },
    async removeProvider(name) {
      this.selectedProviders = this.selectedProviders.filter((p) => p !== name);
      await saveSettings({ providers: this.selectedProviders });
    },
    async setStreaming(streaming) {
      this.streaming = streaming;
      await saveSettings({ streaming });
    },
    async setReasoning(reasoning) {
      this.reasoning = reasoning;
      await saveSettings({ reasoning });
    },
    async setMemoryMinScore(value) {
      this.memoryMinScore = value;
      await saveSettings({ memoryMinScore: value });
    },
    async setSuggestedActionsMode(mode) {
      this.suggestedActionsMode = mode;
      await saveSettings({ suggestedActionsMode: mode });
    },
    async setDraftPersonaPrompt(text) {
      const { data } = await saveSettings({ draftPersonaPrompt: text });
      this.draftPersonaPrompt = data.draftPersonaPrompt || '';
      this.draftPersonaPromptIsCustom = !!data.draftPersonaPromptIsCustom;
    },
    async resetDraftPersonaPrompt() {
      await this.setDraftPersonaPrompt('');
    },
    async setNarratorEnabled(enabled) {
      this.narratorEnabled = enabled;
      await saveSettings({ narratorEnabled: enabled });
    },
    async setTextingPromptTemplate(text) {
      const { data } = await saveSettings({ textingPromptTemplate: text });
      this.textingPromptTemplate = data.textingPromptTemplate || '';
      this.textingPromptTemplateIsCustom = !!data.textingPromptTemplateIsCustom;
    },
    async resetTextingPromptTemplate() {
      await this.setTextingPromptTemplate('');
    },
    async setTextingTypingIndicator(enabled) {
      this.textingTypingIndicator = enabled;
      await saveSettings({ textingTypingIndicator: enabled });
    },
    async setCascadeSettings({ cascadeBaseChance, cascadeDecayRate, cascadePerCharacterCap }) {
      const { data } = await saveSettings({ cascadeBaseChance, cascadeDecayRate, cascadePerCharacterCap });
      this.cascadeBaseChance = data.cascadeBaseChance;
      this.cascadeDecayRate = data.cascadeDecayRate;
      this.cascadePerCharacterCap = data.cascadePerCharacterCap;
    },
    async rebuildEmbeddings() {
      const { ok, data } = await rebuildEmbeddingsRequest();
      if (ok) this.embeddingsStale = false;
      return { ok, data };
    },
    async saveApiKey(key) {
      const { data } = await saveSettings({ apiKey: key });
      this.hasKey = !!data.hasKey;
    },
    async clearKey() {
      const { data } = await clearApiKey();
      this.hasKey = !!data.hasKey;
    },
  },
});
