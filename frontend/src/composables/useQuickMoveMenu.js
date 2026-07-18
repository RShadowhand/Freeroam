import { ref, nextTick } from 'vue';
import { useChatStore } from '../stores/chat';
import { useWorldStore } from '../stores/world';

// Shared, module-level (not per-component) state — mirrors the original's
// single #quickMoveMenu DOM element reused across every message's trigger,
// rather than one popover instance per message. position:fixed, so it can
// escape .messages' own overflow:auto clipping (a menu opened near the
// bottom of the scrolled backlog would otherwise get cut off) and flip to
// open upward near the bottom of the screen.
const openForMessageId = ref(null);
const openForCharId = ref(null);
const style = ref({ top: '0px', left: '0px' });
let menuEl = null;

// Tapping a button near the edge of a scrolling container can itself
// trigger a small browser focus-scroll adjustment (a real mobile-browser
// behavior, confirmed while building the original vanilla version). Without
// this grace window, that incidental scroll immediately re-fires the
// "close on scroll" handler and kills the menu the instant it opens.
let ignoreScrollUntil = 0;

function close() {
  openForMessageId.value = null;
  openForCharId.value = null;
}

async function open(messageId, charId, triggerEl) {
  openForCharId.value = charId;
  openForMessageId.value = messageId;
  ignoreScrollUntil = Date.now() + 250;

  await nextTick(); // let the menu re-render with this message's options before measuring it
  if (!menuEl) return;

  const rect = triggerEl.getBoundingClientRect();
  const menuRect = menuEl.getBoundingClientRect();
  const openUp = window.innerHeight - rect.bottom < menuRect.height + 8 && rect.top > menuRect.height + 8;
  style.value = {
    left: Math.max(4, Math.min(rect.left, window.innerWidth - menuRect.width - 4)) + 'px',
    top: (openUp ? rect.top - menuRect.height - 4 : rect.bottom + 4) + 'px',
  };
}

function onScroll() {
  if (openForMessageId.value && Date.now() >= ignoreScrollUntil) close();
}

export function useQuickMoveMenu() {
  const chat = useChatStore();
  const world = useWorldStore();

  function setMenuEl(el) {
    menuEl = el;
  }

  function toggle(messageId, charId, triggerEl) {
    if (openForMessageId.value === messageId) close();
    else open(messageId, charId, triggerEl);
  }

  function choose(action, placeId) {
    const charId = openForCharId.value;
    close();
    if (action === 'send') chat.moveCharacter(charId, placeId);
    else chat.goWithCharacterTo(charId, placeId);
  }

  return {
    openForMessageId, openForCharId, style,
    open, close, toggle, choose, setMenuEl, onScroll,
    otherPlaces: () => world.places.filter((p) => p.id !== chat.currentPlace),
  };
}
