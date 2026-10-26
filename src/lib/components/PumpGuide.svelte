<script lang="ts">
	// Walkthrough of the pump screen for operators: one action per step, a moving picture of it,
	// the same button the screen shows, and a Listen button that reads the step aloud. On the
	// first sign-in it cannot be closed (forced): no close, Escape and the phone's Back do
	// nothing, only the last step's button ends it. From the Help button it closes any time.
	import { onDestroy, tick } from 'svelte';
	import { fly } from 'svelte/transition';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import ArrowRight from '@lucide/svelte/icons/arrow-right';
	import Camera from '@lucide/svelte/icons/camera';
	import Check from '@lucide/svelte/icons/check';
	import CircleHelp from '@lucide/svelte/icons/circle-help';
	import Pointer from '@lucide/svelte/icons/pointer';
	import Send from '@lucide/svelte/icons/send';
	import Volume2 from '@lucide/svelte/icons/volume-2';
	import X from '@lucide/svelte/icons/x';
	import { pumpLang, setPumpHindi, t } from '$lib/pumpLang.svelte';

	let { forced, onclose }: { forced: boolean; onclose: () => void } = $props();

	type Step = {
		scene: 'operator' | 'click' | 'group' | 'send' | 'names' | 'end';
		title: string;
		body: string;
		// The button drawn in the scene; tap is a button only named in the text.
		button?: string;
		tap?: string;
	};
	// Straight to the first action. Button names are the screen's own words, so the step names
	// exactly what to tap. The 9 hours is the default shift-end gap (EVENING_MIN_GAP_MINUTES).
	const STEPS: Step[] = [
		{
			scene: 'operator',
			title: 'Upload the Pump Operator photo',
			body: 'Tap the "{button}" button. Make sure only the Pump Operator is in the photo, with the face close, clear and fully visible.',
			button: 'Take Pump Operator photo'
		},
		{
			scene: 'click',
			title: 'Click the photo',
			body: 'When the face of the Pump Operator is clear and fully visible on the screen, tap the "{button}" button.',
			button: 'Use this photo'
		},
		{
			scene: 'group',
			title: 'Upload the Pump Members photo',
			body: 'Tap the "{button}" button. Make sure every Pump Member is in the photo and every face is clear.',
			button: 'Take Pump Members photo'
		},
		{
			scene: 'send',
			title: 'Send the photos',
			body: 'Tap the "{button}" button. After sending, wait a little and do not close the page.',
			button: 'Submit photos'
		},
		{
			scene: 'names',
			title: 'Write the names',
			body: 'Write the full name of every Pump Member. Then tap the "{button}" button. Your shift will then start.',
			button: 'Done reviewing'
		},
		{
			scene: 'end',
			title: 'Close the shift',
			body: 'After 9 hours, take and upload the photos of the Pump Operator and all Pump Members again. Then tap the "{button}" button. Your shift will close.',
			tap: 'Done reviewing'
		}
	];
	const HELP_NOTE = 'Any problem? Tap the "Help" button at the top.';
	const SHIRTS = ['#05ad98', '#f08a4b', '#4c7bd9', '#9b5fc0'];

	let index = $state(0);
	let direction = $state(1);
	let nextButton = $state<HTMLButtonElement>();
	const step = $derived(STEPS[index]);
	const last = $derived(index === STEPS.length - 1);
	const body = $derived(t(step.body, { button: t(step.button ?? step.tap ?? '') }));
	const reducedMotion =
		typeof window !== 'undefined' &&
		window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
	const canSpeak = typeof window !== 'undefined' && 'speechSynthesis' in window;
	let speaking = $state(false);

	function stopSpeaking() {
		if (canSpeak) window.speechSynthesis.cancel();
		speaking = false;
	}

	function speak() {
		if (!canSpeak) return;
		stopSpeaking();
		const text = [t(step.title), body, last ? t(HELP_NOTE) : ''].join('. ').replace(/"/g, '');
		const utterance = new SpeechSynthesisUtterance(text);
		utterance.lang = pumpLang.hindi ? 'hi-IN' : 'en-IN';
		utterance.rate = 0.9;
		utterance.onend = () => (speaking = false);
		utterance.onerror = () => (speaking = false);
		speaking = true;
		window.speechSynthesis.speak(utterance);
	}

	async function go(to: number) {
		stopSpeaking();
		direction = to > index ? 1 : -1;
		index = to;
		await tick();
		nextButton?.focus();
	}

	function next() {
		if (!last) return go(index + 1);
		stopSpeaking();
		onclose();
	}

	function onkeydown(event: KeyboardEvent) {
		if (event.key !== 'Escape') return;
		event.preventDefault();
		if (!forced) onclose();
	}

	// The phone's Back button would leave the page; on the first sign-in it stays on the guide.
	function onpopstate() {
		if (forced) history.pushState({ pumpGuide: true }, '', location.href);
	}

	$effect(() => {
		if (forced) history.pushState({ pumpGuide: true }, '', location.href);
		const overflow = document.body.style.overflow;
		document.body.style.overflow = 'hidden';
		nextButton?.focus();
		return () => {
			document.body.style.overflow = overflow;
		};
	});

	onDestroy(stopSpeaking);
</script>

<svelte:window {onkeydown} {onpopstate} />

{#snippet person(x: number, y: number, size: number, shirt = '#05ad98')}
	<g transform="translate({x} {y}) scale({size})">
		<path d="M-22 40 C-22 20 -12 14 0 14 C12 14 22 20 22 40 Z" fill={shirt} />
		<circle cx="0" cy="-2" r="13" fill="#e2a978" />
		<path
			d="M-13 -4 C-13 -16 -6 -19 0 -19 C8 -19 13 -14 13 -4 C9 -10 -4 -12 -13 -4 Z"
			fill="#2f2620"
		/>
		<circle cx="-4.5" cy="-1" r="1.5" fill="#2f2620" />
		<circle cx="4.5" cy="-1" r="1.5" fill="#2f2620" />
		<path
			d="M-4 5 Q0 8 4 5"
			stroke="#2f2620"
			stroke-width="1.5"
			fill="none"
			stroke-linecap="round"
		/>
	</g>
{/snippet}

{#snippet brackets(x: number, y: number, w: number, h: number, motion = '')}
	<g class={motion} stroke="#05ad98" stroke-width="4" fill="none" stroke-linecap="round">
		<path d="M{x} {y + 12} V{y} H{x + 12}" />
		<path d="M{x + w - 12} {y} H{x + w} V{y + 12}" />
		<path d="M{x} {y + h - 12} V{y + h} H{x + 12}" />
		<path d="M{x + w - 12} {y + h} H{x + w} V{y + h - 12}" />
	</g>
{/snippet}

<!-- The motion class sits on an outer group so its CSS transform does not replace the position. -->
{#snippet checkMark(x: number, y: number, motion = '')}
	<g class={motion}>
		<g transform="translate({x} {y})">
			<circle r="11" fill="#05ad98" />
			<path
				d="M-5 0 L-1.5 4 L5.5 -4"
				stroke="#fff"
				stroke-width="2.6"
				fill="none"
				stroke-linecap="round"
				stroke-linejoin="round"
			/>
		</g>
	</g>
{/snippet}

<div class="guide" role="presentation">
	<div
		class="guide-card"
		role="dialog"
		aria-modal="true"
		aria-labelledby="guide-title"
		aria-describedby="guide-body"
		data-testid="pump-guide"
		data-forced={forced}
	>
		<div class="guide-top">
			<div
				class="guide-dots"
				role="img"
				aria-label={t('Step {n} of {total}', { n: index + 1, total: STEPS.length })}
			>
				{#each STEPS as _, dot (dot)}
					<span class:done={dot < index} class:current={dot === index}></span>
				{/each}
			</div>
			<button
				class="guide-lang"
				type="button"
				role="switch"
				aria-checked={pumpLang.hindi}
				aria-label="हिंदी / English"
				data-testid="guide-lang"
				onclick={() => {
					stopSpeaking();
					setPumpHindi(!pumpLang.hindi);
				}}
			>
				<span class:active={pumpLang.hindi} lang="hi">हिंदी</span>
				<span class:active={!pumpLang.hindi} lang="en">English</span>
			</button>
			{#if !forced}
				<button
					class="guide-close"
					type="button"
					onclick={onclose}
					aria-label={t('Close guide')}
					data-testid="guide-close"
				>
					<X size={22} />
				</button>
			{/if}
		</div>

		{#key index}
			<div
				class="guide-step"
				in:fly={{ x: 48 * direction, duration: reducedMotion ? 0 : 280, opacity: 0 }}
			>
				<div class="guide-scene" aria-hidden="true" data-scene={step.scene}>
					<svg viewBox="0 0 280 160" class="scene-art">
						{#if step.scene === 'operator'}
							<defs>
								<clipPath id="guide-operator-clip">
									<rect x="20" y="10" width="240" height="140" rx="12" />
								</clipPath>
							</defs>
							<rect x="20" y="10" width="240" height="140" rx="12" fill="#e4f7f4" />
							<g clip-path="url(#guide-operator-clip)">{@render person(140, 86, 1.9)}</g>
							{@render brackets(100, 34, 80, 78, 'zoom')}
							<rect class="flash" x="20" y="10" width="240" height="140" rx="12" fill="#fff" />
						{:else if step.scene === 'click'}
							<rect x="62" y="6" width="156" height="148" rx="16" fill="#162625" />
							<defs>
								<clipPath id="guide-screen-clip">
									<rect x="70" y="16" width="140" height="104" rx="6" />
								</clipPath>
							</defs>
							<rect x="70" y="16" width="140" height="104" rx="6" fill="#e4f7f4" />
							<g clip-path="url(#guide-screen-clip)">{@render person(140, 72, 1.5)}</g>
							{@render brackets(108, 34, 64, 62, 'steady')}
							<circle
								class="shutter"
								cx="140"
								cy="137"
								r="11"
								fill="#fff"
								stroke="#05ad98"
								stroke-width="3"
							/>
							<rect class="flash" x="70" y="16" width="140" height="104" rx="6" fill="#fff" />
						{:else if step.scene === 'group'}
							<rect x="10" y="10" width="260" height="140" rx="12" fill="#e4f7f4" />
							<defs>
								<clipPath id="guide-group-clip">
									<rect x="10" y="10" width="260" height="140" rx="12" />
								</clipPath>
							</defs>
							<g clip-path="url(#guide-group-clip)">
								{#each [60, 140, 220] as x, i (x)}
									<g style="--i: {i}">
										{@render person(x, 92, 1.4, SHIRTS[i])}
										{@render brackets(x - 26, 56, 52, 50, 'seq')}
										{@render checkMark(x + 26, 54, 'seq-check')}
									</g>
								{/each}
							</g>
						{:else if step.scene === 'send'}
							<rect x="40" y="110" width="200" height="14" rx="7" fill="#e4f7f4" />
							<rect class="bar" x="40" y="110" width="200" height="14" rx="7" fill="#05ad98" />
							<g class="fly">
								<rect
									x="44"
									y="34"
									width="56"
									height="48"
									rx="6"
									fill="#fff"
									stroke="#bbbfbf"
									stroke-width="2"
								/>
								{@render person(72, 56, 0.7)}
							</g>
							<g class="fly fly-2">
								<rect
									x="108"
									y="34"
									width="56"
									height="48"
									rx="6"
									fill="#fff"
									stroke="#bbbfbf"
									stroke-width="2"
								/>
								{@render person(126, 56, 0.6, '#f08a4b')}
								{@render person(146, 56, 0.6)}
							</g>
							<circle
								class="ring"
								cx="212"
								cy="58"
								r="20"
								fill="none"
								stroke="#05ad98"
								stroke-width="3"
							/>
							{@render checkMark(212, 58, 'done')}
						{:else if step.scene === 'names'}
							<defs>
								<clipPath id="guide-face-clip"><circle cx="66" cy="80" r="30" /></clipPath>
								<clipPath id="guide-type-clip">
									<rect class="type-rect" x="118" y="64" width="116" height="32" />
								</clipPath>
							</defs>
							<rect
								x="20"
								y="22"
								width="240"
								height="116"
								rx="12"
								fill="#fff"
								stroke="#bbbfbf"
								stroke-width="2"
							/>
							<circle cx="66" cy="80" r="30" fill="#e4f7f4" />
							<g clip-path="url(#guide-face-clip)">{@render person(66, 86, 1.25)}</g>
							<rect
								x="112"
								y="64"
								width="128"
								height="32"
								rx="6"
								fill="#f5f7f7"
								stroke="#05ad98"
								stroke-width="2"
							/>
							<text
								x="120"
								y="86"
								font-size="16"
								font-weight="700"
								fill="#162625"
								clip-path="url(#guide-type-clip)">{t('Ramesh Kumar')}</text
							>
							{@render checkMark(240, 40, 'late')}
						{:else}
							<g transform="translate(92 80)">
								<circle r="50" fill="#fff" stroke="#162625" stroke-width="5" />
								{#each [0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330] as angle (angle)}
									<line
										y1="-42"
										y2="-36"
										stroke="#4d5e5b"
										stroke-width="3"
										stroke-linecap="round"
										transform="rotate({angle})"
									/>
								{/each}
								<g transform="rotate(120)">
									<line
										class="hand-hour"
										y1="0"
										y2="-24"
										stroke="#162625"
										stroke-width="5"
										stroke-linecap="round"
									/>
								</g>
								<line
									class="hand-minute"
									y1="0"
									y2="-36"
									stroke="#05ad98"
									stroke-width="4"
									stroke-linecap="round"
								/>
								<circle r="5" fill="#162625" />
							</g>
							<g transform="translate(206 80)">
								<g class="repeat">
									<path
										d="M-26 -6 A28 28 0 0 1 24 -14"
										stroke="#05ad98"
										stroke-width="6"
										fill="none"
										stroke-linecap="round"
									/>
									<path d="M18 -26 L26 -12 L10 -10 Z" fill="#05ad98" />
									<path
										d="M26 6 A28 28 0 0 1 -24 14"
										stroke="#05ad98"
										stroke-width="6"
										fill="none"
										stroke-linecap="round"
									/>
									<path d="M-18 26 L-26 12 L-10 10 Z" fill="#05ad98" />
								</g>
								<g transform="translate(-12 -12)"><Camera size={24} color="#162625" /></g>
							</g>
						{/if}
					</svg>
					{#if step.button}
						<div class="mock-row">
							<span class="mock-target">
								<span class="button button--primary mock-button">
									{#if step.scene === 'send'}<Send
											size={18}
										/>{:else if step.scene === 'names'}<Check size={18} />{:else}<Camera
											size={18}
										/>{/if}
									{t(step.button)}
								</span>
								<span class="tap-hand"><Pointer size={34} strokeWidth={1.8} /></span>
							</span>
						</div>
					{:else if step.scene === 'end'}
						<div class="mock-row">
							<span class="mock-target">
								<span class="help-chip"><CircleHelp size={18} /> {t('Help')}</span>
								<span class="tap-hand"><Pointer size={34} strokeWidth={1.8} /></span>
							</span>
						</div>
					{/if}
				</div>

				<div class="guide-text">
					<h2 id="guide-title" data-testid="guide-title">{t(step.title)}</h2>
					<p id="guide-body">{body}</p>
					{#if last}<p class="guide-help-note">{t(HELP_NOTE)}</p>{/if}
				</div>
			</div>
		{/key}

		<div class="guide-actions">
			{#if canSpeak}
				<button
					class="guide-listen"
					class:speaking
					type="button"
					onclick={() => (speaking ? stopSpeaking() : speak())}
				>
					<Volume2 size={22} />
					<span>{t('Listen')}</span>
				</button>
			{/if}
			{#if index > 0}
				<button
					class="button button--secondary guide-back"
					type="button"
					onclick={() => go(index - 1)}
					aria-label={t('Back')}
				>
					<ArrowLeft size={22} />
				</button>
			{/if}
			<button
				class="button button--primary guide-next"
				type="button"
				bind:this={nextButton}
				onclick={next}
				data-testid="guide-next"
			>
				{#if last}<Check size={20} /> {t('Start')}{:else}{t('Next')}
					<ArrowRight size={20} />{/if}
			</button>
		</div>
	</div>
</div>

<style>
	.guide {
		position: fixed;
		inset: 0;
		z-index: var(--z-drawer);
		display: grid;
		align-items: end;
		justify-items: center;
		padding: var(--space-3);
		padding-bottom: max(var(--space-3), env(safe-area-inset-bottom));
		background: rgb(16 39 37 / 72%);
		animation: fade-in 200ms ease-out;
	}

	@media (min-width: 40rem) {
		.guide {
			align-items: center;
		}
	}

	.guide-card {
		display: grid;
		width: min(100%, 30rem);
		max-height: calc(100dvh - 1.5rem);
		gap: var(--space-4);
		padding: var(--space-4);
		overflow-y: auto;
		background: var(--surface-raised);
		border-radius: 1.25rem;
		box-shadow: 0 1.25rem 3rem rgb(0 0 0 / 30%);
		animation: rise 320ms cubic-bezier(0.2, 0.9, 0.3, 1.2);
	}

	.guide-top {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.guide-dots {
		display: flex;
		flex: 1;
		gap: 0.375rem;
	}

	.guide-dots span {
		width: 0.625rem;
		height: 0.625rem;
		background: var(--brand-mist);
		border-radius: 999px;
		transition:
			width 250ms ease,
			background 250ms ease;
	}

	.guide-dots span.done {
		background: var(--brand-teal);
	}

	.guide-dots span.current {
		width: 1.75rem;
		background: var(--brand-teal);
	}

	.guide-lang {
		display: inline-flex;
		min-height: 2.75rem;
		padding: 0.1875rem;
		gap: 0.125rem;
		background: var(--surface-subtle);
		border: 1px solid var(--brand-mist);
		border-radius: 999px;
		cursor: pointer;
	}

	.guide-lang span {
		display: grid;
		place-items: center;
		padding: 0 var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-base);
		font-weight: 700;
		border-radius: 999px;
	}

	.guide-lang span.active {
		color: var(--primary-on);
		background: var(--brand-teal);
	}

	.guide-close {
		display: grid;
		width: 2.75rem;
		height: 2.75rem;
		place-items: center;
		color: var(--ink-muted);
		background: transparent;
		border: 0;
		border-radius: 999px;
		cursor: pointer;
	}

	.guide-step {
		display: grid;
		gap: var(--space-4);
	}

	.guide-scene {
		display: grid;
		gap: var(--space-3);
		justify-items: center;
		padding: var(--space-3);
		background: var(--surface-subtle);
		border-radius: 1rem;
	}

	.scene-art {
		width: 100%;
		max-width: 20rem;
		height: auto;
	}

	.guide-text h2 {
		margin: 0;
		color: var(--ink-strong);
		font-size: 1.625rem;
		line-height: 1.25;
	}

	.guide-text p {
		margin: var(--space-2) 0 0;
		color: var(--ink-default);
		font-size: 1.25rem;
		line-height: 1.5;
	}

	.guide-text .guide-help-note {
		color: var(--ink-muted);
		font-size: 1.0625rem;
	}

	.guide-actions {
		display: flex;
		align-items: stretch;
		gap: var(--space-2);
	}

	.guide-actions .button {
		min-height: 3.5rem;
		font-size: 1.1875rem;
	}

	.guide-next {
		flex: 1;
		gap: var(--space-2);
	}

	.guide-back {
		width: 3.5rem;
		padding: 0;
	}

	.guide-listen {
		display: grid;
		min-width: 3.5rem;
		padding: 0 var(--space-2);
		place-items: center;
		color: var(--ink-strong);
		font-size: var(--text-xs);
		font-weight: 700;
		background: var(--primary-tint);
		border: 1px solid var(--brand-teal);
		border-radius: var(--radius-md);
		cursor: pointer;
	}

	.guide-listen.speaking {
		animation: pulse-ring 1.2s ease-out infinite;
	}

	/* The button the screen shows, with a hand tapping it. */
	.mock-row {
		position: relative;
		display: flex;
		justify-content: center;
		width: 100%;
		padding-bottom: var(--space-5);
	}

	/* The hand sits on the button's lower right corner, never over its label. */
	.mock-target {
		position: relative;
		display: inline-flex;
	}

	.mock-button {
		gap: var(--space-2);
		pointer-events: none;
		animation: press 2.4s ease-in-out infinite;
	}

	.help-chip {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		padding: var(--space-2) var(--space-3);
		color: var(--ink-strong);
		font-weight: 700;
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: 999px;
		animation: press 2.4s ease-in-out infinite;
	}

	.tap-hand {
		position: absolute;
		right: -1.25rem;
		bottom: -1.75rem;
		color: var(--ink-strong);
		filter: drop-shadow(0 0 2px rgb(255 255 255));
		animation: tap 2.4s ease-in-out infinite;
	}

	/* Scenes. Each element's resting style is its final look, so with reduced motion the
	   picture still shows the finished action. */
	.sun,
	.pop,
	.zoom,
	.shutter,
	.seq,
	.seq-check,
	.bar,
	.fly,
	.done,
	.ring,
	.type-rect,
	.hand-minute,
	.hand-hour,
	.repeat {
		transform-box: fill-box;
		transform-origin: center;
	}

	.sun {
		animation: sun 3.6s ease-in-out infinite;
	}

	.moon {
		animation: moon 3.6s ease-in-out infinite;
	}

	.pop {
		animation: pop 3.6s ease-out infinite;
	}

	.zoom {
		animation: zoom 2.4s ease-out infinite;
	}

	.steady {
		animation: blink 1.2s ease-in-out infinite;
	}

	.flash {
		opacity: 0;
		animation: flash 2.4s ease-out infinite;
	}

	.shutter {
		animation: shutter 2.4s ease-in-out infinite;
	}

	.seq {
		animation: seq 4s ease-out infinite;
		animation-delay: calc(var(--i) * 0.5s);
	}

	.seq-check {
		animation: seq-check 4s ease-out infinite;
		animation-delay: calc(var(--i) * 0.5s);
	}

	.bar {
		transform-origin: left center;
		animation: bar 3.2s ease-in-out infinite;
	}

	.fly {
		animation: fly 3.2s ease-in infinite;
	}

	.fly-2 {
		animation-delay: 0.25s;
	}

	.done {
		animation: done 3.2s ease-out infinite;
	}

	.ring {
		opacity: 0;
		animation: ring 3.2s ease-out infinite;
	}

	.type-rect {
		transform-origin: left center;
		animation: type 3.6s steps(12, end) infinite;
	}

	.late {
		animation: late 3.6s ease-out infinite;
	}

	.hand-minute,
	.hand-hour {
		transform-origin: center bottom;
	}

	.hand-minute {
		animation: spin 3s linear infinite;
	}

	.hand-hour {
		animation: spin 36s linear infinite;
	}

	.repeat {
		animation: spin 6s linear infinite;
	}

	@keyframes fade-in {
		from {
			opacity: 0;
		}
	}

	@keyframes rise {
		from {
			opacity: 0;
			transform: translateY(2rem);
		}
	}

	@keyframes press {
		0%,
		40%,
		70%,
		100% {
			box-shadow: 0 0 0 0 rgb(5 173 152 / 0%);
			transform: scale(1);
		}
		50% {
			box-shadow: 0 0 0 0.5rem rgb(5 173 152 / 35%);
			transform: scale(0.95);
		}
	}

	@keyframes tap {
		0%,
		100% {
			transform: translate(1.5rem, 1rem);
			opacity: 0;
		}
		25% {
			transform: translate(0, 0);
			opacity: 1;
		}
		50% {
			transform: translate(-0.25rem, -0.25rem) scale(0.88);
		}
		70% {
			transform: translate(0, 0);
			opacity: 1;
		}
	}

	@keyframes sun {
		0%,
		100% {
			transform: translateY(1.25rem);
			opacity: 0.4;
		}
		40%,
		60% {
			transform: translateY(0);
			opacity: 1;
		}
	}

	@keyframes moon {
		0%,
		40% {
			opacity: 0.25;
		}
		70%,
		90% {
			opacity: 1;
		}
	}

	@keyframes pop {
		0%,
		30% {
			transform: scale(0);
		}
		42% {
			transform: scale(1.25);
		}
		50%,
		100% {
			transform: scale(1);
		}
	}

	@keyframes zoom {
		0% {
			transform: scale(1.5);
			opacity: 0;
		}
		40%,
		100% {
			transform: scale(1);
			opacity: 1;
		}
	}

	@keyframes flash {
		0%,
		48% {
			opacity: 0;
		}
		52% {
			opacity: 0.9;
		}
		70%,
		100% {
			opacity: 0;
		}
	}

	@keyframes shutter {
		0%,
		44%,
		60%,
		100% {
			transform: scale(1);
		}
		50% {
			transform: scale(0.75);
		}
	}

	@keyframes seq {
		0% {
			opacity: 0;
			transform: scale(1.4);
		}
		15%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
	}

	@keyframes seq-check {
		0%,
		15% {
			opacity: 0;
			transform: scale(0);
		}
		25%,
		100% {
			opacity: 1;
			transform: scale(1);
		}
	}

	@keyframes bar {
		0% {
			transform: scaleX(0);
		}
		60%,
		100% {
			transform: scaleX(1);
		}
	}

	@keyframes fly {
		0% {
			transform: translate(0, 0);
			opacity: 1;
		}
		55% {
			transform: translate(90px, -10px) scale(0.3);
			opacity: 0;
		}
		56%,
		100% {
			opacity: 0;
		}
	}

	@keyframes done {
		0%,
		58% {
			transform: scale(0);
		}
		68% {
			transform: scale(1.3);
		}
		75%,
		100% {
			transform: scale(1);
		}
	}

	@keyframes ring {
		0%,
		62% {
			opacity: 0;
			transform: scale(0.6);
		}
		70% {
			opacity: 1;
		}
		100% {
			opacity: 0;
			transform: scale(1.6);
		}
	}

	@keyframes blink {
		50% {
			opacity: 0.35;
		}
	}

	@keyframes type {
		0% {
			transform: scaleX(0);
		}
		60%,
		100% {
			transform: scaleX(1);
		}
	}

	@keyframes late {
		0%,
		65% {
			opacity: 0;
		}
		75%,
		100% {
			opacity: 1;
		}
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@keyframes pulse-ring {
		0% {
			box-shadow: 0 0 0 0 rgb(5 173 152 / 45%);
		}
		100% {
			box-shadow: 0 0 0 0.75rem rgb(5 173 152 / 0%);
		}
	}

	@media (prefers-reduced-motion: reduce) {
		.guide,
		.guide :global(*) {
			animation: none !important;
			transition: none !important;
		}
	}
</style>
