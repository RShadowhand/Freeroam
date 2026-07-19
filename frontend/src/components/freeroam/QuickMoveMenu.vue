<script setup>
import { onMounted, onUnmounted, ref } from 'vue';
import { useQuickMoveMenu } from '../../composables/useQuickMoveMenu';

const { openForMessageId, style, choose, toggleParticipation, isCharActive, setMenuEl, onScroll } = useQuickMoveMenu();
const menuRef = ref(null);

function onDocClick(e) {
  if (openForMessageId.value && !e.target.closest('.quick-move-menu') && !e.target.closest('.quick-move-trigger')) {
    useQuickMoveMenu().close();
  }
}

onMounted(() => {
  setMenuEl(menuRef.value);
  document.addEventListener('click', onDocClick);
  document.getElementById('messages')?.addEventListener('scroll', onScroll);
});
onUnmounted(() => {
  document.removeEventListener('click', onDocClick);
  document.getElementById('messages')?.removeEventListener('scroll', onScroll);
});

const places = () => useQuickMoveMenu().otherPlaces();
</script>

<template>
  <Teleport to="body">
    <div
      class="quick-move-menu" ref="menuRef"
      :style="{ ...style, display: openForMessageId ? 'flex' : 'none' }"
    >
      <template v-if="openForMessageId">
        <div class="quick-move-group-label">Participation</div>
        <button class="quick-move-option" @click="toggleParticipation">
          {{ isCharActive() ? 'Step back from conversation' : 'Bring into conversation' }}
        </button>
        <div class="quick-move-group-label">Send to</div>
        <button
          v-for="p in places()" :key="'send:'+p.id" class="quick-move-option"
          @click="choose('send', p.id)"
        >{{ p.name }}</button>
        <div class="quick-move-group-label">Go with, to</div>
        <button
          v-for="p in places()" :key="'with:'+p.id" class="quick-move-option"
          @click="choose('with', p.id)"
        >{{ p.name }}</button>
      </template>
    </div>
  </Teleport>
</template>
