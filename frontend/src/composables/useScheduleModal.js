import { ref } from 'vue';

const isOpen = ref(false);
const characterId = ref(null);

export function useScheduleModal() {
  function open(charId) {
    characterId.value = charId;
    isOpen.value = true;
  }
  function close() {
    isOpen.value = false;
    characterId.value = null;
  }
  return { isOpen, characterId, open, close };
}
