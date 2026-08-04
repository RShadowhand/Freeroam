<script setup>
import { onMounted, onUnmounted, ref, watch } from 'vue';
import cytoscape from 'cytoscape';
import fcose from 'cytoscape-fcose';
import { useWorldStore } from '../../stores/world';
import { useThemeStore } from '../../stores/theme';
import { useUiStore } from '../../stores/ui';
import { useCharacterModal } from '../../composables/useCharacterModal';
import { usePersonaModal } from '../../composables/usePersonaModal';
import { buildInitialsAvatarDataUrl } from '../../utils/graphAvatar';

cytoscape.use(fcose);

const world = useWorldStore();
const theme = useThemeStore();
const ui = useUiStore();
const characterModal = useCharacterModal();
const personaModal = usePersonaModal();
const graphEl = ref(null);
const layoutMode = ref('fcose');
let cy = null;

// Nodes = every character, always (not just ones with a relationship) —
// isolated cast members are meaningful to see, and cast size (not edge
// count) is what actually drives "hundreds of nodes." The synthetic "You"
// node is the one exception, added only if a relationship actually targets
// it — an unconnected placeholder otherwise is just noise.
function buildElements() {
  const nodes = world.charactersList.map((c) => ({
    data: {
      id: c.id,
      name: c.name,
      avatarUrl: c.avatarUrl || buildInitialsAvatarDataUrl(c.name, c.color || theme.resolvedVar('--dim')),
    },
  }));

  if (world.relationships.some((r) => r.targetId === 'user')) {
    const persona = world.activePersona;
    const name = (persona ? persona.name : 'The visitor') + ' (you)';
    const color = (persona ? persona.color : null) || theme.resolvedVar('--accent');
    nodes.push({
      data: { id: 'user', name, avatarUrl: persona?.avatarUrl || buildInitialsAvatarDataUrl(name, color) },
    });
  }

  // One edge per relationship row (multiple labels joined into one string,
  // e.g. "ex-wife, friend") rather than parallel edges — matches how
  // RelationshipsSection.vue already displays a row's labels together, and
  // keeps edge count bounded to relationship-row count. A reverse-direction
  // row is just a second edge with a different id; curve-style:bezier below
  // auto-offsets same-pair edges so both remain visible.
  const edges = world.relationships
    .filter((r) => r.labels.length)
    .map((r) => ({
      data: { id: `${r.characterId}->${r.targetId}`, source: r.characterId, target: r.targetId, label: r.labels.join(', ') },
    }));

  return { nodes, edges };
}

// Cytoscape's style API needs literal color values, not CSS custom property
// references — theme.resolvedVar() (stores/theme.js) is the existing helper
// for exactly this, already used to seed a color picker with the current
// theme's resolved accent.
//
// Edge labels are opt-in via .label-visible (revealed on hover — see the
// mouseover/mouseout handlers below) rather than always-on: with a dense
// many-to-many web, permanently drawing every relationship's label is what
// actually makes the graph unreadable, far more than the edges/lines
// themselves. .dimmed is the other half of the same hover interaction —
// everything outside the hovered node's immediate neighborhood fades out.
function buildStyle() {
  const panel = theme.resolvedVar('--panel');
  const border = theme.resolvedVar('--border');
  const accent = theme.resolvedVar('--accent');
  const dim = theme.resolvedVar('--dim');
  const parchment = theme.resolvedVar('--parchment');
  return [
    { selector: 'node', style: {
      shape: 'ellipse', width: 44, height: 44,
      'background-image': 'data(avatarUrl)', 'background-fit': 'cover', 'background-color': panel,
      'border-width': 2, 'border-color': border,
      label: 'data(name)', color: parchment,
      'font-family': "'Cormorant Garamond', serif", 'font-size': 12,
      'text-valign': 'bottom', 'text-halign': 'center', 'text-margin-y': 6,
      'text-max-width': 90, 'text-wrap': 'ellipsis',
    } },
    { selector: 'node#user, node:selected', style: { 'border-color': accent, 'border-width': 3 } },
    { selector: 'edge', style: {
      'curve-style': 'bezier', width: 1.5, 'line-color': dim, 'target-arrow-color': dim,
      'target-arrow-shape': 'triangle', 'arrow-scale': 0.8,
    } },
    { selector: 'edge.label-visible', style: {
      label: 'data(label)', 'font-size': 9, color: dim, 'text-rotation': 'autorotate',
      'text-background-color': panel, 'text-background-opacity': 0.85, 'text-background-padding': 2,
    } },
    { selector: '.dimmed', style: { opacity: 0.15 } },
  ];
}

