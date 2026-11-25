// The 9 am attendance tracker's subject and HTML, one Area per email (worker/attendanceDigest.js
// builds the data, sendAttendanceDigestEmail in worker/mailer.js sends it). No database or mail here, so
// the unit tests render it directly. Dates and times are written for people, in IST. A pump with
// no one counted is a red row, and the count of them is in red under the summary. The summary puts
// the day beside the month to date; every pump is in one table, with its plant in a column. A pump
// with a missed day request for the day has a line under its row: the reason, the note, and
// whether it waits for the business manager, was approved or was rejected (and why). A pump whose
// shift start was sent away from the pump has a line saying who must approve it or who decided, and
// a table counts, per plant manager, the starts still waiting for their approval. In an Area with
// pump gangs on, a pump has a Gangs line: each gang's headcount there and the other pumps it
// worked at that day.
import { REASON_LABELS } from './regularisationEmail.js';

/** @typedef {{ full_shift: number, start_only: number, end_only: number, workers: number, mtd_workers: number }} Counts */
/**
 * @typedef {{ status: string, reason: string, note: string | null, voice?: boolean, requested_by?: string,
 *   decided_by?: string | null, decision_reason?: string | null, decider?: string | null,
 *   decider_role?: string | null }} Request
 */
/**
 * @typedef {{ status: string, issue: string | null, distance_m: number | null, decided_by?: string | null,
 *   note?: string | null, approvers?: string[] }} Location
 */
/** @typedef {{ name: string | null, plants: string, waiting: number, oldest: string | null }} Approver */
/** @typedef {{ code: number, name: string | null, people: number, held: string | null, also: string[] }} Gang */
/** @typedef {Counts & { pump_code: string, site_name?: string | null, work_status?: string, start_at: string | Date | null, end_at: string | Date | null, regularised?: boolean, request?: Request | null, location?: Location | null, gangs?: Gang[] }} Pump */
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
const AMBER = '#8a5300';
const GREEN = '#1e6b34';

// "Missed day request: Phone dead or broken, "Phone fell in water". Waiting for Asha (business
// manager)." One line, for the row under the pump.
/** @param {Request} r */
export function requestLine(r) {
	const reason = escapeHtml(REASON_LABELS[r.reason] ?? r.reason);
	const note = r.note ? `, &ldquo;${escapeHtml(r.note)}&rdquo;` : '';
	const voice = r.voice ? ', with a voice note in the app' : '';
	const state =
		r.status === 'approved'
			? `<strong style="color:${GREEN}">Approved</strong>${r.decided_by ? ` by ${escapeHtml(r.decided_by)}` : ''}.`
			: r.status === 'rejected'
				? `<strong style="color:${RED}">Rejected</strong>${r.decided_by ? ` by ${escapeHtml(r.decided_by)}` : ''}` +
					(r.decision_reason ? `: ${escapeHtml(r.decision_reason)}.` : '.')
				: `<strong style="color:${AMBER}">Waiting for approval</strong> by ` +
					(r.decider
						? `${escapeHtml(r.decider)}${r.decider_role ? ` (${escapeHtml(r.decider_role)})` : ''}.`
						: 'an admin.');
	return `<strong>Missed day request:</strong> ${reason}${note}${voice}. ${state}`;
}

// Why the start needs approval, in the words of locationIssueText (src/lib/server/locationCheck.ts).
/** @param {string | null} issue @param {number | null} distance */
export function locationIssueWords(issue, distance) {
	switch (issue) {
		case 'too_far':
			return `the operator was ${distance ?? '?'} m from the pump (allowed: 100 m)`;
		case 'no_phone_location':
			return "the operator's phone did not share its location";
		case 'no_pump_gps':
			return 'no GPS position had been received for the pump';
		case 'stale_pump_gps':
			return "the pump's GPS position was too old to check the distance";
		default:
			return 'the location could not be checked';
	}
}

