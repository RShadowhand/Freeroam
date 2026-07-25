import { ref } from 'vue';

// Quick-add-place form's open/prefill state — module-level singleton so a
// suggestion chip ("+ Add place 'Old Lighthouse'") can open and prefill the
// form that lives inside MapPanel/AddPlaceForm without prop-drilling
// through ChatPanel and MapPanel's common ancestor.
const isOpen = ref(false);
const prefillName = ref('');

export function useQuickAddPlace() {
  function openWithName(name) {
    isOpen.value = true;
    prefillName.value = name;
  }
  return { isOpen, prefillName, openWithName };
}
