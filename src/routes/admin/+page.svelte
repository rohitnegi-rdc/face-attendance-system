<script lang="ts">
	let { data } = $props();
</script>

<div class="wrap">
	<h1>Admin Dashboard</h1>
	<nav>
		<a href="/admin/insights">Insights</a>
		<a href="/admin/import">CSV Import</a>
		<a href="/admin/attendance">Attendance Table</a>
		<a href="/admin/fraud-flags">Fraud Flags</a>
		<a href="/admin/flagged-guests">Flagged Guests</a>
		<a href="/admin/merge-candidates">Merge Candidates</a>
	</nav>

	<div class="cards" data-testid="admin-metrics">
		<div class="card"><span>Today's Attendance %</span><strong>{data.metrics.attendancePct}%</strong></div>
		<div class="card"><span>Active Pumps Today</span><strong>{data.metrics.activePumps}</strong></div>
		<div class="card"><span>Total Distinct Persons</span><strong>{data.metrics.totalPersons}</strong></div>
		<div class="card"><span>Fraud Flags Today</span><strong>{data.metrics.fraudFlagsToday}</strong></div>
		<div class="card"><span>Pending Guest Reviews</span><strong>{data.metrics.pendingGuestReviews}</strong></div>
		<div class="card"><span>Avg Elapsed Hours</span><strong>{data.metrics.avgElapsedHours}</strong></div>
	</div>
</div>

<style>
	.wrap {
		max-width: 900px;
		margin: 2rem auto;
		font-family: sans-serif;
	}
	nav a {
		margin-right: 1rem;
	}
	.cards {
		display: grid;
		grid-template-columns: repeat(3, 1fr);
		gap: 1rem;
		margin-top: 1.5rem;
	}
	.card {
		border: 1px solid #ddd;
		border-radius: 6px;
		padding: 1rem;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
	}
	.card strong {
		font-size: 1.5rem;
	}
</style>