// Core Cytoscape's built-in 'cose' layout is slow to converge at hundreds
// of nodes — cytoscape-fcose is its modern, faster/better-quality
// replacement (see the graph-library comparison this feature came out of).
// animate:false skips animated convergence and jumps straight to the
// settled layout — the per-tick render cost during an animated settle is
// exactly what fcose-over-cose was chosen to avoid at this scale.
// circle/grid/concentric are all built into Cytoscape core (no extra
// dependency) and are direct geometric placements rather than iterative
// physics, so switching to them is never a performance concern — only
// fcose itself needed the extension. concentric ranks by node.degree()
// (connection count), so heavily-connected "hub" characters land toward
// the center — the most direct answer to "who's actually central here."
const LAYOUT_OPTIONS = {
  fcose: { name: 'fcose', quality: 'default', randomize: true, nodeRepulsion: 4500, idealEdgeLength: 80 },
  circle: { name: 'circle' },
  grid: { name: 'grid' },
  concentric: { name: 'concentric', concentric: (node) => node.degree(), levelWidth: () => 1 },
};
function runLayout() {
  cy.layout({ ...LAYOUT_OPTIONS[layoutMode.value], animate: false }).run();
}

onMounted(() => {
  cy = cytoscape({ container: graphEl.value, elements: buildElements(), style: buildStyle() });
  runLayout();
  cy.on('tap', 'node', (evt) => {
    const id = evt.target.id();
    if (id === 'user') {
      // The "You" node can appear from a relationship targeting the user
      // even with no persona currently active — clicking it then has
      // nothing to open, so say so rather than doing nothing visibly.
      if (world.activePersonaId) personaModal.open(world.activePersonaId);
      else ui.showError('No active persona to show — set one active under Cast to open it here.');
      return;
    }
    characterModal.open(id);
  });
  // Hover, not click, drives ego-focus + label reveal — click already opens
  // the character/persona modal above, so overloading it with a second
  // "highlight the neighborhood" meaning would conflict. Moving the mouse
  // away always fully resets; no separate "click background to clear" state
  // to manage.
  cy.on('mouseover', 'node', (evt) => {
    const node = evt.target;
    const neighborhood = node.closedNeighborhood();
    cy.elements().not(neighborhood).addClass('dimmed');
    neighborhood.edges().addClass('label-visible');
    graphEl.value.style.cursor = 'pointer';
  });
  cy.on('mouseout', 'node', () => {
    cy.elements().removeClass('dimmed label-visible');
    graphEl.value.style.cursor = '';
  });
  cy.on('mouseover', 'edge', (evt) => evt.target.addClass('label-visible'));
  cy.on('mouseout', 'edge', (evt) => evt.target.removeClass('label-visible'));
});

onUnmounted(() => {
  cy?.destroy();
  cy = null;
});

// Recolors the live graph when the theme changes while this tab stays open
// — otherwise the stale resolved colors would only update on next remount.
watch(() => theme.theme.theme, () => {
  cy?.style().fromJson(buildStyle()).update();
});

// Covers two cases: (1) editing a relationship via a character/persona
// modal opened from this same view without navigating away, and (2) a
// direct/fresh load of this route with no prior Cast/Places visit this
// session — Vue mounts children before parents, so this component's own
// onMounted (above) runs and builds its first frame BEFORE the parent
// RelationsGraphView's onMounted has even called world.loadWorldState(),
// meaning charactersList can still be empty at that point. Watching both
// sources (rather than relying on relationships always being reassigned by
// loadWorldState, even to []) catches that rebuild explicitly. Navigating
// away and back to this route needs no extra handling — it's a full
// remount either way (this app has no keep-alive).
watch([() => world.relationships, () => world.charactersList], () => {
  if (!cy) return;
  cy.json({ elements: buildElements() }); // diffs by id, preserves positions of unchanged nodes
  runLayout();
}, { deep: true });
</script>

<template>
  <div class="graph-toolbar">
    <label>Layout</label>
    <select v-model="layoutMode" @change="runLayout">
      <option value="fcose">Force-directed</option>
      <option value="circle">Circular</option>
      <option value="grid">Grid</option>
      <option value="concentric">Concentric (by connections)</option>
    </select>
  </div>
  <div ref="graphEl" class="relations-graph"></div>
</template>
