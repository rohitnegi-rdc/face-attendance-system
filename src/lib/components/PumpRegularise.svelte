<script lang="ts">
	// Regularisation on the pump screen (/api/pump/regularisation). A calendar shows every day; a
	// light red or dark red day can be applied for. A missed day also shows as a card above the shift
	// button, which opens the calendar on that day; it never blocks attendance. Apply opens three
	// screens: 1 why (picture buttons, or hold to speak), 2 who (faces, tap to untick), 3 check and
	// send. "Later" hides the card until the screen is opened again. Hindi large and English small,
	// the other way round when the pump reads English.
	import { base } from '$app/paths';
	import { onMount } from 'svelte';
	import RegularisationCalendar from '$lib/components/RegularisationCalendar.svelte';
	import { pumpLang } from '$lib/pumpLang.svelte';
	import { HALF_TEXT, REASON_TEXT, dayText } from '$lib/regularisationLabels';
	import type { CalendarDay, CalendarMonth } from '$lib/server/regularisationDays';
	import { toastConnectionLost } from '$lib/toast.svelte';

	type Crew = {
		personId: string;
		label: string;
		ticked: boolean;
		half: 'start' | 'end' | null;
	};

	const LATER_KEY = 'pump-regularise-later';
	const API = `${base}/api/pump/regularisation`;
	const REASONS = ['no_network', 'phone_problem', 'app_problem', 'forgot', 'other'] as const;

	let days = $state<string[]>([]);
	let thisMonth = $state('');
	let calendar = $state<CalendarMonth | null>(null);
	let picked = $state<string | null>(null);
	let crew = $state<Crew[]>([]);
	let halfDay = $state(false);
	let later = $state(false);
	let step = $state(0); // 0 closed, 1 why, 2 who, 3 check, 4 sent, 5 calendar
	let monthAsked = 0;
	let day = $state('');
	let reason = $state<string | null>(null);
	let note = $state('');
	let voice = $state<Blob | null>(null);
	let voiceUrl = $state<string | null>(null);
	let recording = $state(false);
	let micRefused = $state(false);
	let sending = $state(false);
	let error = $state('');
	let recorder: MediaRecorder | null = null;
	let chunks: Blob[] = [];

	// Both languages, the pump's own first and large.
	const say = (hi: string, en: string) => (pumpLang.hindi ? [hi, en] : [en, hi]);

	const ticked = $derived(crew.filter((c) => c.ticked).length);

	async function load() {
		try {
			const response = await fetch(API);
			if (!response.ok) return;
			const body = await response.json();
			days = body.days;
			thisMonth = body.month;
		} catch {
			// Offline: the card waits for the next time the screen opens.
		}
	}

	onMount(() => {
		try {
			later = sessionStorage.getItem(LATER_KEY) === '1';
		} catch {
			later = false;
		}
		load();
		const again = () => document.visibilityState === 'visible' && load();
		document.addEventListener('visibilitychange', again);
		return () => document.removeEventListener('visibilitychange', again);
	});

	function putOff() {
		later = true;
		try {
			sessionStorage.setItem(LATER_KEY, '1');
		} catch {
			// Blocked storage: hidden until the page reloads.
		}
	}

	// A slow answer for a month the operator has already left is dropped.
	async function showMonth(month: string) {
		const asked = ++monthAsked;
		try {
			const response = await fetch(`${API}?month=${month}`);
			if (!response.ok) return false;
			const body = await response.json();
			if (asked === monthAsked) calendar = body;
			return true;
		} catch {
			toastConnectionLost();
			return false;
		}
	}

	async function openCalendar(first: string | null) {
		picked = first;
		if (await showMonth((first ?? thisMonth).slice(0, 7))) step = 5;
	}

	function changeMonth(month: string) {
		picked = null;
		showMonth(month);
	}

	async function apply(chosen: CalendarDay) {
		error = '';
		reason = null;
		note = '';
		clearVoice();
		day = chosen.day;
		try {
			const response = await fetch(`${API}?day=${chosen.day}`);
			if (!response.ok) {
				if (calendar) await showMonth(calendar.month);
				return;
			}
			const body = await response.json();
			crew = body.crew;
			halfDay = body.kind === 'partial';
			step = 1;
		} catch {
			toastConnectionLost();
		}
	}

	function backToCalendar() {
		stopRecording();
		step = 5;
		if (calendar) showMonth(calendar.month);
	}

	function closeCalendar() {
		step = 0;
		load();
	}

	function clearVoice() {
		if (voiceUrl) URL.revokeObjectURL(voiceUrl);
		voice = null;
		voiceUrl = null;
	}

	async function startRecording(event: PointerEvent) {
		event.preventDefault();
		if (recording) return;
		reason = 'other';
		clearVoice();
		try {
			const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
			const type = ['audio/webm', 'audio/mp4', 'audio/ogg'].find((t) =>
				MediaRecorder.isTypeSupported?.(t)
			);
			recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined);
			chunks = [];
			recorder.ondataavailable = (e) => e.data.size && chunks.push(e.data);
			recorder.onstop = () => {
				stream.getTracks().forEach((t) => t.stop());
				const blob = new Blob(chunks, { type: recorder?.mimeType || 'audio/webm' });
				if (blob.size > 0) {
					voice = blob;
					voiceUrl = URL.createObjectURL(blob);
				}
				recording = false;
			};
			recorder.start();
			recording = true;
			// Two minutes at most: the note is a sentence or two, and the upload stays small.
			setTimeout(stopRecording, 120_000);
		} catch {
			micRefused = true;
		}
	}

	function stopRecording() {
		if (recorder && recorder.state !== 'inactive') recorder.stop();
	}

	async function send() {
		if (!reason || sending) return;
		sending = true;
		error = '';
		const form = new FormData();
		form.set('day', day);
		form.set('reason', reason);
		if (note.trim()) form.set('note', note.trim());
		for (const c of crew) if (c.ticked) form.append('workers', c.personId);
		if (voice) form.set('voice', voice, `voice.${voice.type.includes('mp4') ? 'm4a' : 'webm'}`);
		try {
			const response = await fetch(API, { method: 'POST', body: form });
			const body = await response.json().catch(() => ({}));
			if (!response.ok) {
				error = body.error ?? 'Could not send';
				return;
			}
			step = 4;
			await load();
		} catch {
			toastConnectionLost();
		} finally {
			sending = false;
		}
	}
