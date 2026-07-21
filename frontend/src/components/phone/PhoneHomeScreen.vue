<script setup>
// RoamOS's home screen — just three apps for now (Wavelength/TypeCast/
// Party Line), room to grow once Phase 5 (proactive texts, notifications)
// exists. Icons are plain emoji glyphs, matching the rest of the app's
// text-first aesthetic rather than drawing real icon art.
defineEmits(['open']);

const apps = [
  { id: 'wavelength', icon: '📞', name: 'Wavelength' },
  { id: 'typecast', icon: '💬', name: 'TypeCast' },
  { id: 'party-line', icon: '👥', name: 'Party Line' },
];
</script>

<template>
  <div class="phone-home">
    <button class="phone-app-icon" type="button" v-for="app in apps" :key="app.id" @click="$emit('open', app.id)">
      <span class="phone-app-glyph">{{ app.icon }}</span>
      <span class="phone-app-label">{{ app.name }}</span>
    </button>
  </div>
</template>
