<script lang="ts">
	// One gang, the same for the admin and the plant manager (loadGang in src/lib/server/gangs.ts):
	// its members by face, then day by day with the pump, headcount, start, end and how it ended.
	// A shift counted for the wrong gang is moved to another gang here.
	import { enhance } from '$app/forms';
	import { resolve } from '$app/paths';
	import BackLink from '$lib/components/BackLink.svelte';
	import EmptyState from '$lib/components/EmptyState.svelte';
	import StatusBadge from '$lib/components/StatusBadge.svelte';
	import { formatDate, formatTime } from '$lib/date';
	import { shiftOutcomeLabel } from '$lib/shiftLabels';
	import type { loadGang } from '$lib/server/gangs';

	type Data = Awaited<ReturnType<typeof loadGang>>;
	let {
		data,
		form,
		base
	}: {
		data: Data;
		form: { formKind?: string; success?: boolean; message?: string } | null;
		base: 'admin' | 'plant-manager';
	} = $props();

	const backHref = $derived(
		base === 'admin' ? resolve('/admin/gangs') : resolve('/plant-manager/gangs')
	);
	const faceSrc = (id: string) => resolve(`/api/attendance/face/${id}`);
	const title = $derived(`Gang ${data.gang.code}${data.gang.name ? ` (${data.gang.name})` : ''}`);
</script>

<svelte:head><title>{title} | Face Attendance</title></svelte:head>

