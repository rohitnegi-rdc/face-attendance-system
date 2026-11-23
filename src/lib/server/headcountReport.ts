// Pump headcount workbook: people per pump per day for one month, with month-to-date and
// financial-year-to-date averages. Each pump row opens (Excel outline +) into Old / New rows.
// Same scope contract as attendanceReport.ts, so admin and plant manager read the same numbers.
import ExcelJS from 'exceljs';
import { query } from '$lib/server/db';
import { addDaysStr, formatDate, formatDayLabel } from '$lib/date';
import { todayIST } from '$lib/server/time';
import { heldShiftStatus } from '$lib/server/locationCheck';
import type { ReportScope } from '$lib/server/attendanceReport';
import { foldGangDays, gangDaySql, type GangPumpDay } from '$lib/server/gangs';

const BRAND = 'FF0B6E69';
const BRAND_LIGHT = 'FFE6F2F1';
const MUTED = 'FF5B6B73';
const GRID = 'FFD5DEE2';
const thin = { style: 'thin' as const, color: { argb: GRID } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };
const HELD_FILL = { pending: 'FFFFE3A3', rejected: 'FFF8C4C4' };
const HELD_NOTE = {
	pending:
		'Shift start is waiting for the plant manager to approve its location. Not in totals or averages yet.',
	rejected:
		'The plant manager rejected the location of this shift start. Not in totals or averages.'
};
const fill = (argb: string): ExcelJS.Fill => ({
	type: 'pattern',
	pattern: 'solid',
	fgColor: { argb }
});

type DayRow = {
	pump_id: string;
	session_date: string;
	people: number;
	new_people: number;
	held: 'pending' | 'rejected' | null;
};
type Totals = { people: number; newPeople: number; days: number };

// month is YYYY-MM; anything else (or a future month) falls back to the current month.
export function headcountRange(month: string | null) {
	const today = todayIST();
	const current = today.slice(0, 7);
	const chosen =
		month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && month <= current ? month : current;
	const monthStart = `${chosen}-01`;
	const monthEnd = addDaysStr(addDaysStr(monthStart, 32).slice(0, 7) + '-01', -1);
	const to = monthEnd < today ? monthEnd : today;
	const [year, mon] = chosen.split('-').map(Number);
	// Indian financial year starts 1 April.
	const fyStart = `${mon >= 4 ? year : year - 1}-04-01`;
	return { month: chosen, monthStart, to, fyStart };
}

