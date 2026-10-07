import type { RequestHandler } from './$types';
import { query } from '$lib/server/db';

// Dev-only default password shared by every vendor login (see creds.md / csvImport.ts) —
// there is no per-vendor plaintext password to recover, since only the bcrypt hash is stored.
const DEFAULT_PASSWORD = 'Test1234!';

function csvField(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

export const GET: RequestHandler = async () => {
	const vendors = await query<any>(
		`SELECT v.name, a.name AS area_name, v.email
		 FROM vendors v
		 LEFT JOIN areas a ON a.id = v.area_id
		 ORDER BY v.name, a.name NULLS FIRST`
	);

	const lines = [
		['Vendor Name', 'Area', 'Login Email', 'Password'].map(csvField).join(','),
		...vendors.map((v: any) =>
			[v.name, v.area_name ?? '', v.email, DEFAULT_PASSWORD].map(csvField).join(',')
		)
	];

	return new Response(lines.join('\r\n') + '\r\n', {
		headers: {
			'Content-Type': 'text/csv; charset=utf-8',
			'Content-Disposition': 'attachment; filename="vendor-login-credentials.csv"'
		}
	});
};
