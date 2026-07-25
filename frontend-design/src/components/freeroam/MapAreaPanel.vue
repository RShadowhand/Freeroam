<script setup>
import { ref, watch } from 'vue';
import MapPanel from './MapPanel.vue';
import CurrentAreaPanel from './CurrentAreaPanel.vue';

// Left column of the Freeroam layout — Map (where everything is) and
// Current area (who/what's here — the old topbar Details) share one tab
// row instead of each needing its own space. v-show, not v-if: switching
// tabs shouldn't re-fetch or lose scroll position in either one.
const props = defineProps({ openTab: { type: String, default: null } });
const activeTab = ref('map');

// openTab lets FreeroamView's two mobile buttons (Map / Details) land
// directly on the right tab in one click instead of always opening to
// Map and making the user tap again — see the .mobile-panel-toggles
// comment in FreeroamView.vue. Just seeds activeTab on each request; the
// user can still click the tabs themselves afterward like normal.
watch(() => props.openTab, (tab) => { if (tab) activeTab.value = tab; });
</script>

<template>
  <div class="map-col">
    <div class="panel-tabs">
      <button class="panel-tab" type="button" :class="{ active: activeTab === 'map' }" @click="activeTab = 'map'">🗺 Map</button>
      <button class="panel-tab" type="button" :class="{ active: activeTab === 'area' }" @click="activeTab = 'area'">Current area</button>
    </div>
    <div class="map-tab-body">
      <MapPanel v-show="activeTab === 'map'" />
      <CurrentAreaPanel v-show="activeTab === 'area'" />
    </div>
  </div>
</template>