export async function buildHeadcountReport(scope: ReportScope, month: string | null) {
	const { month: chosen, monthStart, to, fyStart } = headcountRange(month);
	const n = scope.params.length;
	const params = [...scope.params, fyStart, to];
	const FROM = `$${n + 1}`;
	const TO = `$${n + 2}`;
	const scopeCte = `scope AS (
		SELECT pu.id, pu.pump_code, v.name AS vendor_name, pl.name AS plant_name
		FROM pumps pu JOIN vendors v ON v.id = pu.vendor_id
		JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		WHERE ${scope.where}
	)`;

	const pumps = await query<{
		id: string;
		pump_code: string;
		vendor_name: string;
		plant_name: string;
	}>(`WITH ${scopeCte} SELECT * FROM scope ORDER BY plant_name, pump_code`, scope.params);

	// A day counts when the pump sent a processed photo. People = workers matched in the start or
	// end photo; New = that day is the worker's first ever matched day at the pump. A day whose
	// shift start waits for location approval (or was rejected) keeps its count but is marked
	// `held` and left out of totals and averages, so the sheet shows what the screen grid shows.
	const rows = await query<DayRow>(
		`WITH ${scopeCte},
		photo_days AS (
			SELECT s.pump_id, s.session_date FROM attendance_sessions s JOIN scope ON scope.id = s.pump_id
			WHERE s.session_date BETWEEN ${FROM} AND ${TO} AND s.status IN ('review', 'completed')
			GROUP BY 1, 2
		),
		firsts AS (
			SELECT d.person_id, min(d.session_date) AS first_day FROM daily_person_attendance d
			JOIN scope ON scope.id = d.pump_id
			WHERE d.morning_matched OR d.evening_matched GROUP BY 1
		),
		present AS (
			SELECT d.pump_id, d.session_date, count(*)::int AS people,
			       count(*) FILTER (WHERE f.first_day = d.session_date)::int AS new_people
			FROM daily_person_attendance d
			JOIN scope ON scope.id = d.pump_id
			JOIN persons p ON p.id = d.person_id AND p.status <> 'merged'
			JOIN firsts f ON f.person_id = d.person_id
			WHERE d.session_date BETWEEN ${FROM} AND ${TO} AND (d.morning_matched OR d.evening_matched)
			  AND NOT EXISTS (
			    SELECT 1 FROM attendance_duplicate_resolutions r
			    WHERE r.duplicate_person_id = d.person_id AND r.session_date = d.session_date
			      AND r.reversed_at IS NULL
			  )
			GROUP BY 1, 2
		),
		pump_days AS (
			SELECT coalesce(pd.pump_id, pr.pump_id) AS pump_id,
			       coalesce(pd.session_date, pr.session_date) AS session_date,
			       coalesce(pr.people, 0) AS people, coalesce(pr.new_people, 0) AS new_people
			FROM photo_days pd FULL JOIN present pr
			  ON pr.pump_id = pd.pump_id AND pr.session_date = pd.session_date
		)
		SELECT day.pump_id, day.session_date::text AS session_date, day.people, day.new_people,
		       ${heldShiftStatus('day.pump_id', 'day.session_date')} AS held
		FROM pump_days day`,
		params
	);

	const days: string[] = [];
	for (let d = monthStart; d <= to; d = addDaysStr(d, 1)) days.push(d);
	const byPump = new Map<string, Map<string, DayRow>>();
	for (const row of rows) {
		if (!byPump.has(row.pump_id)) byPump.set(row.pump_id, new Map());
		byPump.get(row.pump_id)!.set(row.session_date, row);
	}
	const totals = (map: Map<string, DayRow> | undefined, from: string): Totals => {
		const t = { people: 0, newPeople: 0, days: 0 };
		for (const row of map?.values() ?? []) {
			if (row.held || row.session_date < from || row.session_date > to) continue;
			t.people += row.people;
			t.newPeople += row.new_people;
			t.days += 1;
		}
		return t;
	};
	const avg = (sum: number, count: number) => (count ? Math.round((sum / count) * 10) / 10 : null);

	const workbook = new ExcelJS.Workbook();
	workbook.creator = 'Face Attendance';
	const sheet = workbook.addWorksheet('Headcount', {
		properties: { outlineProperties: { summaryBelow: false, summaryRight: false } },
		views: [{ state: 'frozen', xSplit: 3, ySplit: 5 }]
	});
	const fixedCols = ['Pump No', 'Plant', 'Vendor'];
	const lastCol = fixedCols.length + days.length + 2;
	const monthLabel = `${formatDate(monthStart)} to ${formatDate(to)}`;

	sheet.getCell('A1').value = `Pump headcount, ${monthLabel}`;
	sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: BRAND } };
	sheet.getCell('A2').value =
		`${scope.description}. Data up to ${formatDate(to)}. Financial year from ${formatDate(fyStart)}.`;
	sheet.getCell('A2').font = { color: { argb: MUTED } };
	sheet.getCell('A3').value =
		'Number = people matched in the start or end photo that day. "-" = no photo sent. ' +
		'Click + on the left of a pump to see Old (seen before) and New (first day at this pump). ' +
		'Averages count only days with a photo. Amber = shift start waiting for location approval, ' +
		'red = location rejected (hover for the note): the number is shown, but the day is left out ' +
		'of totals and averages until the plant manager approves it.';
	sheet.getCell('A3').font = { italic: true, color: { argb: MUTED } };

	const header = sheet.getRow(5);
	const headers = [
		...fixedCols,
		...days.map((d) => `${formatDayLabel(d).weekday}\n${Number(d.slice(8))}`),
		'Avg MTD',
		'Avg YTD'
	];
	headers.forEach((text, i) => {
		const cell = header.getCell(i + 1);
		cell.value = text;
		cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
		cell.fill = fill(BRAND);
		cell.border = BORDER;
		cell.alignment = { wrapText: true, vertical: 'middle', horizontal: i < 3 ? 'left' : 'center' };
	});
	header.height = 32;
	sheet.getColumn(1).width = 18;
	sheet.getColumn(2).width = 16;
	sheet.getColumn(3).width = 28;
	for (let c = 4; c <= lastCol; c++) sheet.getColumn(c).width = c > lastCol - 2 ? 10 : 5.5;

	let r = 6;
	const writeRow = (
		values: (string | number | null)[],
		style: { bold?: boolean; tint?: string; muted?: boolean; level?: number; groupHead?: boolean },
		held: (DayRow['held'] | undefined)[] = []
	) => {
		const row = sheet.getRow(r++);
		values.forEach((value, i) => {
			const cell = row.getCell(i + 1);
			cell.value = value ?? '-';
			cell.border = BORDER;
			cell.alignment = { vertical: 'middle', horizontal: i < 3 ? 'left' : 'center' };
			cell.font = { bold: style.bold, color: style.muted ? { argb: MUTED } : undefined };
			if (style.tint) cell.fill = fill(style.tint);
			const dayHeld = i >= 3 ? held[i - 3] : null;
			if (dayHeld) {
				cell.fill = fill(HELD_FILL[dayHeld]);
				if (style.groupHead) cell.note = HELD_NOTE[dayHeld];
			}
			if (i >= lastCol - 2 && typeof value === 'number') cell.numFmt = '0.0';
		});
		// Excel's + button needs collapsed="1" on the pump row above the hidden group, not on the
		// hidden rows; exceljs only derives it (wrongly) from outlineLevel, so set it per row.
		if (style.level) {
			row.outlineLevel = style.level;
			row.hidden = true;
		}
		if (style.level || style.groupHead) {
			Object.defineProperty(row, 'collapsed', { get: () => Boolean(style.groupHead) });
		}
	};

	const dayTotals = new Map<string, { people: number; newPeople: number }>();
	for (const pump of pumps) {
		const map = byPump.get(pump.id);
		const mtd = totals(map, monthStart);
		const ytd = totals(map, fyStart);
		const cells = (pick: (row: DayRow) => number) =>
			days.map((d) => (map?.has(d) ? pick(map.get(d)!) : null));
		const held = days.map((d) => map?.get(d)?.held);
		for (const d of days) {
			const row = map?.get(d);
			if (!row || row.held) continue;
			const t = dayTotals.get(d) ?? { people: 0, newPeople: 0 };
			t.people += row.people;
			t.newPeople += row.new_people;
			dayTotals.set(d, t);
		}
		writeRow(
			[
				pump.pump_code,
				pump.plant_name,
				pump.vendor_name,
				...cells((row) => row.people),
				avg(mtd.people, mtd.days),
				avg(ytd.people, ytd.days)
			],
			{ bold: true, groupHead: true },
			held
		);
		writeRow(
			[
				'   Old (seen before)',
				'',
				'',
				...cells((row) => row.people - row.new_people),
				avg(mtd.people - mtd.newPeople, mtd.days),
				avg(ytd.people - ytd.newPeople, ytd.days)
			],
			{ muted: true, level: 1 },
			held
		);
		writeRow(
			[
				'   New (first day)',
				'',
				'',
				...cells((row) => row.new_people),
				avg(mtd.newPeople, mtd.days),
				avg(ytd.newPeople, ytd.days)
			],
			{ muted: true, level: 1, tint: 'FFFFF6DD' },
			held
		);
	}

	// Totals across pumps: Avg = people per pump-day with a photo.
	const all = { mtd: { people: 0, days: 0 }, ytd: { people: 0, days: 0 } };
	for (const map of byPump.values()) {
		const mtd = totals(map, monthStart);
		const ytd = totals(map, fyStart);
		all.mtd.people += mtd.people;
		all.mtd.days += mtd.days;
		all.ytd.people += ytd.people;
		all.ytd.days += ytd.days;
	}
	writeRow(
		[
			'All pumps (total)',
			'',
			`${pumps.length} pumps`,
			...days.map((d) => dayTotals.get(d)?.people ?? null),
			avg(all.mtd.people, all.mtd.days),
			avg(all.ytd.people, all.ytd.days)
		],
		{ bold: true, tint: BRAND_LIGHT }
	);
	writeRow(
		[
			'   New that day',
			'',
			'',
			...days.map((d) => dayTotals.get(d)?.newPeople ?? null),
			null,
			null
		],
		{ muted: true, tint: BRAND_LIGHT }
	);

	// No fitToPage here: exceljs writes it before outlinePr, which Excel refuses to open.
	sheet.pageSetup = { orientation: 'landscape', printTitlesRow: '5:5' };
	sheet.properties.outlineLevelRow = 1;

	await addGangsSheet(workbook, {
		scope,
		days,
		monthStart,
		to,
		fyStart,
		monthLabel,
		pumpRows: rows,
		pumpCodes: new Map(pumps.map((pump) => [pump.id, pump.pump_code]))
	});

	const buffer = await workbook.xlsx.writeBuffer();
	return { buffer, filename: `pump-headcount-${chosen}.xlsx` };
}

