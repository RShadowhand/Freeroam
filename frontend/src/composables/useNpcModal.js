import { ref } from 'vue';

// Save-as-character modal — promotes an NPC line (or any typed name) to a
// real character card. Module-level (singleton) state since it's opened
// from several places (a spoken NPC's "+ Save as character" button, a
// suggestion chip, the chat header's "+ New character" button) but there's
// only ever one modal instance, mounted once in FreeroamView.
const isOpen = ref(false);
const context = ref({ name: '', placeId: null });

export function useNpcModal() {
  function open({ name, placeId }) {
    context.value = { name: name || '', placeId };
    isOpen.value = true;
  }
  function close() {
    isOpen.value = false;
  }
  return { isOpen, context, open, close };
}
