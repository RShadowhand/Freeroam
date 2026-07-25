import { ref } from 'vue';

// First-run walkthrough's open state — module-level singleton, same pattern
// as useCharacterModal.js/useNpcModal.js, one modal instance mounted once in
// App.vue (root-level, so it's visible regardless of route). isOpen starts
// true for a browser that's never finished or skipped it before; finishing
// or skipping either one persists the flag so it never shows again
// automatically, but open() lets it be replayed on demand (see ManualGuide.vue).
const ONBOARDED_KEY = 'freeroam.onboarded';

const isOpen = ref(!localStorage.getItem(ONBOARDED_KEY));
const currentStep = ref(0);

export function useOnboardingModal() {
  function open() {
    currentStep.value = 0;
    isOpen.value = true;
  }
  function markDone() {
    localStorage.setItem(ONBOARDED_KEY, '1');
    isOpen.value = false;
  }
  return { isOpen, currentStep, open, markDone };
}
