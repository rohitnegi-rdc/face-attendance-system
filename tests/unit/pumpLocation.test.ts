// Unit tests for asking a pump phone's position while uploading ($lib/pumpLocation).
// Run: npm run test:unit, or alone: npx tsx --test tests/unit/pumpLocation.test.ts (no database).
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { askForPosition, MAX_LOCATION_ASKS } from '../../src/lib/pumpLocation';

const POSITION = { coords: { latitude: 19.06, longitude: 72.92, accuracy: 10 } };
const REFUSED = { code: 1 };
const TIMED_OUT = { code: 3 };

// A phone that gives these answers in turn, counting how often it was asked.
function phone(...answers: object[]) {
	const asked = { count: 0 };
	const geolocation = {
		getCurrentPosition(success: (p: any) => void, failure?: ((e: any) => void) | null) {
			const answer = answers[Math.min(asked.count++, answers.length - 1)];
			if ('coords' in answer) success(answer);
			else failure?.(answer);
		}
	};
	return { geolocation, asked };
}
const state = (value: PermissionState | null) => async () => value;

describe('askForPosition', () => {
	test('an allowed phone answers the first time and is not asked again', async () => {
		const { geolocation, asked } = phone(POSITION);
		assert.equal(await askForPosition(geolocation, state('granted')), POSITION);
		assert.equal(asked.count, 1);
	});

	test('a closed question is asked again until it is allowed', async () => {
		const { geolocation, asked } = phone(REFUSED, REFUSED, POSITION);
		assert.equal(await askForPosition(geolocation, state('prompt')), POSITION);
		assert.equal(asked.count, 3);
	});

	test('a question that stays closed gives up for this upload, the photo still goes', async () => {
		const { geolocation, asked } = phone(REFUSED);
		assert.equal(await askForPosition(geolocation, state('prompt')), null);
		assert.equal(asked.count, MAX_LOCATION_ASKS);
	});

	test('a blocked browser cannot show the question, so it is not retried', async () => {
		const { geolocation, asked } = phone(REFUSED);
		assert.equal(await askForPosition(geolocation, state('denied')), null);
		assert.equal(asked.count, 1);
	});

	test('where the permission cannot be read it still asks again', async () => {
		const { geolocation, asked } = phone(REFUSED, POSITION);
		assert.equal(await askForPosition(geolocation, state(null)), POSITION);
		assert.equal(asked.count, 2);
	});

	test('allowed but no position does not ask again', async () => {
		const { geolocation, asked } = phone(TIMED_OUT);
		assert.equal(await askForPosition(geolocation, state('granted')), null);
		assert.equal(asked.count, 1);
	});

	test('a phone without location does not stop the photo', async () => {
		assert.equal(await askForPosition(undefined, state(null)), null);
	});
});
