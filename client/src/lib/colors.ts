/**
 * colors.ts — Deterministic user color assignment and random name generation.
 *
 * WHY deterministic colors (hash-based) instead of random?
 * The same userId always maps to the same color across sessions and across
 * server instances. This prevents a user's cursor from changing color when
 * they reconnect or when a different server instance handles their request.
 */

// Curated palette: vibrant, accessible, and visually distinct even on dark bg.
export const USER_COLORS = [
  '#FF6B6B', // coral red
  '#4ECDC4', // teal
  '#45B7D1', // sky blue
  '#96CEB4', // sage green
  '#FECA57', // golden yellow
  '#DDA0DD', // plum
  '#FF9FF3', // pink
  '#54A0FF', // bright blue
  '#5F27CD', // deep purple
  '#FF9F43', // orange
  '#00D2D3', // cyan
  '#48DBFB', // light cyan
  '#FF6B9D', // hot pink
  '#C8D6E5', // light steel
  '#A29BFE', // lavender
];

/**
 * Given any string userId, return a consistent color from the palette.
 * Uses a simple polynomial hash so the same id always maps to the same color.
 */
export function getColorForUser(userId: string): string {
  let hash = 0;
  for (let i = 0; i < userId.length; i++) {
    hash = (userId.charCodeAt(i) + ((hash << 5) - hash)) | 0;
  }
  return USER_COLORS[Math.abs(hash) % USER_COLORS.length];
}

const ADJECTIVES = [
  'Swift', 'Brave', 'Calm', 'Eager', 'Fierce', 'Gentle',
  'Happy', 'Jolly', 'Kind', 'Lively', 'Merry', 'Noble',
  'Proud', 'Quiet', 'Radiant', 'Sharp', 'Witty', 'Zesty',
];
const ANIMALS = [
  'Fox', 'Bear', 'Wolf', 'Hawk', 'Lion', 'Tiger',
  'Eagle', 'Panda', 'Otter', 'Koala', 'Lynx', 'Raven',
];

/** Generates a memorable random display name like "SwiftOtter". */
export function generateUserName(): string {
  const adj = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const animal = ANIMALS[Math.floor(Math.random() * ANIMALS.length)];
  return `${adj}${animal}`;
}

/** Generates a short random alphanumeric user ID. */
export function generateUserId(): string {
  return Math.random().toString(36).slice(2, 10);
}
