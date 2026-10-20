// RPT: the attendance report workbook (admin and plant-manager export). Two working days at
// one pump: yesterday three workers do a full shift; today one does a full shift, one leaves
// before the end photo and one does not come. The report must say exactly that, per person,
// and a plant manager must only get their own plant.
import { test, expect, type APIRequestContext } from '@playwright/test';
import ExcelJS from 'exceljs';
import {
	anonymous,
	createAdmin,
	createArea,
	createPlantManager,
	createPump,
	db,
	login,
	recordSession,
	shiftBack
} from './helpers';

async function workbook(context: APIRequestContext, path: string) {
	const response = await context.get(path);
	expect(response.status(), await response.text().catch(() => '')).toBe(200);
	expect(response.headers()['content-type']).toContain('spreadsheetml');
	const book = new ExcelJS.Workbook();
	await book.xlsx.load((await response.body()) as any);
	return book;
}

function rows(book: ExcelJS.Workbook, sheet: string) {
	const ws = book.getWorksheet(sheet)!;
	const header = (ws.getRow(1).values as any[]).slice(1);
	const out: Record<string, any>[] = [];
	ws.eachRow((row, i) => {
		if (i === 1) return;
		const values = (row.values as any[]).slice(1);
		out.push(Object.fromEntries(header.map((h, c) => [h, values[c]])));
	});
	return out;
}

function tally(list: Record<string, any>[], key: (r: Record<string, any>) => string) {
	const counts: Record<string, number> = {};
	for (const r of list) counts[key(r)] = (counts[key(r)] ?? 0) + 1;
	return counts;
}

test('RPT-05 plant manager report: per-person days, absences and only their own plant', async () => {
	const own = await createArea();
	const other = await createArea();
	const pump = await createPump(own.plantId);
	const otherPump = await createPump(other.plantId);
	const manager = await login((await createPlantManager(own.plantId)).email);
	const context = await login(pump.email);

	// Yesterday: A, B and C do a full shift.
	const yesterdayStart = await recordSession(context, ['RPT05-A', 'RPT05-B', 'RPT05-C']);
	await shiftBack(yesterdayStart, 600, true);
	await recordSession(context, ['RPT05-A', 'RPT05-B', 'RPT05-C']);
	// Today: A full shift, B only in the start photo, C absent.
	const todayStart = await recordSession(context, ['RPT05-A', 'RPT05-B']);
	await shiftBack(todayStart, 600);
	await recordSession(context, ['RPT05-A']);
	// Another plant's pump also works today; the manager must not see it.
	await recordSession(await login(otherPump.email), ['RPT05-OTHER']);

	const book = await workbook(manager, '/plant-manager/attendance/export');
	const plantName = (await db.query('SELECT name FROM plants WHERE id = $1', [own.plantId])).rows[0]
		.name;
	expect(String(book.getWorksheet('Summary')!.getCell('A2').value)).toContain(plantName);

	const daily = rows(book, 'Daily');
	expect(new Set(daily.map((r) => r.Pump))).toEqual(new Set([pump.code]));
	const byDay = tally(
		daily,
		(r) => `${(r.Date as Date).toISOString().slice(0, 10)} ${r['Day result']}`
	);
	const [today, yesterday] = [
		...new Set(daily.map((r) => (r.Date as Date).toISOString().slice(0, 10)))
	]
		.sort()
		.reverse();
	expect(byDay).toEqual({
		[`${yesterday} Full shift`]: 3,
		[`${today} Full shift`]: 1,
		[`${today} Start only`]: 1,
		[`${today} Absent`]: 1
	});
	// Photo times and hours are filled for the full shift.
	const fullToday = daily.find(
		(r) => (r.Date as Date).toISOString().startsWith(today) && r['Day result'] === 'Full shift'
	)!;
	expect(fullToday['Start photo time']).toMatch(/^\d{2}:\d{2}$/);
	expect(fullToday['Shift hours']).toBeGreaterThanOrEqual(9);

	const people = rows(book, 'People');
	expect(people).toHaveLength(3);
	expect(people.map((p) => p['Expected days'])).toEqual([2, 2, 2]);
	expect(people.map((p) => p['Full shift']).sort()).toEqual([1, 1, 2]);
	expect(people.map((p) => p['Start only'] + p.Absent).sort()).toEqual([0, 1, 1]);

	const shifts = rows(book, 'Shifts');
	expect(shifts).toHaveLength(4);
	expect(shifts.filter((s) => s['How the shift ended'] === 'Full shift')).toHaveLength(2);

	// The admin report for the same pump tells the same story.
	const admin = await login((await createAdmin()).email);
	const adminDaily = rows(
		await workbook(admin, `/api/admin/attendance/export?pump=${pump.id}`),
		'Daily'
	);
	expect(tally(adminDaily, (r) => r['Day result'])).toEqual(tally(daily, (r) => r['Day result']));
});

test('RPT-05b only a plant manager can download the plant-manager report', async () => {
	const { plantId } = await createArea();
	const pump = await createPump(plantId);
	const anon = await anonymous();
	expect((await anon.get('/plant-manager/attendance/export', { maxRedirects: 0 })).status()).toBe(
		302
	);
	expect((await (await login(pump.email)).get('/plant-manager/attendance/export')).status()).toBe(
		403
	);
	const admin = await login((await createAdmin()).email);
	expect((await admin.get('/plant-manager/attendance/export')).status()).toBe(403);
});
