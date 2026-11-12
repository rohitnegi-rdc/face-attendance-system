// Words for regularisations shown in the browser (the server has the same in
// worker/regularisationEmail.js and src/lib/server/regularisation.ts).
export const REASON_TEXT: Record<string, { hi: string; en: string; icon: string }> = {
	no_network: { hi: 'नेटवर्क नहीं था', en: 'No network', icon: '📶' },
	phone_problem: { hi: 'फ़ोन बंद या ख़राब', en: 'Phone dead or broken', icon: '🔋' },
	app_problem: { hi: 'ऐप नहीं चला', en: 'App did not work', icon: '📱' },
	forgot: { hi: 'भूल गए', en: 'Forgot', icon: '🤔' },
	other: { hi: 'कुछ और', en: 'Something else', icon: '🎤' }
};

export const REJECT_TEXT: Record<string, string> = {
	not_believable: 'The reason is not believable',
	wrong_crew: 'The workers listed are not right',
	pump_not_working: 'The pump was not working that day',
	other: 'Other (write why)'
};

const WEEK_HI = ['रविवार', 'सोमवार', 'मंगलवार', 'बुधवार', 'गुरुवार', 'शुक्रवार', 'शनिवार'];
const WEEK_EN = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTH_HI = [
	'जनवरी',
	'फ़रवरी',
	'मार्च',
	'अप्रैल',
	'मई',
	'जून',
	'जुलाई',
	'अगस्त',
	'सितंबर',
	'अक्टूबर',
	'नवंबर',
	'दिसंबर'
];
const MONTH_EN = [
	'Jan',
	'Feb',
	'Mar',
	'Apr',
	'May',
	'Jun',
	'Jul',
	'Aug',
	'Sep',
	'Oct',
	'Nov',
	'Dec'
];

// Calendar columns, Monday first like the week counts on the Pump status page.
export const WEEK_COLUMNS = {
	hi: ['सोम', 'मंगल', 'बुध', 'गुरु', 'शुक्र', 'शनि', 'रवि'],
	en: ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']
};

export function dayText(key: string) {
	const [y, m, d] = key.split('-').map(Number);
	const w = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
	return {
		hi: `${WEEK_HI[w]}, ${d} ${MONTH_HI[m - 1]}`,
		en: `${WEEK_EN[w]}, ${d} ${MONTH_EN[m - 1]} ${y}`
	};
}

export function monthText(month: string) {
	const [y, m] = month.split('-').map(Number);
	return { hi: `${MONTH_HI[m - 1]} ${y}`, en: `${MONTH_EN[m - 1]} ${y}` };
}

export function addMonths(month: string, n: number) {
	const [y, m] = month.split('-').map(Number);
	return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 7);
}

// The tag beside a worker on a half-counted day. `half` is what the worker already has.
export const HALF_TEXT = {
	start: { hi: 'शुरू हो गया, अंत बाकी', en: 'Start done, end missing' },
	end: { hi: 'अंत हो गया, शुरू बाकी', en: 'End done, start missing' }
};

export const STATE_TEXT = {
	full: { hi: 'पूरी शिफ्ट', en: 'Full shift' },
	partial: { hi: 'शुरू या अंत छूटा', en: 'Start or end only' },
	missed: { hi: 'पूरा दिन छूटा', en: 'Missed' },
	waiting: { hi: 'मंज़ूरी बाकी', en: 'Waiting' },
	regularised: { hi: 'मंज़ूर', en: 'Regularised' },
	rejected: { hi: 'नामंज़ूर', en: 'Rejected' },
	none: { hi: 'कुछ नहीं करना', en: 'Nothing to do' }
};

export const DAY_DETAIL = {
	full: { hi: 'पूरी शिफ्ट की हाज़िरी लगी', en: 'Full shift counted' },
	partial: {
		hi: 'कुछ मेंबर की शुरू या अंत की फोटो छूटी',
		en: 'Some workers have only a start or only an end'
	},
	missed: { hi: 'इस दिन कोई फोटो नहीं आई', en: 'No photo came on this day' },
	waiting: { hi: 'भेज दिया, मंज़ूरी का इंतज़ार', en: 'Sent, waiting for approval' },
	regularised: { hi: 'मंज़ूर, हाज़िरी गिनी गई', en: 'Approved, attendance counted' },
	rejected: { hi: 'नामंज़ूर, फिर से भेज सकते हैं', en: 'Rejected. You can apply again' }
};

export const NOTE_DETAIL = {
	inactive: { hi: 'पंप बंद था, कुछ नहीं करना', en: 'The pump was Inactive, nothing to do' },
	today: { hi: 'आज का दिन, कल से भेज सकते हैं', en: 'Today. You can apply from tomorrow' },
	future: { hi: 'यह दिन अभी आया नहीं', en: 'This day has not come yet' },
	open: { hi: 'शिफ्ट अभी चालू है, अंत की फोटो आ सकती है', en: 'Shift still open, its end can come' },
	checking: { hi: 'फोटो की जाँच चल रही है', en: 'Photos are still being checked' }
};

export const STATUS_TEXT: Record<string, string> = {
	pending: 'Waiting for approval',
	approved: 'Approved',
	rejected: 'Rejected',
	cancelled: 'Withdrawn',
	undone: 'Undone by admin'
};
