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

export default defineConfig(({ command }) => {
	// The dev server runs outside Docker, where nothing sets DATABASE_URL and the other server
	// settings. Load .env into process.env for it. Values already set in the shell win, and builds
	// are untouched: the container gets its environment from docker compose.
	if (command === 'serve') {
		try {
			process.loadEnvFile('.env');
		} catch {
			// No .env file: rely on the shell environment.
		}
	}
	return {
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
		],
		server: {
			// The dev server watches the whole project by default. The evaluation datasets and test
			// output hold ~70k files the app never imports, and watching them slows startup badly.
			watch: {
				ignored: [
					'**/datasets/**',
					'**/test-output/**',
					'**/build/**',
					'**/graphify-out/**',
					'**/uploads/**',
					'**/Test/**'
				]
			}
		}
	};
});
