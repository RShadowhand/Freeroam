<script setup>
import { useSectionNav } from '../composables/useSectionNav';
import VariablesGuide from '../components/guides/VariablesGuide.vue';

// Reference/explainer content, as opposed to the rest of Settings which is
// all configurable state — kept in its own place so "how does X work"
// doesn't get mistaken for a setting you can change (Variables used to
// live directly under Settings, which read exactly that way: a page full
// of what look like configurable fields, none of which do anything when
// clicked). Same sidebar-shell pattern as System — built to grow as more
// guide topics get added, not just hold this one.
const sections = [
  { id: 'variables', label: 'Variables' },
];
const { activeId, scrollToSection } = useSectionNav(sections);
</script>

<template>
  <section id="view-guides" class="view">
    <div class="page-shell">
      <nav class="page-shell-nav">
        <a
          v-for="s in sections" :key="s.id" href="#" :class="{ active: s.id === activeId }"
          @click.prevent="scrollToSection(s.id)"
        >{{ s.label }}</a>
      </nav>
      <div class="page-shell-content">
        <div id="variables" class="anchor-section"><VariablesGuide /></div>
      </div>
    </div>
  </section>
</template>
