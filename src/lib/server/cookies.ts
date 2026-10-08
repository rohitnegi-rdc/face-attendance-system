import { base } from '$app/paths';

// Cookies are scoped to the app's base path (BASE_PATH, see vite.config.ts) so other apps on the
// same domain, e.g. ops.rdcc.ai/opsmitra, never receive or overwrite them. "/" when served at root.
// Kept out of auth.ts because scripts/seed.ts imports that outside SvelteKit.
export const COOKIE_PATH = base || '/';
