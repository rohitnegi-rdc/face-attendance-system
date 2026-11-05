<script lang="ts">
	import AuthPanel from '$lib/components/AuthPanel.svelte';

	let { data } = $props();

	// Operators read Hindi first (the pump screen starts in Hindi), so both are always shown.
	const MESSAGES = {
		not_working: {
			hi: ['यह लिंक अब काम नहीं करता', 'नए लिंक के लिए अपने प्लांट मैनेजर से बात करें।'],
			en: ['This link no longer works', 'Ask your plant manager for a new link.']
		},
		disabled: {
			hi: ['यह पंप बंद है', 'अपने प्लांट मैनेजर से बात करें।'],
			en: ['This pump is disabled', 'Contact your plant manager.']
		},
		signed_in: {
			hi: ['आप दूसरे खाते से साइन इन हैं', 'पहले साइन आउट करें, फिर लिंक दोबारा खोलें।'],
			en: [
				'You are signed in with another account',
				'This link is for the pump phone. To try it here, sign out first or use a private window.'
			]
		}
	};
	const message = $derived(MESSAGES[data.problem]);
</script>

<svelte:head><title>Pump link | Face Attendance</title></svelte:head>

<AuthPanel labelledby="link-title">
	<div class="auth-heading" data-testid="link-problem">
		<h1 id="link-title" lang="hi">{message.hi[0]}</h1>
		<p lang="hi">{message.hi[1]}</p>
		<h2 lang="en">{message.en[0]}</h2>
		<p lang="en">{message.en[1]}</p>
	</div>
</AuthPanel>
