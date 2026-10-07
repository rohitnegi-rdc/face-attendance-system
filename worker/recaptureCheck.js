const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash-lite';
const GEMINI_TIMEOUT_MS = Number(process.env.GEMINI_TIMEOUT_MS ?? 20000);
export const RECAPTURE_BLOCK_CONFIDENCE = Number(process.env.RECAPTURE_BLOCK_CONFIDENCE ?? 0.85);

const PROMPT = `You are a fraud check for a workforce attendance app. Workers at a concrete pump site must take a LIVE photo of the real people present, using the phone camera.

Decide whether this photo is a RECAPTURE: a photo taken of another image instead of the real scene. Recaptures include a photo of a laptop, monitor, TV, tablet or phone screen, or a photo of a printed photo or paper.

Signs of a recapture: screen bezel or frame edges, keyboard, taskbar, browser or app UI, mouse cursor, moire or wavy line patterns, visible pixel grid, screen glare or reflections, unnatural flatness, the whole scene sitting inside a rectangle, paper edges, printing dots.

A genuine photo can be low quality, dark, blurry, outdoors, crowded or oddly framed. That alone is NOT a recapture. Only answer is_recapture=true when you see concrete evidence.

Return JSON only.`;

const RESPONSE_SCHEMA = {
	type: 'OBJECT',
	properties: {
		is_recapture: { type: 'BOOLEAN' },
		recapture_type: { type: 'STRING', enum: ['none', 'screen', 'print', 'other'] },
		confidence: { type: 'NUMBER' },
		reason: { type: 'STRING' }
	},
	required: ['is_recapture', 'recapture_type', 'confidence', 'reason']
};

export function recaptureCheckEnabled() {
	return Boolean(GEMINI_API_KEY);
}

// Never throws: an API failure returns status 'error' and must not block the pump.
export async function checkRecapture(photoBuffer, mimeType = 'image/jpeg') {
	if (!GEMINI_API_KEY) return { status: 'disabled', model: GEMINI_MODEL };
	const started = Date.now();
	try {
		const res = await fetch(
			`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(GEMINI_MODEL)}:generateContent`,
			{
				method: 'POST',
				headers: { 'content-type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
				body: JSON.stringify({
					contents: [
						{
							role: 'user',
							parts: [
								{ inline_data: { mime_type: mimeType, data: photoBuffer.toString('base64') } },
								{ text: PROMPT }
							]
						}
					],
					generationConfig: {
						temperature: 0,
						responseMimeType: 'application/json',
						responseSchema: RESPONSE_SCHEMA
					}
				}),
				signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS)
			}
		);
		const latencyMs = Date.now() - started;
		if (!res.ok) {
			const body = (await res.text()).slice(0, 300);
			return {
				status: 'error',
				model: GEMINI_MODEL,
				latency_ms: latencyMs,
				error: `HTTP ${res.status}: ${body}`
			};
		}
		const data = await res.json();
		const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
		if (!text) {
			return {
				status: 'error',
				model: GEMINI_MODEL,
				latency_ms: latencyMs,
				error: 'empty response'
			};
		}
		const parsed = JSON.parse(text);
		const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
		const isRecapture = parsed.is_recapture === true;
		return {
			status: isRecapture && confidence >= RECAPTURE_BLOCK_CONFIDENCE ? 'recapture' : 'genuine',
			is_recapture: isRecapture,
			recapture_type: String(parsed.recapture_type || 'none'),
			confidence,
			reason: String(parsed.reason || '').slice(0, 500),
			model: GEMINI_MODEL,
			latency_ms: latencyMs
		};
	} catch (err) {
		return {
			status: 'error',
			model: GEMINI_MODEL,
			latency_ms: Date.now() - started,
			error: String(err?.message || err)
		};
	}
}
