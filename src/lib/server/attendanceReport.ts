// Attendance report workbook shared by the admin and plant-manager exports. The caller decides
// which pumps are in scope (a SQL condition on pumps pu / plants pl / areas a / vendors v);
// everything else (sheets, wording, absence rule) is the same for every role, so an admin and
// a plant manager looking at the same plant read the same numbers.
import ExcelJS from 'exceljs';
import { query } from '$lib/server/db';
import { personDisplayLabel } from '$lib/personLabel';
import { addDaysStr, dateKey, formatDate, isDateKey } from '$lib/date';
import { shiftOutcomeLabel } from '$lib/shiftLabels';
import { todayIST } from '$lib/server/time';
import { heldShiftDay } from '$lib/server/locationCheck';

// A worker is expected on a day their pump took attendance, from their first photo until this
// many days after their last one. Without the cut-off, a worker who left would show as absent
// every day forever.
export const ABSENT_AFTER_LAST_SEEN_DAYS = 14;
const MAX_RANGE_DAYS = 366;

export type ReportScope = {
	// SQL condition over pu (pumps), pl (plants), a (areas), v (vendors); placeholders start at $1.
	where: string;
	params: unknown[];
	// Shown under the Summary title, e.g. "Plant manager, MUM-Deonar".
	description: string;
};

export type ReportFilters = {
	from?: string;
	to?: string;
	// Optional admin filters for the Daily sheet only, matching the attendance page.
	session?: 'morning' | 'evening' | '';
	status?: 'present' | 'absent' | '';
};

type DailyRow = {
	session_date: string;
	person_id: string;
	display_seq: number;
	pump_code: string;
	vendor_name: string;
	plant_name: string;
	area_name: string;
	first_seen: string;
	last_seen: string;
	morning: boolean;
	evening: boolean;
	start_time: string | null;
	end_time: string | null;
	shift_minutes: number | null;
	still_open: boolean;
	corrections: string | null;
	duplicate_of: number | null;
};

export function reportRange(filters: ReportFilters): { from: string; to: string } {
	const to = filters.to && isDateKey(filters.to) ? filters.to : todayIST();
	let from = filters.from && isDateKey(filters.from) ? filters.from : addDaysStr(to, -29);
	if (from > to) from = to;
	const earliest = addDaysStr(to, 1 - MAX_RANGE_DAYS);
	return { from: from < earliest ? earliest : from, to };
}

function dayResult(row: DailyRow): string {
	if (row.duplicate_of !== null) return 'Duplicate';
	if (row.morning && row.evening) return 'Full shift';
	if (row.morning) return row.still_open ? 'Shift still open' : 'Start only';
	if (row.evening) return 'End only';
	return 'Absent';
}

const RESULT_FILL: Record<string, string> = {
	'Full shift': 'FFD7F0E2',
	'Start only': 'FFFFEFC2',
	'End only': 'FFFFEFC2',
	'Shift still open': 'FFDCEBFF',
	Absent: 'FFF9D6D6',
	Duplicate: 'FFE9E9E9'
};

const BRAND = 'FF0B6E69';
const BRAND_LIGHT = 'FFE6F2F1';
const MUTED = 'FF5B6B73';
const GRID = 'FFD5DEE2';
const thin = { style: 'thin' as const, color: { argb: GRID } };
const BORDER = { top: thin, left: thin, bottom: thin, right: thin };

function excelDate(value: string | Date) {
	return new Date(`${dateKey(value)}T00:00:00Z`);
}

function fill(argb: string): ExcelJS.Fill {
	return { type: 'pattern', pattern: 'solid', fgColor: { argb } };
}

function landscape(sheet: ExcelJS.Worksheet) {
	sheet.pageSetup = {
		orientation: 'landscape',
		fitToPage: true,
		fitToWidth: 1,
		fitToHeight: 0,
		margins: { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 }
	};
}

// Colour for an attendance share: green from 90%, amber from 70%, red below.
function pctFill(value: number) {
	return value >= 0.9 ? 'FFD7F0E2' : value >= 0.7 ? 'FFFFEFC2' : 'FFF9D6D6';
}

type Column = {
	header: string;
	key: string;
	width: number;
	align?: 'left' | 'center';
	numFmt?: string;
};

