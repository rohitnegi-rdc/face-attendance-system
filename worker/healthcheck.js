import pg from 'pg';

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
try {
	const result = await pool.query(
		`SELECT 1 FROM worker_heartbeats
		 WHERE worker_id = $1
		   AND last_seen_at > now() - make_interval(secs => $2::double precision)`,
		[process.env.HOSTNAME, Number(process.env.WORKER_HEARTBEAT_TIMEOUT_SECONDS ?? 20)]
	);
	process.exitCode = result.rowCount ? 0 : 1;
} catch {
	process.exitCode = 1;
} finally {
	await pool.end();
}