<div class="page">
	<BackLink href={backHref} label="Gangs" />
	<header class="page-header">
		<div class="page-header__copy">
			<h1 data-testid="gang-title">{title}</h1>
			<p>
				{data.gang.area_name}. First seen at {data.gang.first_pump_code ?? 'a pump'} on {formatDate(
					data.gang.created_at
				)}. Members are the faces in its last five shifts.
			</p>
		</div>
	</header>

	{#if form?.message}
		<p class="alert" class:alert--error={!form.success} role="status">{form.message}</p>
	{/if}

	<dl class="tiles" data-testid="gang-summary">
		<div>
			<dt>Days counted</dt>
			<dd>{data.summary.days}</dd>
		</div>
		<div>
			<dt>Average headcount</dt>
			<dd data-testid="gang-average">{data.summary.average ?? '-'}</dd>
		</div>
		<div>
			<dt>Pumps worked at</dt>
			<dd>{data.summary.pumps}</dd>
		</div>
		<div>
			<dt>Members</dt>
			<dd>{data.members.length}</dd>
		</div>
	</dl>
	<p class="range-note">
		{formatDate(data.range.from)} to {formatDate(data.range.to)}. A day waiting for a location
		approval is not counted yet.
	</p>

	<section class="surface surface--padded" aria-labelledby="members-heading">
		<h2 id="members-heading">Members ({data.members.length})</h2>
		{#if data.members.length}
			<ul class="members">
				{#each data.members as member (member.worker)}
					<li data-testid="gang-member">
						{#if member.face_id}<img src={faceSrc(member.face_id)} alt="" loading="lazy" />{/if}
						<strong
							>{member.name ?? 'Worker'}{#if member.operator}<small class="operator-tag"
									>Operator</small
								>{/if}</strong
						>
						<span
							>{member.shifts}
							{member.shifts === 1 ? 'photo' : 'photos'}, last {formatDate(member.last_day)} at {member.pump_code}</span
						>
					</li>
				{/each}
			</ul>
		{:else}
			<p class="muted">No faces yet.</p>
		{/if}
	</section>

	<section class="days" aria-labelledby="days-heading">
		<div class="days-head">
			<h2 id="days-heading">Day by day</h2>
			<form method="GET" class="range-form">
				<label class="field"
					><span>From</span><input
						type="date"
						name="from"
						value={data.range.from}
						max={data.range.today}
					/></label
				>
				<label class="field"
					><span>To</span><input
						type="date"
						name="to"
						value={data.range.to}
						max={data.range.today}
					/></label
				>
				<button class="button button--secondary" type="submit">Show</button>
			</form>
		</div>
		{#if !data.shifts.length}
			<EmptyState
				title="No shifts in these days"
				description="Choose earlier days to see this gang's shifts."
			/>
		{:else}
			<ul class="shift-rows">
				{#each data.shifts as shift (shift.id)}
					<li
						class="shift-row"
						class:shift-row--held={shift.held}
						data-testid="gang-shift-row"
						data-day={shift.session_date}
					>
						<div class="when">
							<strong>{formatDate(shift.session_date)}</strong>
							<span class="muted">{shift.pump_code}, {shift.plant_name}</span>
						</div>
						<div class="count">
							<strong data-testid="gang-day-headcount">{shift.headcount}</strong>
							<span class="muted">counted that day</span>
							{#if shift.held}<StatusBadge tone="attention"
									>{shift.held === 'pending'
										? 'Start location: waiting for approval'
										: 'Start location rejected'}</StatusBadge
								>{/if}
						</div>
						<div class="times">
							<span>Start {formatTime(shift.started_at)}</span>
							<span>{shift.ended_at ? `End ${formatTime(shift.ended_at)}` : 'No end photo'}</span>
							<span class="muted" data-testid="gang-shift-end">{shiftOutcomeLabel(shift)}</span>
						</div>
						<form method="POST" action="?/move" class="move" use:enhance>
							<input type="hidden" name="shift" value={shift.id} />
							<label class="field"
								><span>Wrong gang? Move to</span><select name="gang" data-testid="move-gang">
									{#each data.otherGangs as other (other.id)}<option value={other.id}
											>Gang {other.code}{other.name ? ` (${other.name})` : ''}</option
										>{/each}
									<option value="new">A new gang</option>
								</select></label
							>
							<button class="button button--secondary" type="submit" data-testid="move-submit"
								>Move</button
							>
						</form>
					</li>
				{/each}
			</ul>
		{/if}
	</section>
</div>

<style>
	.tiles {
		display: grid;
		grid-template-columns: repeat(4, minmax(0, 1fr));
		gap: var(--space-3);
		margin: 0 0 var(--space-2);
	}
	.tiles div {
		padding: var(--space-3) var(--space-4);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.tiles dt {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.tiles dd {
		margin: 0;
		font-size: var(--text-2xl, 1.5rem);
		font-weight: 700;
		color: var(--ink-strong);
	}
	.range-note,
	.muted {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.range-note {
		margin: 0 0 var(--space-4);
	}
	.members {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(8rem, 1fr));
		gap: var(--space-3);
		margin: var(--space-3) 0 0;
		padding: 0;
		list-style: none;
	}
	.members li {
		display: grid;
		gap: 2px;
		font-size: var(--text-sm);
	}
	.operator-tag {
		margin-left: var(--space-1);
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 600;
	}
	.members img {
		width: 100%;
		aspect-ratio: 1;
		object-fit: cover;
		border-radius: var(--radius-md);
	}
	.members span {
		color: var(--ink-muted);
		font-size: var(--text-xs);
	}
	.days {
		margin-top: var(--space-5);
	}
	.days-head {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		justify-content: space-between;
		gap: var(--space-3);
		margin-bottom: var(--space-3);
	}
	.days-head h2 {
		margin: 0;
	}
	.range-form {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2);
	}
	.shift-rows {
		display: grid;
		gap: var(--space-2);
		margin: 0;
		padding: 0;
		list-style: none;
	}
	.shift-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 0.8fr) minmax(0, 1.4fr) minmax(0, 1.2fr);
		align-items: center;
		gap: var(--space-4);
		padding: var(--space-3) var(--space-4);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.shift-row--held {
		background: #fff7e0;
		border-color: #f0c96a;
	}
	.shift-row > div {
		display: grid;
		gap: 2px;
		min-width: 0;
	}
	.count strong {
		font-size: var(--text-xl);
		color: var(--ink-strong);
	}
	.move {
		display: flex;
		flex-wrap: wrap;
		align-items: end;
		gap: var(--space-2);
	}
	.move select {
		min-width: 8rem;
	}
	@media (max-width: 52rem) {
		.tiles {
			grid-template-columns: repeat(2, minmax(0, 1fr));
		}
		.shift-row {
			grid-template-columns: minmax(0, 1fr) auto;
			gap: var(--space-2) var(--space-3);
		}
		.times,
		.move {
			grid-column: 1 / -1;
		}
	}
</style>
