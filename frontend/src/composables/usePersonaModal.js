import { ref } from 'vue';

// Persona add/edit modal's open state — module-level singleton, mirrors
// useCharacterModal.js exactly (one modal instance mounted once in
// CastView, mode 'create' vs 'edit' picked from whether an id was passed).
const isOpen = ref(false);
const mode = ref('create'); // 'create' | 'edit'
const editingId = ref(null);

export function usePersonaModal() {
  function open(personaId) {
    mode.value = personaId ? 'edit' : 'create';
    editingId.value = personaId || null;
    isOpen.value = true;
  }
  function close() {
    isOpen.value = false;
    editingId.value = null;
  }
  return { isOpen, mode, editingId, open, close };
}