// A data table that starts at `startRow`: teal header that wraps, bordered cells, numbers
// centred. Returns the next free row.
function writeTable(
	sheet: ExcelJS.Worksheet,
	startRow: number,
	columns: Column[],
	records: Record<string, unknown>[],
	decorate?: (record: Record<string, unknown>, row: ExcelJS.Row) => void
) {
	const header = sheet.getRow(startRow);
	columns.forEach((column, i) => {
		const cell = header.getCell(i + 1);
		cell.value = column.header;
		cell.font = { bold: true, color: { argb: 'FFFFFFFF' } };
		cell.fill = fill(BRAND);
		cell.alignment = { wrapText: true, vertical: 'middle', horizontal: column.align ?? 'left' };
		cell.border = BORDER;
	});
	header.height = 32;
	records.forEach((record, r) => {
		const row = sheet.getRow(startRow + 1 + r);
		columns.forEach((column, i) => {
			const cell = row.getCell(i + 1);
			cell.value = (record[column.key] ?? '') as ExcelJS.CellValue;
			cell.border = BORDER;
			cell.alignment = { vertical: 'middle', horizontal: column.align ?? 'left' };
			if (column.numFmt) cell.numFmt = column.numFmt;
		});
		decorate?.(record, row);
	});
	return startRow + 1 + records.length;
}

function dataSheet(
	workbook: ExcelJS.Workbook,
	name: string,
	columns: Column[],
	records: Record<string, unknown>[],
	frozenColumns: number,
	empty: string,
	decorate?: (record: Record<string, unknown>, row: ExcelJS.Row) => void
) {
	const sheet = workbook.addWorksheet(name, {
		views: [{ state: 'frozen', xSplit: frozenColumns, ySplit: 1 }]
	});
	columns.forEach((column, i) => (sheet.getColumn(i + 1).width = column.width));
	writeTable(sheet, 1, columns, records, decorate);
	if (records.length) {
		sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
	} else {
		sheet.getCell('A2').value = empty;
		sheet.getCell('A2').font = { italic: true, color: { argb: MUTED } };
	}
	landscape(sheet);
	return sheet;
}

const DATE_FMT = 'ddd dd mmm yyyy';

