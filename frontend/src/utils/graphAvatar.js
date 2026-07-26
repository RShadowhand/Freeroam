import { initials } from './format';

// Cytoscape can't render a Vue component inside a node, so a character/
// persona with no avatarUrl gets a canvas-rendered stand-in — same look as
// CardAvatar.vue's fallback circle (color background, dark initials text) —
// so every graph node goes through one background-image style rule
// regardless of whether it has a real avatar photo or not.
export function buildInitialsAvatarDataUrl(name, color) {
  const size = 88; // 2x the ~44px node display size, for retina crispness
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');

  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size / 2, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = '#1A1620'; // matches .avatar-fallback's text color in main.css
  ctx.font = "700 34px 'Cormorant Garamond', serif";
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(initials(name), size / 2, size / 2 + 2);

  return canvas.toDataURL('image/png');
}
