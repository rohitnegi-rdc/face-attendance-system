// Once a day, from 10 am IST, a pump phone that allowed notifications is reminded of a missed day
// from the last week it has not asked about yet (worker/missingDays.js). The pump screen then shows
// the three regularisation screens (src/lib/components/PumpRegularise.svelte). One push per pump
// per day, claimed in regularisation_push_log so two workers never both send it.
import { addDays, missingDays, todayInIndia } from './missingDays.js';
import { pushToPump } from './endReminders.js';

const LOOK_BACK_DAYS = 7;

function hourInIndia(now) {
	return new Date(now.getTime() + 330 * 60 * 1000).getUTCHours();
}

export async function sendRegularisationPushes(db, log, now = new Date()) {
	const fromHour = Number(process.env.REGULARISATION_PUSH_HOUR ?? 10);
	if (hourInIndia(now) < fromHour) return 0;
	const {
		rows: [keys]
	} = await db.query('SELECT public_key, private_key, subject FROM push_keys');
	if (!keys) return 0;
	const today = todayInIndia(now);
	const { rows: pumps } = await db.query(
		`SELECT DISTINCT p.pump_id FROM push_subscriptions p
		 WHERE NOT EXISTS (SELECT 1 FROM regularisation_push_log l
		                   WHERE l.pump_id = p.pump_id AND l.sent_on = $1)`,
		[today]
	);
	if (pumps.length === 0) return 0;
	const missed = await missingDays(
		db,
		pumps.map((p) => p.pump_id),
		{ today, from: addDays(today, -LOOK_BACK_DAYS) }
	);
	const byPump = new Map();
	for (const row of missed) byPump.set(row.pump_id, (byPump.get(row.pump_id) ?? 0) + 1);
	let sent = 0;
	for (const [pumpId, count] of byPump) {
		const { rowCount } = await db.query(
			`INSERT INTO regularisation_push_log (pump_id, sent_on) VALUES ($1, $2)
			 ON CONFLICT DO NOTHING`,
			[pumpId, today]
		);
		if (!rowCount) continue;
		const payload = JSON.stringify({
			title: 'छूटा हुआ दिन / Missed day',
			body:
				`${count} दिन की फोटो नहीं आई। ऐप खोलकर बताइए क्यों।\n` +
				`No photo came for ${count} ${count === 1 ? 'day' : 'days'}. Open the app and tell us why.`,
			tag: 'regularisation',
			url: 'pump'
		});
		const delivered = await pushToPump(db, log, keys, pumpId, payload, 'missed day reminder');
		log('info', { pumpId, days: count, delivered }, 'missed day reminder sent');
		sent++;
	}
	return sent;
}
