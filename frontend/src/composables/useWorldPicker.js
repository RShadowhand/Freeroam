import { ref } from 'vue';
import { useWorldsStore } from '../stores/worlds';

// World-picker overlay's open state — same module-singleton shape as
// useOnboardingModal.js, one instance mounted in App.vue. Only relevant once
// there's more than one world (save slot) to choose between; a single-world
// install never sees it. Evaluated once per full page load — initFromWorldsList()
// is called right after worlds.init() resolves at boot (main.js), not on
// every in-app navigation back to '/', so picking a world once doesn't
// re-interrupt the rest of the session.
const isOpen = ref(false);

export function useWorldPicker() {
  function initFromWorldsList() {
    isOpen.value = useWorldsStore().list.length > 1;
  }
  function close() {
    isOpen.value = false;
  }
  return { isOpen, initFromWorldsList, close };
}