// "Shift start away from the pump: the operator was 340 m from the pump (allowed: 100 m). Waiting
// for approval by Ravi (plant manager)." One line, under the pump.
/** @param {Location} l */
export function locationLine(l) {
	const why = escapeHtml(locationIssueWords(l.issue, l.distance_m));
	const approvers = l.approvers?.length
		? `${escapeHtml(l.approvers.join(', '))} (plant manager${l.approvers.length > 1 ? 's' : ''})`
		: "the area's monitors (no plant manager)";
	const state =
		l.status === 'approved'
			? `<strong style="color:${GREEN}">Approved</strong>${l.decided_by ? ` by ${escapeHtml(l.decided_by)}` : ''}.`
			: l.status === 'rejected'
				? `<strong style="color:${RED}">Rejected</strong>${l.decided_by ? ` by ${escapeHtml(l.decided_by)}` : ''}` +
					(l.note ? `: ${escapeHtml(l.note)}.` : '.')
				: `<strong style="color:${AMBER}">Waiting for approval</strong> by ${approvers}. Not counted until approved.`;
	return `<strong>Shift start away from the pump:</strong> ${why}. ${state}`;
}

// "Gangs: Gang 3, 7 people, also at BGPUMP07 that day. Gang 5 (Raju), 4 people, shift start away
// from the pump: waiting for approval." One line under the pump (pump gangs on only).
/** @param {Gang[]} gangs */
export function gangLine(gangs) {
	const parts = gangs.map((g) => {
		const name = `Gang ${g.code}${g.name ? ` (${escapeHtml(g.name)})` : ''}`;
		const people = `${g.people} ${g.people === 1 ? 'person' : 'people'}`;
		const also = g.also.length ? `, also at ${escapeHtml(g.also.join(', '))} that day` : '';
		const held =
			g.held === 'pending'
				? `, <strong style="color:${AMBER}">shift start away from the pump: waiting for approval</strong>`
				: g.held === 'rejected'
					? `, <strong style="color:${RED}">shift start location rejected</strong>`
					: '';
		return `${name}, ${people}${also}${held}.`;
	});
	return `<strong>Gangs:</strong> ${parts.join(' ')}`;
}

// The 9 am attendance email (worker/attendanceDigest.js): subject and HTML for one recipient.
/**
 * @param {{ area: string, day: string, areas: Area[], totals: Counts & { pumps: number, marked: number },
 *   mtd: MonthToDate, locationCheck?: boolean, approvals?: Approver[] }} message
 * @returns {{ subject: string, html: string }}
 */
