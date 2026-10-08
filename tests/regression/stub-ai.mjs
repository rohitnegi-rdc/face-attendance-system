// Stand-in for ai-service in the regression suite. It returns fixed face vectors so tests decide
// exactly who is in a photo, instead of depending on the ML model (that is tested by eval:*).
//
// A test photo carries a marker `STUBPHOTO:<id>`. Before submitting it, the test registers what
// the photo contains:
//   POST /__register {"photo_id": "...", "faces": [{"identity": "W1", "similarity": 0.9}], "delay_ms": 0}
//   POST /__fail     {"photo_id": "..."}   -> extraction returns HTTP 500 for that photo
// Each identity maps to a fixed random 512-dim unit vector. `similarity` (default 1) returns a
// vector with exactly that cosine similarity to the identity's vector. Unregistered photos have
// no faces. Response shape matches POST /internal/face/extract in ai-service/main.py.
import http from 'node:http';
import crypto from 'node:crypto';

const PORT = Number(process.env.STUB_AI_PORT ?? 58000);
const DIM = 512;
const photos = new Map();
const failing = new Set();

function seededRandom(seed) {
	let state = crypto.createHash('sha256').update(seed).digest().readUInt32LE(0);
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296 - 0.5;
	};
}

function normalize(vector) {
	const length = Math.hypot(...vector);
	return vector.map((value) => value / length);
}

function randomUnit(seed) {
	const next = seededRandom(seed);
	return normalize(Array.from({ length: DIM }, next));
}

function embedding(identity, similarity = 1) {
	const base = randomUnit(`identity:${identity}`);
	if (similarity >= 1) return base;
	// Gram-Schmidt: a unit vector orthogonal to base, then mix to hit the exact cosine.
	const noise = randomUnit(`noise:${identity}:${similarity}`);
	const dot = noise.reduce((sum, value, index) => sum + value * base[index], 0);
	const orthogonal = normalize(noise.map((value, index) => value - dot * base[index]));
	const rest = Math.sqrt(1 - similarity * similarity);
	return base.map((value, index) => similarity * value + rest * orthogonal[index]);
}

function readBody(request) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		request.on('data', (chunk) => chunks.push(chunk));
		request.on('end', () => resolve(Buffer.concat(chunks)));
		request.on('error', reject);
	});
}

function send(response, status, body) {
	response.writeHead(status, { 'content-type': 'application/json' });
	response.end(JSON.stringify(body));
}

const server = http.createServer(async (request, response) => {
	try {
		if (request.method === 'GET' && request.url === '/health') {
			return send(response, 200, {
				status: 'ok',
				model_loaded: true,
				anti_spoof_enabled: false,
				anti_spoof_ready: false
			});
		}
		const body = await readBody(request);
		if (request.method === 'POST' && request.url === '/__register') {
			const { photo_id: photoId, faces = [], delay_ms: delayMs = 0 } = JSON.parse(String(body));
			photos.set(photoId, { faces, delayMs });
			return send(response, 200, { ok: true });
		}
		if (request.method === 'POST' && request.url === '/__fail') {
			failing.add(JSON.parse(String(body)).photo_id);
			return send(response, 200, { ok: true });
		}
		if (request.method === 'POST' && request.url === '/internal/face/extract') {
			const photoId = body.toString('latin1').match(/STUBPHOTO:([A-Za-z0-9_-]+)/)?.[1];
			if (photoId && failing.has(photoId)) return send(response, 500, { detail: 'stub failure' });
			const registered = (photoId && photos.get(photoId)) || { faces: [], delayMs: 0 };
			if (registered.delayMs) await new Promise((r) => setTimeout(r, registered.delayMs));
			return send(response, 200, {
				faces: registered.faces.map((face, index) => ({
					bbox: [index * 10, 0, index * 10 + 50, 50],
					embedding: embedding(face.identity, face.similarity ?? 1),
					crop_base64: '',
					liveness_status: 'unverified',
					liveness_quality: 'insufficient'
				})),
				image_preprocessing: { stub: true },
				whole_image_liveness: null
			});
		}
		send(response, 404, { detail: 'not found' });
	} catch (error) {
		send(response, 500, { detail: String(error) });
	}
});

server.listen(PORT, '127.0.0.1', () => {
	console.log(`stub ai-service listening on http://127.0.0.1:${PORT}`);
});
