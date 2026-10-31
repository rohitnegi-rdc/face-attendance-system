// The 9 am attendance tracker's subject and HTML, one Area per email (worker/attendanceDigest.js
// builds the data, sendAttendanceDigestEmail in worker/mailer.js sends it). No database or mail here, so
// the unit tests render it directly. Dates and times are written for people, in IST. A pump with
// no one counted is a red row, and the count of them is in red under the summary.

/** @typedef {{ full_shift: number, start_only: number, end_only: number, workers: number }} Counts */
/** @typedef {Counts & { pump_code: string, site_name?: string | null, start_at: string | Date | null, end_at: string | Date | null }} Pump */
/** @typedef {{ id: string, name: string, pumps: Pump[], totals: Counts }} Plant */
/** @typedef {{ name: string, plants: Plant[] }} Area */

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
const COUNT_HEADS = ['Full shift', 'Start only', 'End only', 'Workers']
	.map((h) => `<th ${TH.replace('text-align:left', 'text-align:right')}>${h}</th>`)
	.join('');
/** @param {Counts} t @param {boolean} [bold] */
const counts = (t, bold = false) =>
	[t.full_shift, t.start_only, t.end_only, t.workers]
		.map((n) => `<td ${NUM}>${bold ? `<strong>${n}</strong>` : n}</td>`)
		.join('');
const RED = '#b3261e';
const RED_ROW = `style="background:#fdecea;color:${RED}"`;

// The 9 am attendance email (worker/attendanceDigest.js): subject and HTML for one recipient.
/**
 * @param {{ area: string, day: string, areas: Area[], totals: Counts & { pumps: number } }} message
 * @returns {{ subject: string, html: string }}
 */
export function renderAttendanceDigest({ area, day, areas, totals }) {
	const date = humanDay(day);
	const pct = totals.workers ? Math.round((100 * totals.full_shift) / totals.workers) : 0;
	/** @param {Plant} plant */
	const plantTable = (plant) => {
		// The pump code, and the site it worked at that day under it.
		/** @param {Pump} p */
		const pumpCell = (p) =>
			`<td ${TD}><strong>${escapeHtml(p.pump_code)}</strong>` +
			(p.site_name ? `<br><span style="font-size:12px">${escapeHtml(p.site_name)}</span>` : '') +
			'</td>';
		const rows = plant.pumps
			.map((p) =>
				p.workers
					? `<tr>${pumpCell(p)}` +
						`<td ${TD}>${p.start_at ? istTime(p.start_at) : '<strong>No start photo</strong>'}</td>` +
						`<td ${TD}>${p.end_at ? istTime(p.end_at) : '<strong>No end photo</strong>'}</td>${counts(p)}</tr>`
					: `<tr ${RED_ROW}>${pumpCell(p)}` +
						`<td ${TD} colspan="2"><strong>No attendance</strong></td>${counts(p, true)}</tr>`
			)
			.join('');
		const total =
			plant.pumps.length > 1
				? `<tr${plant.totals.workers ? '' : ` ${RED_ROW}`}><td ${TD} colspan="3"><strong>Plant total</strong></td>${counts(plant.totals, true)}</tr>`
				: '';
		return `<p style="margin:16px 0 6px"><em>${escapeHtml(plant.name)}</em></p>
			<table cellspacing="0" style="border-collapse:collapse">
				<tr><th ${TH}>Pump</th><th ${TH}>Start</th><th ${TH}>End</th>${COUNT_HEADS}</tr>
				${rows}${total}
			</table>`;
	};
	const body = areas.flatMap((a) => a.plants.map(plantTable)).join('');
	const zero = areas
		.flatMap((a) => a.plants.flatMap((p) => p.pumps))
		.filter((p) => !p.workers).length;
	const zeroLine = zero
		? `<p style="color:${RED};margin:8px 0 0"><strong>${zero} ${zero === 1 ? 'pump' : 'pumps'} with no attendance</strong>, in red below.</p>`
		: '';
	const html = `
		<p>Hello,</p>
		<p>Attendance in <strong>${escapeHtml(area)}</strong> for <strong>${date}</strong>:</p>
		<table cellspacing="0" style="border-collapse:collapse">
			<tr><th ${TH}>Pumps</th>${COUNT_HEADS}<th ${TH.replace('text-align:left', 'text-align:right')}>Full shift %</th></tr>
			<tr><td ${NUM}>${totals.pumps}</td>${counts(totals, true)}<td ${NUM}>${pct}%</td></tr>
		</table>
		${zeroLine}
		${body}
		<p style="margin-top:24px">Full shift: in the start and the end photo. Start only or end only: in one of
		them. No attendance: the pump sent no photo, or no one was counted in it. Only Active and Idle
		pumps are listed. Open Attendance in Face Attendance to fix a start only or end only worker.</p>
	`;
	const subject = `${area} attendance, ${date}: ${totals.full_shift} full shift, ${totals.start_only} start only, ${totals.end_only} end only`;
	return { subject, html };
}
