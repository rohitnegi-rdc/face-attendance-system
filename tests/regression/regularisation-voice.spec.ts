// REG-20: on the pump's "why" step the text box is there from the start (optional for a listed
// reason, needed for Something else without a voice note), and the voice note is tap to start,
// tap to stop. Holding failed on phones: the microphone prompt took the press, so the stop came
// before the recording started (2026-11-17). A refused microphone says so and the box takes over.
import { expect, test, type Page } from '@playwright/test';
import { db } from './helpers';
import {
	addDay,
	crewPump,
	daysAgo,
	noSidewaysScroll,
	showMonth,
	signIn
} from './regularisationHelpers';

// A fake microphone: a tone through Web Audio, recorded by the browser's real MediaRecorder.
async function fakeMic(page: Page, works = true) {
	await page.addInitScript((ok) => {
		navigator.mediaDevices.getUserMedia = async () => {
			if (!ok) throw new DOMException('Permission denied', 'NotAllowedError');
			const ctx = new AudioContext();
			const tone = ctx.createOscillator();
			const out = ctx.createMediaStreamDestination();
			tone.connect(out);
			tone.start();
			return out.stream;
		};
	}, works);
}

async function openWhy(page: Page) {
	const { pump, workers } = await crewPump();
	const day = daysAgo(3);
	await addDay(pump.id, day, [{ id: workers[0], start: true, end: false }]);
	await page.setViewportSize({ width: 390, height: 844 });
	await signIn(page, pump.email);
	await page.getByTestId('reg-start').click();
	await expect(page.getByTestId('reg-calendar')).toBeVisible();
	await (await showMonth(page, day)).click();
	await page.getByTestId('reg-cal-apply').click();
	return { pump, day };
}

async function sendRest(page: Page) {
	await page.getByTestId('reg-next').click();
	await page.getByTestId('reg-next').click();
	await page.getByTestId('reg-send').click();
	await expect(page.getByTestId('reg-sent')).toBeVisible();
}

const stored = async (pumpId: string, day: string) =>
	(
		await db.query(
			`SELECT reason, note, voice_path, voice_type FROM regularisations
			 WHERE pump_id = $1 AND day = $2 AND status = 'pending'`,
			[pumpId, day]
		)
	).rows[0];

test('REG-20 the operator taps to record a voice note and writes in the box shown from the start', async ({
	page
}) => {
	await fakeMic(page);
	const { pump, day } = await openWhy(page);
	const box = page.getByTestId('reg-note');
	await expect(box).toBeVisible(); // before any reason is picked

	const mic = page.getByTestId('reg-reason-other');
	await mic.click();
	await expect(mic).toContainText('tap to stop');
	await expect(page.getByTestId('reg-next')).toBeDisabled(); // not while recording
	await page.waitForTimeout(1500);
	await mic.click();
	await expect(page.getByTestId('reg-voice-preview')).toBeVisible();
	await box.fill('Phone screen broke at the site');
	await noSidewaysScroll(page);
	// Nothing in the sheet reaches past the screen (the voice preview used to push it out).
	const right = await page
		.getByTestId('reg-sheet-body')
		.evaluate((body) =>
			Math.max(...[...body.querySelectorAll('*')].map((e) => e.getBoundingClientRect().right))
		);
	expect(right).toBeLessThanOrEqual(390);
	await page.screenshot({ path: 'artifacts/deep-build/screenshots/reg-voice-mobile.png' });
	await sendRest(page);

	const row = await stored(pump.id, day);
	expect(row.reason).toBe('other');
	expect(row.note).toBe('Phone screen broke at the site');
	expect(row.voice_path).toBeTruthy();
	expect(row.voice_type).toMatch(/^audio\//);
});

test('REG-20 a note written for a listed reason is sent with it', async ({ page }) => {
	const { pump, day } = await openWhy(page);
	await page.getByTestId('reg-reason-phone_problem').click();
	await page.getByTestId('reg-note').fill('Battery died in the afternoon');
	await sendRest(page);
	const row = await stored(pump.id, day);
	expect(row.reason).toBe('phone_problem');
	expect(row.note).toBe('Battery died in the afternoon');
	expect(row.voice_path).toBeNull();
});

test('REG-20 a refused microphone says so and the written note is enough', async ({ page }) => {
	await fakeMic(page, false);
	const { pump, day } = await openWhy(page);
	await page.getByTestId('reg-reason-other').click();
	await expect(page.getByTestId('reg-mic-off')).toBeVisible();
	await expect(page.getByTestId('reg-next')).toBeDisabled(); // Something else needs a word
	await page.getByTestId('reg-note').fill('Mic blocked, wrote it instead');
	await sendRest(page);
	const row = await stored(pump.id, day);
	expect(row.reason).toBe('other');
	expect(row.note).toBe('Mic blocked, wrote it instead');
});
