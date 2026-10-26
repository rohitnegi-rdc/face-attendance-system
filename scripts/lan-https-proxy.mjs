import http from 'node:http';
import https from 'node:https';
import { readFileSync } from 'node:fs';

const port = Number(process.env.LAN_HTTPS_PORT || 6103);
const upstreamHost = process.env.UPSTREAM_HOST || 'app';
const upstreamPort = Number(process.env.UPSTREAM_PORT || 3000);
// The app's ORIGIN (when the env file sets one, e.g. the laptop address) makes SvelteKit refuse
// form posts from the phone's address as cross-site. A request whose Origin is this proxy's own
// address is same-origin, so it is passed on with the app's ORIGIN; any other Origin is passed
// unchanged and still refused by the app.
const appOrigin = process.env.ORIGIN || '';

const server = https.createServer(
	{
		key: readFileSync(process.env.TLS_KEY_PATH || '/tls/lan-key.pem'),
		cert: readFileSync(process.env.TLS_CERT_PATH || '/tls/lan-cert.pem')
	},
	(request, response) => {
		const upstream = http.request(
			{
				hostname: upstreamHost,
				port: upstreamPort,
				path: request.url,
				method: request.method,
				headers: {
					...request.headers,
					...(appOrigin && request.headers.origin === `https://${request.headers.host}`
						? { origin: appOrigin }
						: {}),
					host: request.headers.host || `${upstreamHost}:${upstreamPort}`,
					'x-forwarded-proto': 'https',
					'x-forwarded-host': request.headers.host || ''
				}
			},
			(upstreamResponse) => {
				response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
				upstreamResponse.pipe(response);
			}
		);

		upstream.on('error', (error) => {
			console.error('LAN HTTPS proxy upstream error:', error.message);
			if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain' });
			response.end('Attendance application is unavailable.');
		});
		request.pipe(upstream);
	}
);

server.listen(port, '0.0.0.0', () => {
	console.log(`LAN HTTPS proxy listening on https://0.0.0.0:${port}`);
});
