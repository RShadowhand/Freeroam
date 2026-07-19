import { ref } from 'vue';

// Overflow modal for a message with more than one suggestion — mirrors
// useNpcModal's module-level singleton pattern (one modal instance, opened
// from wherever a message's suggestion row decides it has too many chips
// to show inline).
const isOpen = ref(false);
const message = ref(null);

export function useSuggestionOverflow() {
  function open(msg) {
    message.value = msg;
    isOpen.value = true;
  }
  function close() {
    isOpen.value = false;
    message.value = null;
  }
  return { isOpen, message, open, close };
}
