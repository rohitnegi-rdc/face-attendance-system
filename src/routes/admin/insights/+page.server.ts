import type { PageServerLoad } from './$types';
import { query } from '$lib/server/db';
import { todayStr, addDaysStr, dateKey } from '$lib/date';

const ATTENTION_SILENCE_HOURS = Number(process.env.EVENING_PAIRING_WINDOW_HOURS ?? 24) + 6; // 30h default

function pct(present: number, total: number): number {
	return total > 0 ? Math.round((present / total) * 1000) / 10 : 0;
}

export const load: PageServerLoad = async () => {
	const today = todayStr();
	const yesterday = addDaysStr(today, -1);
	const last7From = addDaysStr(today, -6);
	const prior7From = addDaysStr(today, -13);
	const prior7To = addDaysStr(today, -7);
	const last30From = addDaysStr(today, -29);

	// ---------- Trend deltas ----------
	const [todayAgg] = await query<any>(
		`SELECT COUNT(*) FILTER (WHERE morning_matched AND evening_matched) AS present, COUNT(*) AS total,
		        COUNT(DISTINCT pump_id) AS active_pumps
		 FROM daily_person_attendance WHERE session_date = $1`,
		[today]
	);
	const [yesterdayAgg] = await query<any>(
		`SELECT COUNT(*) FILTER (WHERE morning_matched AND evening_matched) AS present, COUNT(*) AS total,
		        COUNT(DISTINCT pump_id) AS active_pumps
		 FROM daily_person_attendance WHERE session_date = $1`,
		[yesterday]
	);
	const [last7Agg] = await query<any>(
		`SELECT COUNT(*) FILTER (WHERE morning_matched AND evening_matched) AS present, COUNT(*) AS total
		 FROM daily_person_attendance WHERE session_date >= $1 AND session_date <= $2`,
		[last7From, today]
	);
	const [fraudToday] = await query<any>(
		`SELECT COUNT(*) AS c FROM fraud_flags WHERE created_at::date = $1`,
		[today]
	);
	const [fraudYesterday] = await query<any>(
		`SELECT COUNT(*) AS c FROM fraud_flags WHERE created_at::date = $1`,
		[yesterday]
	);

	const todayPct = pct(Number(todayAgg?.present ?? 0), Number(todayAgg?.total ?? 0));
	const yesterdayPct = pct(Number(yesterdayAgg?.present ?? 0), Number(yesterdayAgg?.total ?? 0));
	const last7Pct = pct(Number(last7Agg?.present ?? 0), Number(last7Agg?.total ?? 0));

	const trends = {
		attendancePct: {
			value: todayPct,
			vsYesterday: Math.round((todayPct - yesterdayPct) * 10) / 10,
			vs7dAvg: Math.round((todayPct - last7Pct) * 10) / 10
		},
		fraudFlags: {
			value: Number(fraudToday?.c ?? 0),
			vsYesterday: Number(fraudToday?.c ?? 0) - Number(fraudYesterday?.c ?? 0)
		},
		activePumps: {
			value: Number(todayAgg?.active_pumps ?? 0),
			vsYesterday: Number(todayAgg?.active_pumps ?? 0) - Number(yesterdayAgg?.active_pumps ?? 0)
		}
	};

	// ---------- Pumps needing attention ----------
	const silentPumps = await query<any>(
		`SELECT pu.id, pu.pump_code, MAX(s.submitted_at) AS last_submitted_at
		 FROM pumps pu
		 LEFT JOIN attendance_sessions s ON s.pump_id = pu.id
		 GROUP BY pu.id, pu.pump_code
		 HAVING MAX(s.submitted_at) IS NULL OR MAX(s.submitted_at) < now() - ($1 || ' hours')::interval`,
		[ATTENTION_SILENCE_HOURS]
	);

	const expiredPumps = await query<any>(
		`SELECT DISTINCT pu.id, pu.pump_code
		 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
		 WHERE s.session_type = 'morning' AND s.pairing_status = 'expired'
		   AND s.submitted_at > now() - interval '7 days'`
	);

	const pumpTrend = await query<any>(
		`SELECT pu.id, pu.pump_code,
		   COUNT(*) FILTER (WHERE dpa.session_date >= $2 AND dpa.morning_matched AND dpa.evening_matched) AS last7_present,
		   COUNT(*) FILTER (WHERE dpa.session_date >= $2) AS last7_total,
		   COUNT(*) FILTER (WHERE dpa.session_date >= $3 AND dpa.session_date <= $4 AND dpa.morning_matched AND dpa.evening_matched) AS prior7_present,
		   COUNT(*) FILTER (WHERE dpa.session_date >= $3 AND dpa.session_date <= $4) AS prior7_total
		 FROM pumps pu
		 LEFT JOIN daily_person_attendance dpa ON dpa.pump_id = pu.id AND dpa.session_date >= $3 AND dpa.session_date <= $1
		 GROUP BY pu.id, pu.pump_code`,
		[today, last7From, prior7From, prior7To]
	);
	const droppedPumps = pumpTrend
		.map((p: any) => {
			const last7Pct = pct(Number(p.last7_present), Number(p.last7_total));
			const prior7Pct = pct(Number(p.prior7_present), Number(p.prior7_total));
			return { id: p.id, pump_code: p.pump_code, last7Pct, prior7Pct, drop: prior7Pct - last7Pct };
		})
		.filter((p: any) => p.prior7Pct > 0 && p.drop > 15);

	const attentionMap = new Map<string, any>();
	for (const p of silentPumps) {
		attentionMap.set(p.id, {
			id: p.id,
			pump_code: p.pump_code,
			reasons: [
				p.last_submitted_at
					? `no submission since ${dateKey(p.last_submitted_at)}`
					: 'never submitted'
			]
		});
	}
	for (const p of expiredPumps) {
		const existing = attentionMap.get(p.id) || { id: p.id, pump_code: p.pump_code, reasons: [] };
		existing.reasons.push('morning session expired unpaired in last 7 days');
		attentionMap.set(p.id, existing);
	}
	for (const p of droppedPumps) {
		const existing = attentionMap.get(p.id) || { id: p.id, pump_code: p.pump_code, reasons: [] };
		existing.reasons.push(
			`7-day attendance dropped ${p.drop.toFixed(1)}pp (${p.prior7Pct}% → ${p.last7Pct}%)`
		);
		attentionMap.set(p.id, existing);
	}
	const pumpsNeedingAttention = [...attentionMap.values()];

	// ---------- Vendor / Area rollups, ranked by furthest below 30-day baseline ----------
	async function rollup(groupCol: 'vendor_id' | 'area_id', nameTable: string, nameCol = 'name') {
		const joinArea =
			groupCol === 'area_id'
				? 'JOIN plants pl ON pl.id = pu.plant_id JOIN areas g ON g.id = pl.area_id'
				: 'JOIN vendors g ON g.id = pu.vendor_id';
		const rows = await query<any>(
			`SELECT g.id, g.${nameCol} AS name,
			   COUNT(DISTINCT pu.id) AS pump_count,
			   COUNT(DISTINCT dpa.person_id) FILTER (WHERE dpa.session_date >= $2) AS distinct_persons,
			   COUNT(*) FILTER (WHERE dpa.session_date = $1 AND dpa.morning_matched AND dpa.evening_matched) AS today_present,
			   COUNT(*) FILTER (WHERE dpa.session_date = $1) AS today_total,
			   COUNT(*) FILTER (WHERE dpa.session_date >= $2 AND dpa.morning_matched AND dpa.evening_matched) AS baseline_present,
			   COUNT(*) FILTER (WHERE dpa.session_date >= $2) AS baseline_total
			 FROM pumps pu
			 ${joinArea}
			 LEFT JOIN daily_person_attendance dpa ON dpa.pump_id = pu.id
			 GROUP BY g.id, g.${nameCol}`,
			[today, last30From]
		);
		return rows.map((r: any) => {
			const todayPct = pct(Number(r.today_present), Number(r.today_total));
			const baselinePct = pct(Number(r.baseline_present), Number(r.baseline_total));
			return {
				id: r.id,
				name: r.name,
				pumpCount: Number(r.pump_count),
				distinctPersons: Number(r.distinct_persons),
				todayPct,
				baselinePct,
				delta: Math.round((todayPct - baselinePct) * 10) / 10,
				presentToday: Number(r.today_present),
				absentToday: Number(r.today_total) - Number(r.today_present)
			};
		});
	}

	const vendorRollup = await rollup('vendor_id', 'vendors');
	const areaRollup = await rollup('area_id', 'areas');

	function median(nums: number[]): number {
		if (!nums.length) return 0;
		const s = [...nums].sort((a, b) => a - b);
		const mid = Math.floor(s.length / 2);
		return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
	}
	const areaMedians = new Map<string, number>();
	// Vendors don't carry a direct area_id column universally (Area-split accounts do), so
	// benchmark each vendor against the overall area median it's rendered alongside in the UI.
	const overallAreaMedian = median(areaRollup.map((a: any) => a.todayPct));
	for (const v of vendorRollup) areaMedians.set(v.id, overallAreaMedian);

	vendorRollup.sort((a: any, b: any) => a.delta - b.delta);
	areaRollup.sort((a: any, b: any) => a.delta - b.delta);

	// fraud rate per vendor (last 30 days)
	const fraudByVendor = await query<any>(
		`SELECT pu.vendor_id, COUNT(*) AS fraud_count
		 FROM fraud_flags ff JOIN attendance_sessions s ON s.id = ff.session_id JOIN pumps pu ON pu.id = s.pump_id
		 WHERE ff.created_at >= $1 GROUP BY pu.vendor_id`,
		[last30From]
	);
	const sessionsByVendor = await query<any>(
		`SELECT pu.vendor_id, COUNT(*) AS session_count
		 FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
		 WHERE s.status = 'completed' AND s.submitted_at >= $1 GROUP BY pu.vendor_id`,
		[last30From]
	);
	const fraudMap = new Map(fraudByVendor.map((r: any) => [r.vendor_id, Number(r.fraud_count)]));
	const sessionsMap = new Map(
		sessionsByVendor.map((r: any) => [r.vendor_id, Number(r.session_count)])
	);
	const vendorRollupWithFraud = vendorRollup.map((v: any) => {
		const fraudCount = fraudMap.get(v.id) ?? 0;
		const sessions = sessionsMap.get(v.id) ?? 0;
		return {
			...v,
			fraudRate: sessions > 0 ? Math.round((fraudCount / sessions) * 1000) / 10 : 0,
			areaMedianPct: areaMedians.get(v.id) ?? 0
		};
	});

	// ---------- 7-day sparklines per area/vendor ----------
	const last7Days = Array.from({ length: 7 }, (_, i) => addDaysStr(today, -6 + i));
	async function sparklineSeries(groupCol: 'vendor_id' | 'area_id') {
		const joinArea =
			groupCol === 'area_id'
				? 'JOIN plants pl ON pl.id = pu.plant_id JOIN areas g ON g.id = pl.area_id'
				: 'JOIN vendors g ON g.id = pu.vendor_id';
		const rows = await query<any>(
			`SELECT g.id, dpa.session_date,
			   COUNT(*) FILTER (WHERE dpa.morning_matched AND dpa.evening_matched) AS present, COUNT(*) AS total
			 FROM daily_person_attendance dpa
			 JOIN pumps pu ON pu.id = dpa.pump_id
			 ${joinArea}
			 WHERE dpa.session_date >= $1
			 GROUP BY g.id, dpa.session_date`,
			[last7From]
		);
		const byGroup = new Map<string, Record<string, { present: number; total: number }>>();
		for (const r of rows) {
			const sessionDate = dateKey(r.session_date);
			if (!byGroup.has(r.id)) byGroup.set(r.id, {});
			byGroup.get(r.id)![sessionDate] = { present: Number(r.present), total: Number(r.total) };
		}
		const result: Record<string, number[]> = {};
		for (const [id, dayMap] of byGroup) {
			result[id] = last7Days.map((d) => (dayMap[d] ? pct(dayMap[d].present, dayMap[d].total) : 0));
		}
		return result;
	}
	const vendorSparklines = await sparklineSeries('vendor_id');
	const areaSparklines = await sparklineSeries('area_id');

	// ---------- Data-quality backlog trend ----------
	const [backlogNow] = await query<any>(
		`SELECT
		   (SELECT COUNT(*) FROM flagged_guests WHERE reviewed = false) AS pending_guests,
		   (SELECT COUNT(*) FROM persons WHERE status = 'active') AS active_persons`
	);
	// Approximate merge-candidate backlog as a same-day proxy (computed on-the-fly elsewhere);
	// track flagged-guest backlog day-by-day over the last 7 days as the trend signal.
	const guestBacklogTrend = await query<any>(
		`SELECT created_at::date AS day, COUNT(*) AS c FROM flagged_guests
		 WHERE created_at::date >= $1 AND reviewed = false GROUP BY created_at::date`,
		[last7From]
	);
	const guestBacklogMap = new Map(guestBacklogTrend.map((r: any) => [dateKey(r.day), Number(r.c)]));
	const guestBacklogSeries = last7Days.map((d) => guestBacklogMap.get(d) ?? 0);

	return {
		trends,
		pumpsNeedingAttention,
		vendorRollup: vendorRollupWithFraud,
		areaRollup,
		vendorSparklines,
		areaSparklines,
		last7Days,
		guestBacklogSeries,
		pendingGuestCount: Number(backlogNow?.pending_guests ?? 0)
	};
};
