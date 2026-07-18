<script setup>
import { useUiStore } from '../../stores/ui';

const ui = useUiStore();
</script>

<template>
  <div class="error-banner" v-if="ui.errorMessage">
    <span>⚠ {{ ui.errorMessage }}</span>
    <button type="button" aria-label="Dismiss" @click="ui.dismissError()">✕</button>
  </div>
</template>
