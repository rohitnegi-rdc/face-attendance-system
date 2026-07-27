// See https://svelte.dev/docs/kit/types#app.d.ts
// for information about these interfaces
import type { AuthToken } from '$lib/server/auth';

declare global {
	namespace App {
		// interface Error {}
		interface Locals {
			user: AuthToken | null;
		}
		// interface PageData {}
		// interface PageState {}
		// interface Platform {}
	}
}

export {};
