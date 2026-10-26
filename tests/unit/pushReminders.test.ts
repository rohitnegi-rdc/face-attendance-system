// Unit tests for the reminders flow on a pump phone ($lib/pushReminders, PumpReminders.svelte),
// Chrome's recommended order: sign in, an Enable notifications button with a short explanation,
// the tap opens Chrome's question, and the subscription is saved only once allowed.
// Run: npm run test:unit, or alone: npx tsx --test tests/unit/pushReminders.test.ts (no database).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import {
	enable,
	holdsGuide,
	keyBytes,
	openingState,
	resave,
	type Phone
} from '../../src/lib/pushReminders';

const ANDROID: Phone = {
	secure: true,
	supported: true,
	iphone: false,
	permission: 'default',
	notNow: false
};

describe('when the pump screen opens', () => {
	test('a phone that has not answered sees the Enable notifications sheet, before the guide', () => {
		assert.equal(openingState(ANDROID), 'ask');
		assert.equal(holdsGuide('ask'), true);
		assert.equal(holdsGuide('asking'), true);
	});

	test('an allowed phone sees nothing and quietly saves its subscription again', () => {
		const allowed = { ...ANDROID, permission: 'granted' as const };
		assert.equal(openingState(allowed), 'hidden');
		assert.equal(resave(allowed), true);
		assert.equal(holdsGuide('hidden'), false);
	});

	test('nothing is saved for a phone that has not allowed', () => {
		assert.equal(resave(ANDROID), false);
		assert.equal(resave({ ...ANDROID, permission: 'denied' }), false);
	});

	test('a blocked phone gets the settings card, which does not hold the guide', () => {
		assert.equal(openingState({ ...ANDROID, permission: 'denied' }), 'blocked');
		assert.equal(holdsGuide('blocked'), false);
	});

	test('Not now hides the sheet for the rest of the visit', () => {
		assert.equal(openingState({ ...ANDROID, notNow: true }), 'hidden');
	});

	test('http, an iPhone browser tab and other browsers each say why there are no reminders', () => {
		assert.equal(openingState({ ...ANDROID, secure: false }), 'insecure');
		assert.equal(openingState({ ...ANDROID, supported: false, iphone: true }), 'iphone');
		assert.equal(openingState({ ...ANDROID, supported: false }), 'unsupported');
		for (const state of ['insecure', 'iphone', 'unsupported'] as const) {
			assert.equal(holdsGuide(state), false);
		}
	});
});

describe('the Enable notifications tap', () => {
	function phone(answer: NotificationPermission | Error, saveFails = false) {
		const calls = { asked: 0, saved: 0 };
		return {
			calls,
			ask: async () => {
				calls.asked++;
				if (answer instanceof Error) throw answer;
				return answer;
			},
			save: async () => {
				calls.saved++;
				if (saveFails) throw new Error('offline');
			}
		};
	}

	test('Allow: Chrome asks once, then the subscription is saved and reminders are on', async () => {
		const p = phone('granted');
		assert.equal(await enable(p.ask, p.save), 'on');
		assert.deepEqual(p.calls, { asked: 1, saved: 1 });
	});

	test('Block: nothing is saved and the card points to the settings', async () => {
		const p = phone('denied');
		assert.equal(await enable(p.ask, p.save), 'blocked');
		assert.equal(p.calls.saved, 0);
	});

	test('closed without an answer: nothing saved, the button stays to try again', async () => {
		const p = phone('default');
		assert.equal(await enable(p.ask, p.save), 'ask');
		assert.equal(p.calls.saved, 0);
	});

	test('a browser that throws on the question counts as no answer', async () => {
		const p = phone(new Error('not allowed'));
		assert.equal(await enable(p.ask, p.save), 'ask');
		assert.equal(p.calls.saved, 0);
	});

	test('allowed but the save fails (no internet): says so instead of claiming reminders are on', async () => {
		const p = phone('granted', true);
		assert.equal(await enable(p.ask, p.save), 'failed');
	});
});

test('the server key turns into the bytes PushManager wants (base64url, no padding)', () => {
	const bytes = new Uint8Array([4, 255, 254, 62, 63, 0, 128]);
	const base64url = Buffer.from(bytes).toString('base64url');
	assert.ok(!base64url.includes('='));
	assert.deepEqual(keyBytes(base64url), bytes);
});
