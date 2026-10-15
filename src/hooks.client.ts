import type { HandleClientError } from '@sveltejs/kit';
import { CONTACT_ADMIN, showErrorToast } from '$lib/toast.svelte';

// An exception while loading or navigating in the browser.
export const handleError: HandleClientError = ({ error, status }) => {
	if (status === 404) return { message: 'Page not found.' };
	console.error(error);
	showErrorToast();
	return { message: CONTACT_ADMIN };
};
