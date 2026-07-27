<script lang="ts">
	let email = $state('');
	let password = $state('');
	let error = $state('');

	async function submit(e: Event) {
		e.preventDefault();
		error = '';
		const res = await fetch('/api/auth/login', {
			method: 'POST',
			headers: { 'content-type': 'application/json' },
			body: JSON.stringify({ email, password })
		});
		if (!res.ok) {
			const body = await res.json().catch(() => ({}));
			error = body.error || 'Login failed';
			return;
		}
		const data = await res.json();
		window.location.href = `/${data.role}`;
	}
</script>

<div class="login-wrap">
	<h1>Attendance System Login</h1>
	<form onsubmit={submit} data-testid="login-form">
		<label>
			Email
			<input type="email" bind:value={email} required data-testid="login-email" />
		</label>
		<label>
			Password
			<input type="password" bind:value={password} required data-testid="login-password" />
		</label>
		{#if error}
			<p class="error" data-testid="login-error">{error}</p>
		{/if}
		<button type="submit" data-testid="login-submit">Log in</button>
	</form>
</div>

<style>
	.login-wrap {
		max-width: 360px;
		margin: 4rem auto;
		font-family: sans-serif;
	}
	form {
		display: flex;
		flex-direction: column;
		gap: 0.75rem;
	}
	.error {
		color: #c0392b;
	}
	input {
		display: block;
		width: 100%;
		padding: 0.5rem;
		margin-top: 0.25rem;
	}
	button {
		padding: 0.6rem;
		background: #2563eb;
		color: white;
		border: none;
		border-radius: 4px;
		cursor: pointer;
	}
</style>
