import { ref } from 'vue';

// Character add/edit modal's open state — module-level singleton, one
// modal instance mounted once in CastView. mode 'create' hides
// placement/relationships/memories (they only apply once the character
// actually exists); 'edit' shows all of it.
const isOpen = ref(false);
const mode = ref('create'); // 'create' | 'edit'
const editingId = ref(null);

export function useCharacterModal() {
  function open(characterId) {
    mode.value = characterId ? 'edit' : 'create';
    editingId.value = characterId || null;
    isOpen.value = true;
  }
  function close() {
    isOpen.value = false;
    editingId.value = null;
  }
  return { isOpen, mode, editingId, open, close };
}
