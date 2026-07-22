<script setup>
import { computed } from 'vue';
import { useWorldStore } from '../../stores/world';
import { useChatStore } from '../../stores/chat';
import Avatar from '../shared/Avatar.vue';
import { joinNames } from '../../utils/format';

const props = defineProps({ place: { type: Object, required: true } });
const world = useWorldStore();
const chat = useChatStore();

const isCurrent = computed(() => props.place.id === chat.currentPlace);
const chars = computed(() => world.charsInPlace(props.place.id));
const ownerNames = computed(() => (props.place.ownerIds || []).map((id) => world.charName(id)).filter(Boolean));
</script>

<template>
  <button class="place" :class="{ current: isCurrent }" @click="chat.enterPlace(place.id)">
    <span class="info">
      <span class="pname">
        <span class="label-text">{{ place.name }}</span>
        <span v-if="place.type === 'private'" class="type-badge private">
          private<template v-if="ownerNames.length"> · {{ joinNames(ownerNames) }}</template>
        </span>
        <span v-else class="type-badge">communal</span>
      </span>
    </span>
    <span class="dots"><Avatar v-for="cid in chars" :key="cid" :char-id="cid" :size="8" /></span>
  </button>
</template>
