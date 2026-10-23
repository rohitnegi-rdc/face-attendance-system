// Pump headcount workbook: people per pump per day for one month, with month-to-date and
// financial-year-to-date averages. Each pump row opens (Excel outline +) into Old / New rows.
// Same scope contract as attendanceReport.ts, so admin and plant manager read the same numbers.
import ExcelJS from 'exceljs';
import { query } from '$lib/server/db';
import { addDaysStr, formatDayLabel } from '$lib/date';
import { todayIST } from '$lib/server/time';
import { heldShiftStatus } from '$lib/server/locationCheck';
import type { ReportScope } from '$lib/server/attendanceReport';

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
	const monthLabel = new Date(`${monthStart}T00:00:00Z`).toLocaleString('en-IN', {
		month: 'long',
		year: 'numeric',
		timeZone: 'UTC'
	});

	sheet.getCell('A1').value = `Pump headcount, ${monthLabel}`;
	sheet.getCell('A1').font = { bold: true, size: 16, color: { argb: BRAND } };
	sheet.getCell('A2').value =
		`${scope.description}. Data up to ${to}. Financial year from ${fyStart}.`;
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

	const buffer = await workbook.xlsx.writeBuffer();
	return { buffer, filename: `pump-headcount-${chosen}.xlsx` };
}
