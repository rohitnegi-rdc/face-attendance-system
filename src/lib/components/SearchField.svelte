<script lang="ts">
	// The search box of a filter form: results follow each key press, after a short pause so a
	// fast typist does not ask the server for every letter. What is typed stays the input's own, so
	// a result arriving late never overwrites newer letters; only an outside change to the page's
	// value (Clear, a link) replaces it.
	import { untrack } from 'svelte';
	import { applyFilters } from '$lib/liveSearch';

	const PAUSE_MS = 250;

	let {
		value = '',
		placeholder = '',
		label = 'Search',
		testId
	}: { value?: string; placeholder?: string; label?: string; testId?: string } = $props();

	let text = $state(untrack(() => value));
	let sent = untrack(() => value);
	let input = $state<HTMLInputElement>();
	let timer: ReturnType<typeof setTimeout>;

	$effect(() => {
		if (value === sent) return;
		clearTimeout(timer);
		sent = value;
		text = value;
	});

	function send() {
		clearTimeout(timer);
		const wanted = text.trim();
		if (wanted === sent || !input?.form) return;
		sent = wanted;
		void applyFilters(input.form);
	}

	function oninput() {
		clearTimeout(timer);
		timer = setTimeout(send, PAUSE_MS);
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Enter') return;
		event.preventDefault();
		send();
	}
</script>

<label class="field"
	><span>{label}</span><input
		bind:this={input}
		bind:value={text}
		name="q"
		type="search"
		{placeholder}
		autocomplete="off"
		data-testid={testId}
		{oninput}
		{onkeydown}
	/></label
>
