import { ref, onMounted, onBeforeUnmount } from 'vue';

// Drives a sidebar-nav + jump-to-section page (Settings > System, Settings
// > Guides): scrollToSection for the links themselves, and activeId to
// highlight whichever one the user is currently reading. `sections` is an
// array of { id } objects, in the same top-to-bottom order they appear on
// the page — id must match a real element id present in the DOM by the
// time this mounts.
//
// Plain `href="#id"` anchors don't work for this app's nav — it uses
// hash-based routing (createWebHashHistory), so the URL fragment IS the
// route path as far as vue-router is concerned. Clicking one would replace
// the current route's hash outright, vue-router would fail to match it as
// a route, and the catch-all would redirect to "/" — which reads exactly
// like an unwanted full-page navigation. Scrolling happens via JS instead,
// entirely independent of the URL (see scrollToSection).
//
// Active-section tracking is driven by scroll position rather than
// IntersectionObserver ratios: cards on these pages vary a lot in height,
// so "which target has the highest intersection ratio" skews toward
// whichever card is short enough to fit entirely on screen rather than the
// one actually at the top. Walking sections in order and keeping the last
// one whose top has crossed a line near the top of the viewport (the
// standard scrollspy approach) is correct regardless of how tall any given
// card is.
export function useSectionNav(sections) {
  const activeId = ref(sections[0]?.id);
  const TRIGGER_LINE = 120; // px from the top of the viewport
  // Near the bottom of the page, several short trailing cards can all land
  // on the *same* max scroll position — the page simply can't scroll any
  // further, regardless of which one was actually clicked. Scroll position
  // alone can't disambiguate that, so a click-driven scroll suppresses the
  // scroll-based recalculation below until it's had time to finish,
  // letting the click's own (unambiguous) intent stick instead of getting
  // silently overwritten mid-animation.
  let suppressUntil = 0;
  let ticking = false;

  function updateActiveSection() {
    if (Date.now() < suppressUntil) return;
    // A section near the bottom of the page may never be able to scroll as
    // far up as TRIGGER_LINE if there isn't enough room below it to keep
    // scrolling — the page simply runs out before its top reaches the
    // line. Scrolled-to-the-bottom is unambiguous regardless: every
    // section, including the last, has necessarily been passed.
    if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 2) {
      activeId.value = sections[sections.length - 1].id;
      return;
    }
    let current = sections[0].id;
    for (const s of sections) {
      const el = document.getElementById(s.id);
      if (el && el.getBoundingClientRect().top <= TRIGGER_LINE) current = s.id;
    }
    activeId.value = current;
  }
  function onScroll() {
    if (ticking) return;
    ticking = true;
    requestAnimationFrame(() => { updateActiveSection(); ticking = false; });
  }
  function scrollToSection(id) {
    document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    activeId.value = id; // instant feedback — see the suppressUntil comment above
    suppressUntil = Date.now() + 700;
  }

  onMounted(() => {
    updateActiveSection();
    window.addEventListener('scroll', onScroll, { passive: true });
  });
  onBeforeUnmount(() => window.removeEventListener('scroll', onScroll));

  return { activeId, scrollToSection };
}
