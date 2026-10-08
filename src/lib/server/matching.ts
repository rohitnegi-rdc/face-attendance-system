// Face match threshold (cosine similarity), shared by the app. worker/index.js reads the same env
// var with the same default (it cannot import this file), so keep the two in sync.
//
// Default 0.28 comes from the golden small-group evaluation (2026-08-11, 50 cases, 543 faces,
// test-output/evaluations/20260811-151623__golden-small-group__golden-small-groups-v1/
// threshold-sweep.csv): 0.26–0.28 is the lowest range with zero false matches and zero
// cross-pump false duplicates, at 98.3% attendance accuracy and 100% fraud-group recall.
// 0.68 scored 60.6% attendance accuracy, 10% match recall and missed every fraud group.
// Re-run `npm run eval:golden:run` before changing it.
export const DEFAULT_FACE_MATCH_THRESHOLD = 0.28;

export function faceMatchThreshold(): number {
	const value = Number(process.env.FACE_MATCH_THRESHOLD?.trim() || NaN);
	return value > 0 && value < 1 ? value : DEFAULT_FACE_MATCH_THRESHOLD;
}