// The Gangs sheet (pump gangs, migration 056): one row per gang by Area and plant, its headcount
// per day (each worker once a day, wherever the gang worked), Avg MTD / Avg YTD with the pump
// sheet's formula, and a + under each gang for the pumps it worked at. Only gangs of Areas with
// gangs on; no sheet when there are none. The total rows set the gang total beside the pump
// sheet's total for the same pumps, so a worker seen at two pumps that day shows as the gap.
async function addGangsSheet(
	workbook: ExcelJS.Workbook,
	ctx: {
		scope: ReportScope;
		days: string[];
		monthStart: string;
		to: string;
		fyStart: string;
		monthLabel: string;
		pumpRows: DayRow[];
		pumpCodes: Map<string, string>;
	}
) {
	const { scope, days, monthStart, to, fyStart } = ctx;
	const n = scope.params.length;
	const rows = await query<GangPumpDay>(gangDaySql(scope.where, n + 1), [
		...scope.params,
		fyStart,
		to
	]);
	if (!rows.length) return;
	const byGang = foldGangDays(rows);
	const gangs = await query<{
		id: string;
		code: number;
		name: string | null;
		area_name: string;
		plant_name: string | null;
	}>(
		`SELECT g.id, g.code, g.name, a.name AS area_name,
		        (SELECT pl.name FROM attendance_sessions s JOIN pumps pu ON pu.id = s.pump_id
		           JOIN plants pl ON pl.id = pu.plant_id
		         WHERE s.gang_id = g.id AND s.session_date <= $2
		         ORDER BY s.session_date DESC, s.submitted_at DESC LIMIT 1) AS plant_name
		 FROM gangs g JOIN areas a ON a.id = g.area_id WHERE g.id = ANY($1::uuid[])
		 ORDER BY a.name, 5 NULLS LAST, g.code`,
		[[...byGang.keys()], to]
	);
	const pumpIds = new Set(rows.map((row) => row.pump_id));
	const extraPumps = [...pumpIds].filter((id) => !ctx.pumpCodes.has(id));
	if (extraPumps.length)
		for (const pump of await query<{ id: string; pump_code: string }>(
			'SELECT id, pump_code FROM pumps WHERE id = ANY($1::uuid[])',
			[extraPumps]
		))
			ctx.pumpCodes.set(pump.id, pump.pump_code);

	const sheet = workbook.addWorksheet('Gangs', {
		properties: { outlineProperties: { summaryBelow: false, summaryRight: false } },
		views: [{ state: 'frozen', xSplit: 3, ySplit: 5 }]
	});
	const fixedCols = ['Gang', 'Area', 'Plant'];
	const lastCol = fixedCols.length + days.length + 2;
	sheet.getCell('A1').value = `Gang headcount, ${ctx.monthLabel}`;
	sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: BRAND } };
	sheet.getCell('A2').value =
		`${scope.description}. Data up to ${formatDate(to)}. Financial year from ${formatDate(fyStart)}.`;
	sheet.getCell('A2').font = { color: { argb: MUTED } };
	sheet.getCell('A3').value =
		'A gang is recognised from faces. Number = workers of the gang counted that day, each once, ' +
		'even when the gang worked at two pumps. "-" = the gang had no shift. Click + on the left of ' +
		'a gang to see the pumps it worked at. Plant = where it last worked. Averages count only days ' +
		'with a shift. Amber = waiting for location approval, red = location rejected: shown, but ' +
		'left out of totals and averages.';
	sheet.getCell('A3').font = { italic: true, color: { argb: MUTED } };
	const header = sheet.getRow(5);
	[
		...fixedCols,
		...days.map((d) => `${formatDayLabel(d).weekday}\n${Number(d.slice(8))}`),
		'Avg MTD',
		'Avg YTD'
	].forEach((text, i) => {
		const cell = header.getCell(i + 1);
		cell.value = text;
		cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
		cell.fill = fill(BRAND);
		cell.border = BORDER;
		cell.alignment = { wrapText: true, vertical: 'middle', horizontal: i < 3 ? 'left' : 'center' };
	});
	header.height = 32;
	sheet.getColumn(1).width = 18;
	sheet.getColumn(2).width = 16;
	sheet.getColumn(3).width = 22;
	for (let c = 4; c <= lastCol; c++) sheet.getColumn(c).width = c > lastCol - 2 ? 10 : 5.5;

	let r = 6;
	const write = (
		values: (string | number | null)[],
		style: { bold?: boolean; tint?: string; muted?: boolean; level?: number; groupHead?: boolean },
		held: (DayRow['held'] | undefined)[] = [],
		note?: string
	) => {
		const row = sheet.getRow(r++);
		values.forEach((value, i) => {
			const cell = row.getCell(i + 1);
			cell.value = value ?? '-';
			cell.border = BORDER;
			cell.alignment = { vertical: 'middle', horizontal: i < 3 ? 'left' : 'center' };
			cell.font = { bold: style.bold, color: style.muted ? { argb: MUTED } : undefined };
			if (style.tint) cell.fill = fill(style.tint);
			const dayHeld = i >= 3 ? held[i - 3] : null;
			if (dayHeld) {
				cell.fill = fill(HELD_FILL[dayHeld]);
				if (style.groupHead) cell.note = HELD_NOTE[dayHeld];
			}
			if (i >= lastCol - 2 && typeof value === 'number') cell.numFmt = '0.0';
		});
		if (note) row.getCell(1).note = note;
		if (style.level) {
			row.outlineLevel = style.level;
			row.hidden = true;
		}
		if (style.level || style.groupHead) {
			Object.defineProperty(row, 'collapsed', { get: () => Boolean(style.groupHead) });
		}
	};
	const avg = (sum: number, count: number) => (count ? Math.round((sum / count) * 10) / 10 : null);
	const span = (from: string) => (day: { session_date: string; held: unknown }) =>
		!day.held && day.session_date >= from && day.session_date <= to;

	// The day's workers across every gang, once each (a worker counted for two gangs is one).
	const dayWorkers = new Map<string, Set<string>>();
	for (const gang of gangs) {
		const map = byGang.get(gang.id)!;
		const list = [...map.values()];
		const mtd = list.filter(span(monthStart));
		const ytd = list.filter(span(fyStart));
		const sum = (picked: typeof list) => picked.reduce((t, day) => t + day.people, 0);
		for (const day of mtd) {
			const set = dayWorkers.get(day.session_date) ?? new Set<string>();
			for (const worker of day.workers) set.add(worker);
			dayWorkers.set(day.session_date, set);
		}
		write(
			[
				gang.name ? `Gang ${gang.code} (${gang.name})` : `Gang ${gang.code}`,
				gang.area_name,
				gang.plant_name ?? '',
				...days.map((d) => map.get(d)?.people ?? null),
				avg(sum(mtd), mtd.length),
				avg(sum(ytd), ytd.length)
			],
			{ bold: true, groupHead: true },
			days.map((d) => map.get(d)?.held)
		);
		const gangPumps = [...new Set(list.flatMap((day) => day.pumps.map((p) => p.pump_id)))].sort(
			(a, b) => (ctx.pumpCodes.get(a) ?? '').localeCompare(ctx.pumpCodes.get(b) ?? '')
		);
		for (const pumpId of gangPumps) {
			const at = (d: string) => map.get(d)?.pumps.find((p) => p.pump_id === pumpId);
			const pumpDays = list
				.map((day) => ({ day, pump: day.pumps.find((p) => p.pump_id === pumpId) }))
				.filter((x) => x.pump);
			const pick = (from: string) =>
				pumpDays.filter(
					(x) => !x.pump!.held && x.day.session_date >= from && x.day.session_date <= to
				);
			const pm = pick(monthStart);
			const py = pick(fyStart);
			write(
				[
					`   at ${ctx.pumpCodes.get(pumpId) ?? 'a pump'}`,
					'',
					'',
					...days.map((d) => at(d)?.people ?? null),
					avg(
						pm.reduce((t, x) => t + x.pump!.people, 0),
						pm.length
					),
					avg(
						py.reduce((t, x) => t + x.pump!.people, 0),
						py.length
					)
				],
				{ muted: true, level: 1 },
				days.map((d) => at(d)?.held)
			);
		}
	}

	// The pump sheet's numbers for the same pumps and days, to reconcile the two sheets.
	const pumpTotal = new Map<string, number>();
	for (const row of ctx.pumpRows) {
		if (row.held || !pumpIds.has(row.pump_id) || row.session_date < monthStart) continue;
		pumpTotal.set(row.session_date, (pumpTotal.get(row.session_date) ?? 0) + row.people);
	}
	write(
		[
			'All gangs (each worker once a day)',
			'',
			`${gangs.length} gangs`,
			...days.map((d) => dayWorkers.get(d)?.size ?? null),
			null,
			null
		],
		{ bold: true, tint: BRAND_LIGHT }
	);
	write(
		['   Pump sheet, same pumps', '', '', ...days.map((d) => pumpTotal.get(d) ?? null), null, null],
		{ muted: true, tint: BRAND_LIGHT }
	);
	write(
		[
			'   Difference',
			'',
			'',
			...days.map((d) =>
				pumpTotal.has(d) || dayWorkers.has(d)
					? (pumpTotal.get(d) ?? 0) - (dayWorkers.get(d)?.size ?? 0)
					: null
			),
			null,
			null
		],
		{ muted: true, tint: BRAND_LIGHT },
		[],
		'The pump sheet counts a worker at each pump they were seen at; here a worker counts once a ' +
			'day. A difference is a worker seen at two pumps that day, or a shift with no faces, ' +
			'which has no gang.'
	);
	sheet.pageSetup = { orientation: 'landscape', printTitlesRow: '5:5' };
	sheet.properties.outlineLevelRow = 1;
}
