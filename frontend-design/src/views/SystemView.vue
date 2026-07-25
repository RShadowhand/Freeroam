<script setup>
import { onMounted } from 'vue';
import { useSettingsStore } from '../stores/settings';
import { useSectionNav } from '../composables/useSectionNav';
import MemoryCard from '../components/settings/MemoryCard.vue';
import EmbeddingsCard from '../components/settings/EmbeddingsCard.vue';
import SuggestedActionsCard from '../components/settings/SuggestedActionsCard.vue';
import NarratorCard from '../components/settings/NarratorCard.vue';
import DraftPersonaPromptCard from '../components/settings/DraftPersonaPromptCard.vue';
import TextingCard from '../components/settings/TextingCard.vue';
import MessageFormattingCard from '../components/settings/MessageFormattingCard.vue';
import ThemeCard from '../components/settings/ThemeCard.vue';

const settings = useSettingsStore();

// Anchor id + sidebar label for each card, in display order — this list
// is the single source of truth for the nav rail below, so adding a new
// settings card is "add one entry here," not "invent a matching nav item
// by hand and hope it stays in sync."
const sections = [
  { id: 'memory', label: 'Memory' },
  { id: 'embeddings', label: 'Embeddings' },
  { id: 'suggested-actions', label: 'Suggested actions' },
  { id: 'narrator', label: 'Narrator' },
  { id: 'draft-persona-prompt', label: 'Draft persona prompt' },
  { id: 'texting', label: 'Texting' },
  { id: 'message-formatting', label: 'Message formatting' },
  { id: 'theme', label: 'Theme' },
];
const { activeId, scrollToSection } = useSectionNav(sections);

onMounted(async () => {
  await settings.load();
});
</script>

<template>
  <section id="view-system" class="view">
    <div class="page-shell">
      <nav class="page-shell-nav">
        <a
          v-for="s in sections" :key="s.id" href="#" :class="{ active: s.id === activeId }"
          @click.prevent="scrollToSection(s.id)"
        >{{ s.label }}</a>
      </nav>
      <div class="page-shell-content">
        <div id="memory" class="anchor-section"><MemoryCard /></div>
        <div id="embeddings" class="anchor-section"><EmbeddingsCard /></div>
        <div id="suggested-actions" class="anchor-section"><SuggestedActionsCard /></div>
        <div id="narrator" class="anchor-section"><NarratorCard /></div>
        <div id="draft-persona-prompt" class="anchor-section"><DraftPersonaPromptCard /></div>
        <div id="texting" class="anchor-section"><TextingCard /></div>
        <div id="message-formatting" class="anchor-section"><MessageFormattingCard /></div>
        <div id="theme" class="anchor-section"><ThemeCard /></div>
      </div>
    </div>
  </section>
</template>
