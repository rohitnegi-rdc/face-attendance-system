<script lang="ts">
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import ArrowLeft from '@lucide/svelte/icons/arrow-left';
	import MapPin from '@lucide/svelte/icons/map-pin';
	import { formatDate } from '$lib/date';

	let { data, form } = $props();
	const s = $derived(data.session);
	const pending = $derived(s.location_status === 'pending');
	const mapUrl = (lat: number, lng: number) => `https://www.google.com/maps?q=${lat},${lng}`;
	// Both points on one map: directions from the operator to the pump.
	const bothUrl = $derived(
		s.gps_lat !== null && s.pump_gps_lat !== null
			? `https://www.google.com/maps/dir/${s.gps_lat},${s.gps_lng}/${s.pump_gps_lat},${s.pump_gps_lng}`
			: ''
	);
	let busy = $state(false);
</script>

<svelte:head><title>Approve {s.pump_code} | Face Attendance</title></svelte:head>

<div class="page approval-page">
	<a class="back" href={resolve('/plant-manager/approvals')}><ArrowLeft size={16} /> Approvals</a>

	<header class="page-header">
		<div class="page-header__copy">
			<p class="eyebrow">Location approval</p>
			<h1>{s.pump_code} · {s.plant_name}</h1>
			<p>Shift {formatDate(s.session_date)} · photo sent {s.sent_at}</p>
		</div>
	</header>

	<div class="problem" class:problem--done={!pending}>
		<MapPin size={20} aria-hidden="true" />
		<div>
			<strong>{s.reason}</strong>
			{#if pending}
				<p>Call the operator to verify where they were, then approve or reject.</p>
			{:else}
				<p>
					<span
						class="status-badge"
						class:status-badge--success={s.location_status === 'approved'}
						class:status-badge--critical={s.location_status === 'rejected'}
						>{s.location_status === 'approved' ? 'Approved' : 'Rejected'}</span
					>
					by {s.decided_by ?? 'plant manager'} on {s.decided_at}{s.location_note
						? `: "${s.location_note}"`
						: ''}
				</p>
			{/if}
		</div>
	</div>

	<div class="grid">
		<figure class="photo">
			<img src={s.photoUrl} alt="Shift start group" />
			<figcaption>{s.faces} {s.faces === 1 ? 'face' : 'faces'} in the photo</figcaption>
		</figure>

		<dl class="facts">
			<dt>Distance</dt>
			<dd>
				{s.location_distance_m !== null ? `${s.location_distance_m} m` : 'Not known'}
				<small>(allowed {data.radius} m)</small>
			</dd>
			<dt>Operator's phone</dt>
			<dd>
				{#if s.gps_lat !== null}
					<a href={mapUrl(s.gps_lat, s.gps_lng)} target="_blank" rel="noopener">Open in Maps</a>
				{:else}
					Location not shared
				{/if}
			</dd>
			<dt>Pump GPS</dt>
			<dd>
				{#if s.pump_gps_lat !== null}
					<a href={mapUrl(s.pump_gps_lat, s.pump_gps_lng)} target="_blank" rel="noopener"
						>Open in Maps</a
					>
					<small>reading from {s.pump_gps_time}</small>
				{:else}
					No GPS reading
				{/if}
			</dd>
			{#if bothUrl}
				<dt>Both</dt>
				<dd><a href={bothUrl} target="_blank" rel="noopener">Show route between them</a></dd>
			{/if}
		</dl>
	</div>

	{#if pending}
		<form
			class="decision"
			method="POST"
			use:enhance={() => {
				busy = true;
				return async ({ update }) => {
					await update({ reset: false });
					busy = false;
				};
			}}
		>
			<label class="field">
				<span>Note (needed to reject)</span>
				<textarea
					name="note"
					rows="3"
					maxlength="500"
					placeholder="e.g. Spoke to operator, pump moved to a new site"></textarea>
			</label>
			{#if form?.error}<p class="form-error" role="alert">{form.error}</p>{/if}
			<div class="decision-actions">
				<button class="button button--primary" formaction="?/approve" disabled={busy}
					>Approve attendance</button
				>
				<button class="button button--danger" formaction="?/reject" disabled={busy}>Reject</button>
			</div>
		</form>
	{/if}
</div>

<style>
	.approval-page {
		max-width: 60rem;
	}
	.back {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		margin-bottom: var(--space-3);
		color: var(--ink-muted);
		text-decoration: none;
	}
	.problem {
		display: flex;
		gap: var(--space-3);
		padding: var(--space-4);
		background: #fff8e6;
		border: 1px solid #f0d48a;
		border-radius: var(--radius-md);
	}
	.problem--done {
		background: var(--surface-muted);
		border-color: var(--brand-mist);
	}
	.problem p {
		margin: var(--space-1) 0 0;
	}
	.grid {
		display: grid;
		grid-template-columns: minmax(0, 1.4fr) minmax(16rem, 1fr);
		gap: var(--space-4);
		margin-top: var(--space-4);
	}
	.photo {
		margin: 0;
	}
	.photo img {
		width: 100%;
		max-height: 26rem;
		object-fit: contain;
		background: var(--surface-muted);
		border-radius: var(--radius-md);
	}
	.photo figcaption,
	.facts small {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.facts {
		display: grid;
		grid-template-columns: auto 1fr;
		gap: var(--space-2) var(--space-4);
		align-content: start;
		margin: 0;
	}
	.facts dt {
		color: var(--ink-muted);
	}
	.facts dd {
		margin: 0;
	}
	.decision {
		display: grid;
		gap: var(--space-3);
		margin-top: var(--space-5);
		padding: var(--space-4);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}
	.decision textarea {
		width: 100%;
	}
	.decision-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.form-error {
		margin: 0;
		color: #b42318;
	}
	@media (max-width: 48rem) {
		.grid {
			grid-template-columns: 1fr;
		}
		.decision-actions .button {
			flex: 1;
			justify-content: center;
			min-height: 3rem;
		}
	}
</style>