export async function buildAttendanceReport(scope: ReportScope, filters: ReportFilters) {
	const { from, to } = reportRange(filters);
	const n = scope.params.length;
	const params = [...scope.params, from, to, ABSENT_AFTER_LAST_SEEN_DAYS];
	const FROM = `$${n + 1}`;
	const TO = `$${n + 2}`;
	const GRACE = `$${n + 3}`;
	const scopeCte = `scope AS (
		SELECT pu.id, pu.pump_code, v.name AS vendor_name, pl.name AS plant_name, a.name AS area_name
		FROM pumps pu JOIN vendors v ON v.id = pu.vendor_id
		JOIN plants pl ON pl.id = pu.plant_id JOIN areas a ON a.id = pl.area_id
		WHERE ${scope.where}
	)`;

	// One row per worker per day their pump took attendance (a start or end photo that was
	// processed), including the days the worker was not in either photo.
	const daily = await query<DailyRow>(
		`WITH ${scopeCte},
		work_days AS (
			SELECT s.pump_id, s.session_date,
			       min(s.submitted_at) FILTER (WHERE s.session_type = 'morning') AS start_at,
			       min(s.submitted_at) FILTER (WHERE s.session_type = 'evening') AS end_at,
			       bool_or(s.session_type = 'morning' AND s.pairing_status = 'open') AS still_open
			FROM attendance_sessions s JOIN scope ON scope.id = s.pump_id
			WHERE s.session_date BETWEEN ${FROM} AND ${TO} AND s.status IN ('review', 'completed')
			  AND NOT ${heldShiftDay('s.pump_id', 's.session_date')}
			GROUP BY s.pump_id, s.session_date
		)
		SELECT w.session_date::text AS session_date, p.id AS person_id, p.display_seq,
		       sc.pump_code, sc.vendor_name, sc.plant_name, sc.area_name,
		       -- From real attendance too: a shift moved to an earlier date predates first_seen_at.
		       LEAST((p.first_seen_at AT TIME ZONE 'Asia/Kolkata')::date,
		             (SELECT min(x.session_date) FROM daily_person_attendance x
		              WHERE x.person_id = p.id AND (x.morning_matched OR x.evening_matched)))::text AS first_seen,
		       GREATEST((p.last_seen_at AT TIME ZONE 'Asia/Kolkata')::date,
		             (SELECT max(x.session_date) FROM daily_person_attendance x
		              WHERE x.person_id = p.id AND (x.morning_matched OR x.evening_matched)))::text AS last_seen,
		       coalesce(d.morning_matched, false) AS morning,
		       coalesce(d.evening_matched, false) AS evening,
		       to_char(w.start_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS start_time,
		       to_char(w.end_at AT TIME ZONE 'Asia/Kolkata', 'HH24:MI') AS end_time,
		       round(extract(epoch FROM (w.end_at - w.start_at)) / 60)::int AS shift_minutes,
		       coalesce(w.still_open, false) AS still_open,
		       (SELECT string_agg(c.reason, ' | ' ORDER BY c.corrected_at)
		          FROM attendance_corrections c
		          WHERE c.person_id = p.id AND c.session_date = w.session_date) AS corrections,
		       (SELECT kp.display_seq FROM attendance_duplicate_resolutions r
		          JOIN persons kp ON kp.id = r.kept_person_id
		          WHERE r.duplicate_person_id = p.id AND r.session_date = w.session_date
		            AND r.reversed_at IS NULL
		          LIMIT 1) AS duplicate_of
		FROM work_days w
		JOIN scope sc ON sc.id = w.pump_id
		JOIN persons p ON p.pump_id = w.pump_id AND p.status <> 'merged'
		LEFT JOIN daily_person_attendance d ON d.person_id = p.id AND d.session_date = w.session_date
		-- A day with an attendance row always counts (it may predate first_seen_at, e.g. after an
		-- admin moved a shift to an earlier date); the seen-window only decides who is absent.
		WHERE (
		    d.id IS NOT NULL
		    OR (
		      (p.first_seen_at AT TIME ZONE 'Asia/Kolkata')::date <= w.session_date
		      AND w.session_date <= (p.last_seen_at AT TIME ZONE 'Asia/Kolkata')::date + ${GRACE}::int
		    )
		  )
		  -- A worker never counted on any day is a leftover (e.g. from a deleted session), not
		  -- someone who keeps missing work.
		  AND EXISTS (
		    SELECT 1 FROM daily_person_attendance x
		    WHERE x.person_id = p.id AND (x.morning_matched OR x.evening_matched)
		  )
		ORDER BY w.session_date DESC, sc.pump_code, p.display_seq`,
		params
	);

	const sessions = await query<any>(
		`WITH ${scopeCte}
		SELECT s.session_date::text AS session_date, s.session_type, s.status, s.pairing_status,
		       s.closed_by, s.error_reason, sc.pump_code, sc.vendor_name, sc.plant_name, sc.area_name,
		       to_char(s.submitted_at AT TIME ZONE 'Asia/Kolkata', 'DD Mon YYYY HH24:MI') AS sent_at,
		       (SELECT count(*)::int FROM attendance_face_evidence e WHERE e.session_id = s.id) AS people
		FROM attendance_sessions s JOIN scope sc ON sc.id = s.pump_id
		WHERE s.session_date BETWEEN ${FROM} AND ${TO}
		ORDER BY s.submitted_at DESC`,
		params.slice(0, n + 2)
	);

	const changes = await query<any>(
		`WITH ${scopeCte}
		SELECT c.session_date::text AS session_date, 'Attendance corrected' AS kind,
		       sc.pump_code, p.display_seq,
		       concat('Start ', CASE WHEN c.previous_morning_matched THEN 'present' ELSE 'missing' END,
		              ' > ', CASE WHEN c.corrected_morning_matched THEN 'present' ELSE 'missing' END,
		              ', End ', CASE WHEN c.previous_evening_matched THEN 'present' ELSE 'missing' END,
		              ' > ', CASE WHEN c.corrected_evening_matched THEN 'present' ELSE 'missing' END) AS detail,
		       c.reason, ad.email AS by_email, c.corrected_at AS at
		FROM attendance_corrections c JOIN scope sc ON sc.id = c.pump_id
		JOIN persons p ON p.id = c.person_id LEFT JOIN admins ad ON ad.id = c.corrected_by_admin_id
		WHERE c.session_date BETWEEN ${FROM} AND ${TO}
		UNION ALL
		SELECT r.session_date::text, CASE WHEN r.reversed_at IS NULL THEN 'Marked duplicate'
		                                  ELSE 'Duplicate mark undone' END,
		       sc.pump_code, dp.display_seq,
		       concat(CASE r.session_type WHEN 'morning' THEN 'Shift start' ELSE 'Shift end' END,
		              ': same person as Worker ', kp.display_seq),
		       r.reason, ad.email, coalesce(r.reversed_at, r.resolved_at)
		FROM attendance_duplicate_resolutions r JOIN scope sc ON sc.id = r.pump_id
		JOIN persons dp ON dp.id = r.duplicate_person_id JOIN persons kp ON kp.id = r.kept_person_id
		LEFT JOIN admins ad ON ad.id = coalesce(r.reversed_by_admin_id, r.resolved_by_admin_id)
		WHERE r.session_date BETWEEN ${FROM} AND ${TO}
		UNION ALL
		SELECT s.session_date::text, 'Fraud flag', sc.pump_code, p.display_seq,
		       concat('Also matched at pump ', op.pump_code, ' (',
		              round((f.similarity_score * 100)::numeric, 1), '% similar)'),
		       CASE WHEN NOT f.reviewed THEN 'Open, not reviewed yet'
		            WHEN f.resolution = 'confirmed_fraud' THEN 'Confirmed fraud'
		            WHEN f.resolution = 'not_fraud' THEN 'Not fraud'
		            ELSE 'Reviewed' END,
		       ad.email, f.created_at
		FROM fraud_flags f JOIN attendance_sessions s ON s.id = f.session_id
		JOIN scope sc ON sc.id = s.pump_id
		LEFT JOIN persons p ON p.id = f.person_id
		LEFT JOIN pumps op ON op.id = f.matched_at_pump_id
		LEFT JOIN admins ad ON ad.id = f.resolved_by_admin_id
		WHERE s.session_date BETWEEN ${FROM} AND ${TO}
		ORDER BY 1 DESC, 8 DESC`,
		params.slice(0, n + 2)
	);

	const fraudByPerson = new Map<string, number>();
	const fraudRows = await query<any>(
		`WITH ${scopeCte}
		SELECT f.person_id, count(*)::int AS n FROM fraud_flags f
		JOIN attendance_sessions s ON s.id = f.session_id JOIN scope ON scope.id = s.pump_id
		WHERE s.session_date BETWEEN ${FROM} AND ${TO} AND f.person_id IS NOT NULL
		GROUP BY f.person_id`,
		params.slice(0, n + 2)
	);
	for (const f of fraudRows) fraudByPerson.set(f.person_id, f.n);

	type Totals = {
		expected: number;
		full: number;
		startOnly: number;
		endOnly: number;
		open: number;
		absent: number;
		corrected: number;
	};
	const emptyTotals = (): Totals => ({
		expected: 0,
		full: 0,
		startOnly: 0,
		endOnly: 0,
		open: 0,
		absent: 0,
		corrected: 0
	});
	function add(totals: Totals, row: DailyRow) {
		const result = dayResult(row);
		if (result !== 'Duplicate') totals.expected++;
		if (result === 'Full shift') totals.full++;
		if (result === 'Start only') totals.startOnly++;
		if (result === 'End only') totals.endOnly++;
		if (result === 'Shift still open') totals.open++;
		if (result === 'Absent') totals.absent++;
		if (row.corrections) totals.corrected++;
	}
	const pct = (t: Totals) => (t.expected ? t.full / t.expected : 0);
	const grouped = <K>(key: (row: DailyRow) => K) => {
		const groups = new Map<K, { first: DailyRow; totals: Totals; days: Set<string> }>();
		for (const row of daily) {
			const k = key(row);
			const group = groups.get(k) ?? { first: row, totals: emptyTotals(), days: new Set() };
			add(group.totals, row);
			group.days.add(row.session_date);
			groups.set(k, group);
		}
		return groups;
	};
	const overall = emptyTotals();
	for (const row of daily) add(overall, row);
	const byPump = [...grouped((row) => row.pump_code).values()].sort(
		(x, y) =>
			x.first.plant_name.localeCompare(y.first.plant_name) ||
			x.first.pump_code.localeCompare(y.first.pump_code)
	);
	const byDay = [...grouped((row) => row.session_date).values()].sort((x, y) =>
		y.first.session_date.localeCompare(x.first.session_date)
	);
	const byPerson = [...grouped((row) => row.person_id).values()].sort(
		(x, y) =>
			x.first.plant_name.localeCompare(y.first.plant_name) ||
			x.first.pump_code.localeCompare(y.first.pump_code) ||
			x.first.display_seq - y.first.display_seq
	);

	const workbook = new ExcelJS.Workbook();
	workbook.created = new Date();
	workbook.views = [
		{ x: 0, y: 0, width: 20000, height: 12000, firstSheet: 0, activeTab: 0, visibility: 'visible' }
	];
	const generated = new Date().toLocaleString('en-IN', {
		timeZone: 'Asia/Kolkata',
		dateStyle: 'medium',
		timeStyle: 'short'
	});
	const period = from === to ? formatDate(from) : `${formatDate(from)} to ${formatDate(to)}`;

	// --- Summary: what a manager reads first ------------------------------------------------
	const summary = workbook.addWorksheet('Summary', { views: [{ showGridLines: false }] });
	[32, 16, 32, 14, 12, 12, 12, 12, 12, 12, 13].forEach(
		(width, i) => (summary.getColumn(i + 1).width = width)
	);
	summary.mergeCells('A1:K1');
	summary.getCell('A1').value = 'Attendance report';
	summary.getCell('A1').font = { bold: true, size: 18, color: { argb: BRAND } };
	summary.getRow(1).height = 30;
	summary.mergeCells('A2:K2');
	summary.getCell('A2').value =
		`${scope.description}   |   ${period}   |   Generated ${generated} IST`;
	summary.getCell('A2').font = { color: { argb: MUTED } };

	const heading = (row: number, text: string, note?: string) => {
		const cell = summary.getCell(`A${row}`);
		cell.value = text;
		cell.font = { bold: true, size: 13, color: { argb: BRAND } };
		if (note) {
			summary.mergeCells(`B${row}:K${row}`);
			summary.getCell(`B${row}`).value = note;
			summary.getCell(`B${row}`).font = { italic: true, color: { argb: MUTED } };
		}
		summary.getRow(row).height = 22;
	};

	let row = 4;
	heading(
		row,
		'At a glance',
		'Counted in worker-days: one worker on one day their pump took attendance.'
	);
	row++;
	if (!daily.length) {
		summary.mergeCells(`A${row}:K${row}`);
		summary.getCell(`A${row}`).value =
			'No pump in this report sent a processed attendance photo in this period.';
		summary.getCell(`A${row}`).font = { italic: true, color: { argb: MUTED } };
		row += 2;
	} else {
		const glance: [string, number | string, string?][] = [
			['Pumps that took attendance', byPump.length],
			['Workers expected (worker-days)', overall.expected],
			['Full shift', overall.full, RESULT_FILL['Full shift']],
			['Start only', overall.startOnly, RESULT_FILL['Start only']],
			['Shift still open', overall.open, RESULT_FILL['Shift still open']],
			['End only', overall.endOnly, RESULT_FILL['End only']],
			['Absent', overall.absent, RESULT_FILL.Absent],
			['Attendance (full shift %)', pct(overall), pctFill(pct(overall))]
		];
		for (const [label, value, color] of glance) {
			const labelCell = summary.getCell(`A${row}`);
			const valueCell = summary.getCell(`B${row}`);
			labelCell.value = label;
			labelCell.border = BORDER;
			labelCell.fill = fill(BRAND_LIGHT);
			valueCell.value = value;
			valueCell.border = BORDER;
			valueCell.font = { bold: true, size: 12 };
			valueCell.alignment = { horizontal: 'center' };
			if (color) valueCell.fill = fill(color);
			if (label.startsWith('Attendance')) valueCell.numFmt = '0%';
			row++;
		}
		row++;

		const totalsColumns: Column[] = [
			{ header: 'Expected', key: 'expected', width: 12, align: 'center' },
			{ header: 'Full shift', key: 'full', width: 12, align: 'center' },
			{ header: 'Start only', key: 'startOnly', width: 12, align: 'center' },
			{ header: 'Still open', key: 'open', width: 12, align: 'center' },
			{ header: 'End only', key: 'endOnly', width: 12, align: 'center' },
			{ header: 'Absent', key: 'absent', width: 12, align: 'center' },
			{ header: 'Attendance %', key: 'pct', width: 13, align: 'center', numFmt: '0%' }
		];
		const colourPct = (record: Record<string, unknown>, r: ExcelJS.Row) => {
			r.getCell(11).fill = fill(pctFill(record.pct as number));
		};

		heading(row, 'By pump', 'Lowest attendance shows red; open the People sheet for each worker.');
		row = writeTable(
			summary,
			row + 1,
			[
				{ header: 'Pump', key: 'pump', width: 24 },
				{ header: 'Plant', key: 'plant', width: 16 },
				{ header: 'Vendor', key: 'vendor', width: 28 },
				{ header: 'Days with photos', key: 'days', width: 14, align: 'center' },
				...totalsColumns
			],
			byPump.map((g) => ({
				pump: g.first.pump_code,
				plant: g.first.plant_name,
				vendor: g.first.vendor_name,
				days: g.days.size,
				...g.totals,
				pct: pct(g.totals)
			})),
			colourPct
		);
		row++;

		heading(row, 'By day', 'Newest first.');
		writeTable(
			summary,
			row + 1,
			[
				{ header: 'Date', key: 'date', width: 24, numFmt: DATE_FMT },
				{ header: 'Pumps', key: 'pumps', width: 16, align: 'center' },
				{ header: 'Which pumps', key: 'pumpList', width: 32 },
				{ header: 'Photos sent', key: 'photos', width: 14, align: 'center' },
				...totalsColumns
			],
			byDay.map((g) => ({
				date: excelDate(g.first.session_date),
				pumps: new Set(
					daily.filter((d) => d.session_date === g.first.session_date).map((d) => d.pump_code)
				).size,
				pumpList: [
					...new Set(
						daily.filter((d) => d.session_date === g.first.session_date).map((d) => d.pump_code)
					)
				]
					.sort()
					.join(', '),
				photos: sessions.filter((x) => x.session_date === g.first.session_date).length,
				...g.totals,
				pct: pct(g.totals)
			})),
			colourPct
		);
	}
	landscape(summary);

	// --- People: one row per worker ---------------------------------------------------------
	dataSheet(
		workbook,
		'People',
		[
			{ header: 'Person', key: 'person', width: 22 },
			{ header: 'Pump', key: 'pump', width: 13 },
			{ header: 'Plant', key: 'plant', width: 16 },
			{ header: 'Vendor', key: 'vendor', width: 34 },
			{ header: 'First seen', key: 'first', width: 15, numFmt: DATE_FMT },
			{ header: 'Last seen', key: 'last', width: 15, numFmt: DATE_FMT },
			{ header: 'Expected days', key: 'expected', width: 10, align: 'center' },
			{ header: 'Full shift', key: 'full', width: 10, align: 'center' },
			{ header: 'Start only', key: 'startOnly', width: 10, align: 'center' },
			{ header: 'Still open', key: 'open', width: 10, align: 'center' },
			{ header: 'End only', key: 'endOnly', width: 10, align: 'center' },
			{ header: 'Absent', key: 'absent', width: 10, align: 'center' },
			{ header: 'Attendance %', key: 'pct', width: 12, align: 'center', numFmt: '0%' },
			{ header: 'Admin fixes', key: 'corrected', width: 10, align: 'center' },
			{ header: 'Fraud flags', key: 'fraud', width: 10, align: 'center' }
		],
		byPerson.map((g) => ({
			person: personDisplayLabel(g.first.pump_code, g.first.display_seq),
			pump: g.first.pump_code,
			plant: g.first.plant_name,
			vendor: g.first.vendor_name,
			first: excelDate(g.first.first_seen),
			last: excelDate(g.first.last_seen),
			...g.totals,
			pct: pct(g.totals),
			fraud: fraudByPerson.get(g.first.person_id) ?? 0
		})),
		1,
		'No workers were expected in this period.',
		(record, r) => {
			r.getCell(13).fill = fill(pctFill(record.pct as number));
			if ((record.fraud as number) > 0) r.getCell(15).fill = fill(RESULT_FILL.Absent);
		}
	);

	// --- Daily: one row per worker per working day -----------------------------------------
	const wanted = (r: DailyRow) => {
		if (!filters.status) return true;
		const present =
			filters.session === 'morning'
				? r.morning
				: filters.session === 'evening'
					? r.evening
					: r.morning && r.evening;
		return filters.status === 'present' ? present : !present;
	};
	dataSheet(
		workbook,
		'Daily',
		[
			{ header: 'Date', key: 'date', width: 16, numFmt: DATE_FMT },
			{ header: 'Person', key: 'person', width: 22 },
			{ header: 'Pump', key: 'pump', width: 13 },
			{ header: 'Plant', key: 'plant', width: 16 },
			{ header: 'Day result', key: 'result', width: 16, align: 'center' },
			{ header: 'In start photo', key: 'start', width: 10, align: 'center' },
			{ header: 'In end photo', key: 'end', width: 10, align: 'center' },
			{ header: 'Start photo time', key: 'startTime', width: 10, align: 'center' },
			{ header: 'End photo time', key: 'endTime', width: 10, align: 'center' },
			{ header: 'Shift hours', key: 'hours', width: 9, align: 'center' },
			{ header: 'Vendor', key: 'vendor', width: 34 },
			{ header: 'Admin note', key: 'note', width: 48 }
		],
		daily.filter(wanted).map((r) => ({
			date: excelDate(r.session_date),
			person: personDisplayLabel(r.pump_code, r.display_seq),
			pump: r.pump_code,
			plant: r.plant_name,
			result: dayResult(r),
			start: r.morning ? 'Yes' : 'No',
			end: r.evening ? 'Yes' : 'No',
			// Only the photos this worker was in; the pump's other photo times would mislead.
			startTime: r.morning ? (r.start_time ?? '') : '',
			endTime: r.evening ? (r.end_time ?? '') : '',
			hours:
				r.shift_minutes !== null && r.morning && r.evening
					? Math.round(r.shift_minutes / 6) / 10
					: '',
			vendor: r.vendor_name,
			note: [
				r.duplicate_of !== null
					? `Same person as ${personDisplayLabel(r.pump_code, r.duplicate_of)}`
					: '',
				r.corrections ? `Corrected: ${r.corrections}` : ''
			]
				.filter(Boolean)
				.join('. ')
		})),
		2,
		'No attendance in this period.',
		(record, r) => {
			r.getCell(5).fill = fill(RESULT_FILL[record.result as string]);
		}
	);

	// --- Shifts: every photo the pumps sent --------------------------------------------------
	dataSheet(
		workbook,
		'Shifts',
		[
			{ header: 'Date', key: 'date', width: 16, numFmt: DATE_FMT },
			{ header: 'Pump', key: 'pump', width: 13 },
			{ header: 'Plant', key: 'plant', width: 16 },
			{ header: 'Photo', key: 'type', width: 12 },
			{ header: 'Sent at (IST)', key: 'sent', width: 18 },
			{ header: 'Processing', key: 'status', width: 13, align: 'center' },
			{ header: 'People counted', key: 'people', width: 10, align: 'center' },
			{ header: 'How the shift ended', key: 'outcome', width: 28 },
			{ header: 'Vendor', key: 'vendor', width: 34 },
			{ header: 'Problem', key: 'problem', width: 48 }
		],
		sessions.map((s) => ({
			date: excelDate(s.session_date),
			pump: s.pump_code,
			plant: s.plant_name,
			type: s.session_type === 'evening' ? 'Shift end' : 'Shift start',
			sent: s.sent_at,
			status: s.status,
			people: s.people,
			outcome: s.session_type === 'morning' ? shiftOutcomeLabel(s) : '',
			vendor: s.vendor_name,
			problem: s.error_reason ?? ''
		})),
		2,
		'No photos were sent in this period.',
		(record, r) => {
			if (record.status === 'failed' || record.status === 'fraud_detected') {
				r.getCell(6).fill = fill(RESULT_FILL.Absent);
			}
		}
	);

	// --- Changes: what admins changed, and fraud flags ---------------------------------------
	dataSheet(
		workbook,
		'Changes',
		[
			{ header: 'Attendance date', key: 'date', width: 16, numFmt: DATE_FMT },
			{ header: 'Change', key: 'kind', width: 20 },
			{ header: 'Person', key: 'person', width: 22 },
			{ header: 'What changed', key: 'detail', width: 44 },
			{ header: 'Reason or outcome', key: 'reason', width: 40 },
			{ header: 'By', key: 'by', width: 26 },
			{ header: 'When (IST)', key: 'at', width: 18 }
		],
		changes.map((c) => ({
			date: excelDate(c.session_date),
			kind: c.kind,
			person: c.display_seq != null ? personDisplayLabel(c.pump_code, c.display_seq) : c.pump_code,
			detail: c.detail,
			reason: c.reason ?? '',
			by: c.by_email ?? '',
			at: c.at
				? new Date(c.at).toLocaleString('en-IN', {
						timeZone: 'Asia/Kolkata',
						dateStyle: 'medium',
						timeStyle: 'short'
					})
				: ''
		})),
		1,
		'No corrections, duplicate marks or fraud flags in this period.'
	);

	// --- Help: what every word means ---------------------------------------------------------
	const help = workbook.addWorksheet('Help', { views: [{ showGridLines: false }] });
	help.getColumn(1).width = 26;
	help.getColumn(2).width = 100;
	landscape(help);
	const helpRows: [string, string][] = [
		['Day results', ''],
		['Full shift', 'In the shift start photo and in the shift end photo.'],
		['Start only', 'In the start photo, but the shift ended without them in an end photo.'],
		['End only', 'In the end photo only.'],
		[
			'Shift still open',
			'In the start photo; the end photo has not been taken yet. Export again after the shift ends.'
		],
		['Absent', 'Not in either photo on a day their pump took attendance.'],
		[
			'Duplicate',
			'An admin marked this worker as the same person as another worker that day, so it is not counted twice.'
		],
		['', ''],
		['Counting', ''],
		[
			'Expected days',
			`The days a worker should have been in a photo: days their pump sent a processed photo, from the worker's first photo until ${ABSENT_AFTER_LAST_SEEN_DAYS} days after their last one. Days the pump sent nothing are not counted for anyone. Workers never counted on any day are left out.`
		],
		['Attendance %', 'Full shift days divided by expected days.'],
		['Worker-days', 'One worker on one day. 10 workers over 3 days is 30 worker-days.'],
		[
			'Workers',
			'Workers are recognised by face, so they are named "PUMP Worker N". The number stays the same for that person at that pump.'
		],
		['Times', 'All times are India time (IST).']
	];
	helpRows.forEach(([label, text], i) => {
		const r = help.getRow(i + 1);
		r.getCell(1).value = label;
		r.getCell(2).value = text;
		r.getCell(2).alignment = { wrapText: true, vertical: 'top' };
		r.getCell(1).alignment = { vertical: 'top' };
		if (!text) {
			r.getCell(1).font = { bold: true, size: 13, color: { argb: BRAND } };
			r.height = 22;
		} else {
			r.getCell(1).font = { bold: true };
			if (RESULT_FILL[label]) r.getCell(1).fill = fill(RESULT_FILL[label]);
			// Excel does not grow rows for wrapped text written by a library; size them here.
			r.height = Math.ceil(text.length / 105) * 15 + 3;
		}
	});

	return {
		buffer: await workbook.xlsx.writeBuffer(),
		filename: `attendance-${from}-to-${to}.xlsx`
	};
}

export function xlsxResponse(buffer: ExcelJS.Buffer, filename: string) {
	return new Response(buffer as ArrayBuffer, {
		headers: {
			'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
			'content-disposition': `attachment; filename="${filename}"`
		}
	});
}
