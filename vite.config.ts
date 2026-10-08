import adapter from '@sveltejs/adapter-node';
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

// URL prefix when the app is served under a sub-path, e.g. BASE_PATH=/pump-attendance for
// https://ops.rdcc.ai/pump-attendance. Empty (default) serves from the domain root. It is baked
// in at build time, so changing it needs a rebuild. Code must build URLs with resolve()/asset()
// from $app/paths, never a hardcoded leading "/".
const basePath = (process.env.BASE_PATH ?? '').trim();
if (basePath && (!basePath.startsWith('/') || basePath.endsWith('/'))) {
	throw new Error(`BASE_PATH must start with "/" and must not end with "/" (got "${basePath}")`);
}

export default defineConfig({
	plugins: [
		sveltekit({
			compilerOptions: {
				// Force runes mode for the project, except for libraries. Can be removed in svelte 6.
				runes: ({ filename }) =>
					filename.split(/[/\\]/).includes('node_modules') ? undefined : true
			},

			// adapter-auto only supports some environments, see https://svelte.dev/docs/kit/adapter-auto for a list.
			// If your environment is not supported, or you settled on a specific environment, switch out the adapter.
			// See https://svelte.dev/docs/kit/adapters for more information about adapters.
			adapter: adapter(),
			paths: { base: basePath as '' | `/${string}` }
		})
	]
});