export function renderAttendanceDigest({
	area,
	day,
	areas,
	totals,
	mtd,
	locationCheck = false,
	approvals = []
}) {
	const date = humanDay(day);
	const hasGangs = areas.some((a) => a.plants.some((pl) => pl.pumps.some((p) => p.gangs?.length)));
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
		// Red: nobody counted at an Active pump. An Idle pump has no work that day (2026-11-25).
		/** @param {Pump} p */
		const isRed = (p) => !p.workers && p.work_status !== 'idle';
		// The pump code, and the site it worked at that day under it.
		/** @param {Pump} p */
		const pumpCell = (p) =>
			`<td ${TD}><strong>${escapeHtml(p.pump_code)}</strong>` +
			(p.site_name ? `<br><span style="font-size:12px">${escapeHtml(p.site_name)}</span>` : '') +
			'</td>';
		/** @param {Pump} p */
		const pumpRow = (p) =>
			!p.workers && p.work_status === 'idle'
				? `<tr>${plantCell}${pumpCell(p)}` +
					`<td ${TD} colspan="2">Idle, no work</td>${counts(p)}</tr>`
				: p.workers && p.regularised && !p.start_at && !p.end_at
					? `<tr>${plantCell}${pumpCell(p)}` +
						`<td ${TD} colspan="2"><strong>Regularised</strong> (missed day, approved)</td>${counts(p)}</tr>`
					: p.workers
						? `<tr>${plantCell}${pumpCell(p)}` +
							`<td ${TD}>${p.start_at ? istTime(p.start_at) : '<strong>No start photo</strong>'}</td>` +
							`<td ${TD}>${p.end_at ? istTime(p.end_at) : '<strong>No end photo</strong>'}</td>${counts(p)}</tr>`
						: `<tr ${RED_ROW}>${plantCell}${pumpCell(p)}` +
							`<td ${TD} colspan="2"><strong>No attendance</strong></td>${counts(p, true)}</tr>`;
		// The request line sits under its pump, on the pump row's background.
		/** @param {Pump} p */
		const requestRow = (p) =>
			p.request
				? `<tr${isRed(p) ? ' style="background:#fdecea"' : ''}><td ${TD}></td>` +
					`<td ${TD} colspan="8" data-request="${escapeHtml(p.request.status)}">${requestLine(p.request)}</td></tr>`
				: '';
		/** @param {Pump} p */
		const locationRow = (p) =>
			p.location
				? `<tr${isRed(p) ? ' style="background:#fdecea"' : ''}><td ${TD}></td>` +
					`<td ${TD} colspan="8" data-location="${escapeHtml(p.location.status)}">${locationLine(p.location)}</td></tr>`
				: '';
		/** @param {Pump} p */
		const gangRow = (p) =>
			p.gangs?.length
				? `<tr${isRed(p) ? ' style="background:#fdecea"' : ''}><td ${TD}></td>` +
					`<td ${TD} colspan="8" data-gangs="${p.gangs.length}">${gangLine(p.gangs)}</td></tr>`
				: '';
		const rows = plant.pumps
			.map((p) => pumpRow(p) + gangRow(p) + locationRow(p) + requestRow(p))
			.join('');
		const total =
			plant.pumps.length > 1
				? `<tr${plant.totals.workers || !plant.pumps.some(isRed) ? '' : ` ${RED_ROW}`}><td ${TD} colspan="4"><strong>${escapeHtml(plant.name)} total</strong></td>${counts(plant.totals, true)}</tr>`
				: '';
		return rows + total;
	};
	// One empty row between plants (the 9 columns of the pump table).
	const body = areas
		.flatMap((a) => a.plants.map(plantRows))
		.join('<tr><td colspan="9" style="height:18px;padding:0">&nbsp;</td></tr>');
	const zero = areas
		.flatMap((a) => a.plants.flatMap((pl) => pl.pumps))
		.filter((p) => !p.workers && p.work_status !== 'idle').length;
	const zeroLine = zero
		? `<p style="color:${RED};margin:8px 0 0"><strong>${zero} ${zero === 1 ? 'pump' : 'pumps'} with no attendance</strong>, in red below.</p>`
		: '';
	// Shift starts away from the pump still waiting, per plant manager, when the email goes out.
	const waitingTotal = approvals.reduce((n, a) => n + a.waiting, 0);
	const showApprovals = approvals.length > 0 && (locationCheck || waitingTotal > 0);
	const approvalRows = approvals
		.map(
			(a) =>
				`<tr${a.waiting ? ` ${RED_ROW}` : ''} data-approver="${escapeHtml(a.name ?? '')}">` +
				`<td ${TD}>${a.name ? escapeHtml(a.name) : '<strong>No plant manager</strong>'}</td>` +
				`<td ${TD}>${escapeHtml(a.plants)}</td>` +
				`<td ${NUM}><strong>${a.waiting}</strong></td>` +
				`<td ${TD}>${a.oldest ? humanDay(a.oldest) : ''}</td></tr>`
		)
		.join('');
	const approvalsBlock = showApprovals
		? `<p style="margin:16px 0 6px"><strong>Shift starts away from the pump, waiting for approval</strong></p>
			<p style="margin:0 0 6px;font-size:13px${waitingTotal ? `;color:${RED}` : ''}" data-approvals-total="${waitingTotal}">${
				waitingTotal
					? `<strong>${waitingTotal} ${waitingTotal === 1 ? 'shift start waits' : 'shift starts wait'}</strong> for the plant manager's approval. They are not counted until approved.`
					: 'Nothing is waiting for approval.'
			}</p>
			<table cellspacing="0" style="border-collapse:collapse">
				<tr><th ${TH}>Plant manager</th><th ${TH}>Plants</th><th ${RIGHT_TH}>Waiting</th><th ${TH}>Oldest</th></tr>
				${approvalRows}
			</table>`
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
		${approvalsBlock}
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
			<li><strong>Missed day request:</strong> the pump asked for the day to be counted. The plant's business manager (or, where there is none, its plant manager) approves or rejects it from their email or in Face Attendance.</li>
			<li><strong>Shift start away from the pump:</strong> the start photo was sent more than 100 m from the pump, or its location could not be checked. The plant manager approves or rejects it on the Approvals page in Face Attendance; it is not counted until approved. <strong>Waiting</strong> counts every start still waiting when this email was sent, whatever its day.</li>
			${hasGangs ? '<li><strong>Gangs:</strong> a gang is a crew recognised from faces that can move between pumps. Its number is the workers of that gang counted at that pump; a worker counts once a day.</li>' : ''}
			<li>Only pumps that are Active or Idle are listed.</li>
			<li>To correct a Start only or End only worker, open Attendance in Face Attendance.</li>
		</ul>
	`;
	const subject = `${area} attendance, ${date}: ${totals.full_shift} full shift, ${totals.start_only} start only, ${totals.end_only} end only`;
	return { subject, html };
}
