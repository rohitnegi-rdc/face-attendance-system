// The 9 am attendance tracker's subject and HTML, one Area per email (worker/attendanceDigest.js
// builds the data, sendAttendanceDigestEmail in worker/mailer.js sends it). No database or mail here, so
// the unit tests render it directly. Dates and times are written for people, in IST. A pump with
// no one counted is a red row, and the count of them is in red under the summary. The summary puts
// the day beside the month to date; every pump is in one table, with its plant in a column.

/** @typedef {{ full_shift: number, start_only: number, end_only: number, workers: number, mtd_workers: number }} Counts */
/** @typedef {Counts & { pump_code: string, site_name?: string | null, start_at: string | Date | null, end_at: string | Date | null, regularised?: boolean }} Pump */
/** @typedef {{ id: string, name: string, pumps: Pump[], totals: Counts }} Plant */
/** @typedef {{ name: string, plants: Plant[] }} Area */
/** @typedef {{ pump_days: number, marked: number }} MonthToDate */

/** @param {unknown} value */
const escapeHtml = (value) =>
	String(value ?? '').replace(
		/[&<>"']/g,
		(/** @type {string} */ c) =>
			/** @type {Record<string, string>} */ ({
				'&': '&amp;',
				'<': '&lt;',
				'>': '&gt;',
				'"': '&quot;',
				"'": '&#39;'
			})[c]
	);

// "Fri, 30 Oct 2026" for a "YYYY-MM-DD" day, and "8:05 am" for a time, both in IST.
/** @param {string} day */
function humanDay(day) {
	return new Intl.DateTimeFormat('en-GB', {
		weekday: 'short',
		day: 'numeric',
		month: 'short',
		year: 'numeric',
		timeZone: 'UTC'
	})
		.format(new Date(`${day}T00:00:00Z`))
		.replace(/^(\w+) /, '$1, ');
}
/** @param {string | Date} value */
function istTime(value) {
	return new Intl.DateTimeFormat('en-IN', {
		hour: 'numeric',
		minute: '2-digit',
		hour12: true,
		timeZone: 'Asia/Kolkata'
	})
		.format(new Date(value))
		.toLowerCase();
}

const TH = 'style="text-align:left;padding:5px 4px;border-bottom:2px solid #ccc;font-size:12px"';
const TD = 'style="padding:5px 4px;border-bottom:1px solid #eee;font-size:13px"';
const NUM = 'style="padding:5px 4px;border-bottom:1px solid #eee;font-size:13px;text-align:right"';
const COUNT_HEADS = ['Full shift', 'Start only', 'End only', 'Workers', 'MTD']
	.map((h) => `<th ${TH.replace('text-align:left', 'text-align:right')}>${h}</th>`)
	.join('');
/** @param {Counts} t @param {boolean} [bold] */
const counts = (t, bold = false) =>
	[t.full_shift, t.start_only, t.end_only, t.workers, t.mtd_workers]
		.map((n) => `<td ${NUM}>${bold ? `<strong>${n}</strong>` : n}</td>`)
		.join('');
const RED = '#b3261e';
const RED_ROW = `style="background:#fdecea;color:${RED}"`;

// The 9 am attendance email (worker/attendanceDigest.js): subject and HTML for one recipient.
/**
 * @param {{ area: string, day: string, areas: Area[], totals: Counts & { pumps: number, marked: number }, mtd: MonthToDate }} message
 * @returns {{ subject: string, html: string }}
 */
export function renderAttendanceDigest({ area, day, areas, totals, mtd }) {
	const date = humanDay(day);
	const RIGHT_TH = TH.replace('text-align:left', 'text-align:right');
	/** @type {[string, string | number, string | number][]} */
	const summary = [
		['Total pumps', totals.pumps, `${mtd.pump_days} pump days`],
		['Marked attendance', totals.marked, mtd.marked]
	];
	const summaryHeads = summary.map(([label]) => `<th ${RIGHT_TH}>${label}</th>`).join('');
	const dayCells = summary.map(([, today]) => `<td ${NUM}><strong>${today}</strong></td>`).join('');
	const monthCells = summary.map(([, , month]) => `<td ${NUM}>${month}</td>`).join('');
	/** @param {Plant} plant */
	const plantRows = (plant) => {
		const plantCell = `<td ${TD}>${escapeHtml(plant.name)}</td>`;
		// The pump code, and the site it worked at that day under it.
		/** @param {Pump} p */
		const pumpCell = (p) =>
			`<td ${TD}><strong>${escapeHtml(p.pump_code)}</strong>` +
			(p.site_name ? `<br><span style="font-size:12px">${escapeHtml(p.site_name)}</span>` : '') +
			'</td>';
		const rows = plant.pumps
			.map((p) =>
				p.workers && p.regularised && !p.start_at && !p.end_at
					? `<tr>${plantCell}${pumpCell(p)}` +
						`<td ${TD} colspan="2"><strong>Regularised</strong> (missed day, approved)</td>${counts(p)}</tr>`
					: p.workers
						? `<tr>${plantCell}${pumpCell(p)}` +
							`<td ${TD}>${p.start_at ? istTime(p.start_at) : '<strong>No start photo</strong>'}</td>` +
							`<td ${TD}>${p.end_at ? istTime(p.end_at) : '<strong>No end photo</strong>'}</td>${counts(p)}</tr>`
						: `<tr ${RED_ROW}>${plantCell}${pumpCell(p)}` +
							`<td ${TD} colspan="2"><strong>No attendance</strong></td>${counts(p, true)}</tr>`
			)
			.join('');
		const total =
			plant.pumps.length > 1
				? `<tr${plant.totals.workers ? '' : ` ${RED_ROW}`}><td ${TD} colspan="4"><strong>${escapeHtml(plant.name)} total</strong></td>${counts(plant.totals, true)}</tr>`
				: '';
		return rows + total;
	};
	// One empty row between plants (the 9 columns of the pump table).
	const body = areas
		.flatMap((a) => a.plants.map(plantRows))
		.join('<tr><td colspan="9" style="height:18px;padding:0">&nbsp;</td></tr>');
	const zero = totals.pumps - totals.marked;
	const zeroLine = zero
		? `<p style="color:${RED};margin:8px 0 0"><strong>${zero} ${zero === 1 ? 'pump' : 'pumps'} with no attendance</strong>, in red below.</p>`
		: '';
	const html = `
		<p>Hello,</p>
		<p>Attendance in <strong>${escapeHtml(area)}</strong> for <strong>${date}</strong>:</p>
		<table cellspacing="0" style="border-collapse:collapse">
			<tr><th ${TH}></th>${summaryHeads}</tr>
			<tr><td ${TD}>${date}</td>${dayCells}</tr>
			<tr><td ${TD}>Month to date</td>${monthCells}</tr>
		</table>
		${zeroLine}
		<table cellspacing="0" style="border-collapse:collapse;margin-top:16px">
			<tr><th ${TH}>Plant</th><th ${TH}>Pump</th><th ${TH}>Start</th><th ${TH}>End</th>${COUNT_HEADS}</tr>
			${body}
		</table>
		<p style="margin:24px 0 6px"><strong>How to read this email</strong></p>
		<ul style="margin:0;padding-left:20px;font-size:13px;line-height:1.5">
			<li><strong>Full shift:</strong> the worker was in both the start and the end photo.</li>
			<li><strong>Start only / End only:</strong> the worker was in just one of the two photos.</li>
			<li><strong>No attendance:</strong> the pump sent no photo, or no worker was counted in it.</li>
			<li><strong>MTD (month to date):</strong> the pump's total attendance from the 1st of this month till this day. A worker present on 3 days counts as 3.</li>
			<li><strong>Pump days:</strong> the days pumps were Active or Idle this month. One pump for 3 days is 3 pump days.</li>
			<li>Only pumps that are Active or Idle are listed.</li>
			<li>To correct a Start only or End only worker, open Attendance in Face Attendance.</li>
		</ul>
	`;
	const subject = `${area} attendance, ${date}: ${totals.full_shift} full shift, ${totals.start_only} start only, ${totals.end_only} end only`;
	return { subject, html };
}
