import { ref } from 'vue';
import { getSettings, saveSettings } from '../api/settings';

// First-run walkthrough's open state — module-level singleton, same pattern
// as useCharacterModal.js/useNpcModal.js, one modal instance mounted once in
// App.vue (root-level, so it's visible regardless of route). Persisted in
// config.json (global, shared across worlds/browsers — see backend's
// publicConfig()) rather than localStorage: this is a self-hosted install,
// not a multi-tenant site, and a browser-side flag doesn't survive a private/
// incognito window, which reopened the tour on every private visit. init()
// resolves the real state; isOpen starts false so the modal never flashes
// open before that resolves. Finishing or skipping either one persists the
// flag so it never shows again automatically, but open() lets it be replayed
// on demand (see ManualGuide.vue).
const isOpen = ref(false);
const currentStep = ref(0);

export function useOnboardingModal() {
  async function init() {
    const { data } = await getSettings();
    isOpen.value = !data.onboarded;
  }
  function open() {
    currentStep.value = 0;
    isOpen.value = true;
  }
  async function markDone() {
    isOpen.value = false;
    await saveSettings({ onboarded: true });
  }
  return { isOpen, currentStep, init, open, markDone };
}