</script>

{#snippet two(hi: string, en: string, tag: 'strong' | 'span' = 'span')}
	{@const [first, second] = say(hi, en)}
	{#if tag === 'strong'}<strong class="first">{first}</strong>{:else}<span class="first"
			>{first}</span
		>{/if}
	<small class="second">{second}</small>
{/snippet}

{#snippet applyButton(chosen: CalendarDay)}
	{#if chosen.canApply}
		<button class="big" type="button" onclick={() => apply(chosen)} data-testid="reg-cal-apply">
			{@render two('अर्ज़ी भेजें', 'Apply')}
		</button>
	{/if}
{/snippet}

{#if days.length && !later && step === 0}
	{@const d = dayText(days[0])}
	<section class="card" aria-labelledby="reg-card-title" data-testid="reg-card">
		<p id="reg-card-title" class="title">
			{@render two(`${d.hi} की फोटो नहीं आई`, `No photo came on ${d.en}`, 'strong')}
		</p>
		{#if days.length > 1}
			<p class="more">
				{@render two(`कुल ${days.length} दिन छूटे हैं`, `${days.length} days missed in all`)}
			</p>
		{/if}
		<div class="row">
			<button
				class="big"
				type="button"
				onclick={() => openCalendar(days[0])}
				data-testid="reg-start"
			>
				{@render two('बताइए क्यों', 'Tell us why')}
			</button>
			<button class="quiet" type="button" onclick={putOff} data-testid="reg-later">
				{@render two('बाद में', 'Later')}
			</button>
		</div>
	</section>
{:else if thisMonth && step === 0}
	<button
		class="quiet open-calendar"
		type="button"
		onclick={() => openCalendar(null)}
		data-testid="reg-open-calendar"
	>
		{@render two('हाज़िरी कैलेंडर', 'Attendance calendar')}
	</button>
{/if}

{#if step > 0}
	{@const d = dayText(day)}
	<div
		class="sheet"
		role="dialog"
		aria-modal="true"
		aria-labelledby="reg-step-title"
		data-testid="reg-sheet"
	>
		<div class="sheet__body" data-testid="reg-sheet-body">
			{#if step < 4}
				<p class="progress">{step} / 3 · {pumpLang.hindi ? d.hi : d.en}</p>
			{/if}

			{#if step === 5 && calendar}
				<div class="cal-head">
					<h2 id="reg-step-title">
						{@render two('हाज़िरी कैलेंडर', 'Attendance calendar', 'strong')}
					</h2>
					<button class="quiet" type="button" onclick={closeCalendar} data-testid="reg-cal-close">
						{@render two('बंद करें', 'Close')}
					</button>
				</div>
				<RegularisationCalendar
					{calendar}
					selected={picked}
					hindi={pumpLang.hindi}
					bilingual
					onpick={(chosen) => (picked = chosen)}
					onmonth={changeMonth}
					action={applyButton}
				/>
			{:else if step === 1}
				<h2 id="reg-step-title">
					{@render two('फोटो क्यों नहीं ली?', 'Why was no photo taken?', 'strong')}
				</h2>
				<div class="reasons">
					{#each REASONS.filter((k) => k !== 'other') as key (key)}
						<button
							type="button"
							class="reason"
							class:reason--on={reason === key}
							aria-pressed={reason === key}
							data-testid="reg-reason-{key}"
							onclick={() => {
								reason = key;
								clearVoice();
							}}
						>
							<span class="emoji" aria-hidden="true">{REASON_TEXT[key].icon}</span>
							{@render two(REASON_TEXT[key].hi, REASON_TEXT[key].en)}
						</button>
					{/each}
					<button
						type="button"
						class="reason reason--voice"
						class:reason--on={reason === 'other'}
						class:recording
						aria-pressed={reason === 'other'}
						data-testid="reg-reason-other"
						onpointerdown={startRecording}
						onpointerup={stopRecording}
						onpointerleave={stopRecording}
						onpointercancel={stopRecording}
						oncontextmenu={(e) => e.preventDefault()}
					>
						<span class="emoji" aria-hidden="true">🎤</span>
						{#if recording}
							{@render two('बोलिए… छोड़ें तो रुकेगा', 'Speak… let go to stop')}
						{:else}
							{@render two('दबाकर बोलें (कुछ और)', 'Hold and speak (other)')}
						{/if}
					</button>
				</div>
				{#if voiceUrl}
					<div class="voice">
						<audio controls src={voiceUrl}></audio>
						<button type="button" class="quiet" onclick={clearVoice}
							>{@render two('हटाएँ', 'Remove')}</button
						>
					</div>
				{/if}
				{#if reason === 'other' && (micRefused || !voiceUrl)}
					<label class="note">
						{@render two('या लिखें क्या हुआ', 'Or write what happened')}
						<input bind:value={note} maxlength="500" data-testid="reg-note" />
					</label>
				{/if}
				<div class="row">
					<button
						class="big"
						type="button"
						disabled={!reason || (reason === 'other' && !voice && !note.trim())}
						onclick={() => (step = 2)}
						data-testid="reg-next">{@render two('आगे', 'Next')}</button
					>
					<button class="quiet" type="button" onclick={backToCalendar}
						>{@render two('बाद में', 'Later')}</button
					>
				</div>
			{:else if step === 2}
				<h2 id="reg-step-title">
					{#if halfDay}
						{@render two('किसकी फोटो छूटी?', 'Whose photo was missed?', 'strong')}
					{:else}
						{@render two('उस दिन कौन काम पर था?', 'Who worked that day?', 'strong')}
					{/if}
				</h2>
				{#if crew.length}
					<p class="hint">
						{@render two('जो नहीं था उस पर टैप करें', 'Tap anyone who was not there')}
					</p>
				{/if}
				{#if crew.length}
					<ul class="faces">
						{#each crew as c (c.personId)}
							<li>
								<button
									type="button"
									class="face"
									class:face--off={!c.ticked}
									aria-pressed={c.ticked}
									data-testid="reg-face"
									onclick={() => (c.ticked = !c.ticked)}
								>
									<img
										src={`${base}/api/persons/${c.personId}/face`}
										alt=""
										loading="lazy"
										onerror={(e) =>
											((e.currentTarget as HTMLImageElement).style.visibility = 'hidden')}
									/>
									<span class="mark" aria-hidden="true">{c.ticked ? '✓' : '✕'}</span>
									<span class="name">{c.label}</span>
									{#if c.half}
										<span class="half" data-testid="reg-face-half"
											>{pumpLang.hindi ? HALF_TEXT[c.half].hi : HALF_TEXT[c.half].en}</span
										>
									{/if}
								</button>
							</li>
						{/each}
					</ul>
				{:else}
					<p class="hint" data-testid="reg-no-crew">
						{@render two(
							'चुनने के लिए कोई मेंबर नहीं: इस पंप पर अभी किसी की हाज़िरी नहीं लगी',
							'No one to select: no worker has attendance at this pump yet'
						)}
					</p>
				{/if}
				<div class="row">
					<button
						class="big"
						type="button"
						disabled={ticked === 0}
						onclick={() => (step = 3)}
						data-testid="reg-next">{@render two(`आगे (${ticked})`, `Next (${ticked})`)}</button
					>
					<button class="quiet" type="button" onclick={() => (step = 1)}
						>{@render two('पीछे', 'Back')}</button
					>
				</div>
			{:else if step === 3}
				<h2 id="reg-step-title">{@render two('जाँचें और भेजें', 'Check and send', 'strong')}</h2>
				<dl class="check">
					<div>
						<dt>{@render two('दिन', 'Day')}</dt>
						<dd>{pumpLang.hindi ? d.hi : d.en}</dd>
					</div>
					<div>
						<dt>{@render two('कारण', 'Reason')}</dt>
						<dd>
							{REASON_TEXT[reason!].icon}
							{pumpLang.hindi ? REASON_TEXT[reason!].hi : REASON_TEXT[reason!].en}{voice
								? ' 🎤'
								: ''}{note ? `: ${note}` : ''}
						</dd>
					</div>
					<div>
						<dt>{@render two('मेंबर', 'Members')}</dt>
						<dd>
							{crew
								.filter((c) => c.ticked)
								.map((c) => c.label)
								.join(', ')}
						</dd>
					</div>
				</dl>
				{#if error}<p class="error" role="alert">{error}</p>{/if}
				<div class="row">
					<button class="big" type="button" disabled={sending} onclick={send} data-testid="reg-send"
						>{@render two('भेजें', 'Send')}</button
					>
					<button class="quiet" type="button" onclick={() => (step = 2)}
						>{@render two('पीछे', 'Back')}</button
					>
				</div>
			{:else}
				<h2 id="reg-step-title" class="sent" data-testid="reg-sent">
					<span aria-hidden="true">⏳</span>
					{@render two('भेज दिया, मंज़ूरी का इंतज़ार', 'Sent, waiting for approval', 'strong')}
				</h2>
				<div class="row">
					<button class="big" type="button" onclick={backToCalendar} data-testid="reg-close"
						>{@render two('ठीक है', 'OK')}</button
					>
				</div>
			{/if}
		</div>
	</div>
{/if}

<style>
	.first {
		display: block;
		font-size: 1.125rem;
		line-height: 1.3;
	}
	.second {
		display: block;
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 400;
	}
	.card {
		margin: var(--space-4) var(--space-4) 0;
		padding: var(--space-4);
		background: #fff8e6;
		border: 2px solid #e0a100;
		border-radius: var(--radius-lg);
		display: grid;
		gap: var(--space-3);
	}
	.card p {
		margin: 0;
	}
	.row {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
		align-items: stretch;
	}
	.big {
		flex: 1 1 10rem;
		min-height: 3.5rem;
		padding: var(--space-2) var(--space-4);
		color: var(--primary-on);
		font-weight: 700;
		background: var(--brand-teal);
		border: 0;
		border-radius: var(--radius-md);
		cursor: pointer;
		text-align: center;
	}
	.big .second {
		color: inherit;
		opacity: 0.85;
	}
	.check dt .first {
		font-size: var(--text-sm);
		color: var(--ink-muted);
	}
	.big:disabled {
		opacity: 0.45;
		cursor: not-allowed;
	}
	.quiet {
		min-height: 3.5rem;
		padding: var(--space-2) var(--space-4);
		color: var(--ink-strong);
		background: var(--surface-raised);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.open-calendar {
		display: block;
		width: calc(100% - 2 * var(--space-4));
		margin: var(--space-4) var(--space-4) 0;
	}
	.cal-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-2);
	}
	.half {
		color: var(--alert);
		font-size: var(--text-sm);
		font-weight: 600;
		line-height: 1.2;
	}
	.sheet {
		position: fixed;
		inset: 0;
		z-index: var(--z-drawer);
		display: grid;
		align-items: end;
		background: rgba(22, 38, 37, 0.45);
	}
	.sheet__body {
		max-height: 100dvh;
		overflow-y: auto;
		padding: var(--space-5) var(--space-4) max(var(--space-5), env(safe-area-inset-bottom));
		background: var(--surface-raised);
		border-radius: var(--radius-lg) var(--radius-lg) 0 0;
		display: grid;
		gap: var(--space-4);
	}
	.sheet h2 {
		margin: 0;
	}
	/* A long crew scrolls; the buttons stay on screen. */
	.sheet__body > .row {
		--sheet-end: max(var(--space-5), env(safe-area-inset-bottom));
		position: sticky;
		bottom: calc(-1 * var(--sheet-end));
		margin-bottom: calc(-1 * var(--sheet-end));
		padding-block: var(--space-2) var(--sheet-end);
		background: var(--surface-raised);
	}
	.progress {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.reasons {
		display: grid;
		grid-template-columns: 1fr 1fr;
		gap: var(--space-2);
	}
	.reason {
		display: grid;
		justify-items: center;
		gap: var(--space-1);
		min-height: 6.5rem;
		padding: var(--space-3) var(--space-2);
		text-align: center;
		background: var(--surface-subtle);
		border: 2px solid var(--brand-mist);
		border-radius: var(--radius-lg);
		cursor: pointer;
		touch-action: none;
		user-select: none;
		-webkit-user-select: none;
	}
	.reason--voice {
		grid-column: 1 / -1;
	}
	.reason--on {
		border-color: var(--brand-teal);
		background: var(--primary-tint);
	}
	.recording {
		border-color: var(--alert);
		background: var(--alert-tint);
	}
	.emoji {
		font-size: 2rem;
		line-height: 1;
	}
	.voice {
		display: flex;
		gap: var(--space-2);
		align-items: center;
	}
	.voice audio {
		flex: 1;
		min-width: 0;
	}
	.note {
		display: grid;
		gap: var(--space-1);
	}
	.note input {
		min-height: 3rem;
		padding: var(--space-2) var(--space-3);
		font-size: 1rem;
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.hint {
		margin: 0;
	}
	.faces {
		list-style: none;
		margin: 0;
		padding: 0;
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(6.25rem, 1fr));
		gap: var(--space-2);
	}
	.face {
		position: relative;
		width: 100%;
		display: grid;
		gap: var(--space-1);
		padding: var(--space-1);
		background: var(--primary-tint);
		border: 2px solid var(--brand-teal);
		border-radius: var(--radius-md);
		cursor: pointer;
	}
	.face img {
		width: 100%;
		aspect-ratio: 1;
		object-fit: cover;
		border-radius: var(--radius-sm);
		background: var(--surface-muted);
	}
	.face--off {
		background: var(--surface-subtle);
		border-color: var(--brand-mist);
	}
	.face--off img {
		filter: grayscale(1);
		opacity: 0.4;
	}
	.mark {
		position: absolute;
		top: var(--space-1);
		right: var(--space-1);
		display: grid;
		width: 1.75rem;
		height: 1.75rem;
		place-items: center;
		color: #fff;
		font-weight: 700;
		background: var(--brand-teal);
		border-radius: 999px;
	}
	.face--off .mark {
		background: var(--alert);
	}
	.name {
		font-size: var(--text-sm);
		overflow-wrap: anywhere;
	}
	.check {
		display: grid;
		gap: var(--space-3);
		margin: 0;
	}
	.check dd {
		margin: var(--space-1) 0 0;
		font-weight: 600;
		overflow-wrap: anywhere;
	}
	.error {
		margin: 0;
		color: var(--alert);
		font-weight: 600;
	}
	.sent {
		display: grid;
		justify-items: center;
		text-align: center;
		gap: var(--space-2);
	}
	.sent > span {
		font-size: 3rem;
	}
</style>
