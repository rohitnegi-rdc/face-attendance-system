// Pump screen language: Hindi (default) or English. Hindi is written in Devanagari and keeps the
// everyday English work words (shift, photo, operator, pump) as they are said, so every pump crew
// can read it. Only the pump screens use this. Text without a Hindi entry stays in English.
const STORAGE_KEY = 'pump-lang';

export const pumpLang = $state({ hindi: true });

export function loadPumpLang() {
	try {
		pumpLang.hindi = localStorage.getItem(STORAGE_KEY) !== 'en';
	} catch {
		pumpLang.hindi = true;
	}
}

export function setPumpHindi(hindi: boolean) {
	pumpLang.hindi = hindi;
	try {
		localStorage.setItem(STORAGE_KEY, hindi ? 'hi' : 'en');
	} catch {
		// Private window or blocked storage: the choice lasts until the page reloads.
	}
}

// {name} in a key is filled from vars, in English and Hindi alike.
const HI: Record<string, string> = {
	// Shell
	'Face Attendance': 'फेस अटेंडेंस',
	'Sign out': 'साइन आउट',

	// Heading and status
	'Shift attendance': 'शिफ्ट अटेंडेंस',
	'Group photo attendance': 'ग्रुप फोटो अटेंडेंस',
	Checking: 'चेक हो रहा है',
	'Start only': 'सिर्फ स्टार्ट',
	Complete: 'पूरी',
	Waiting: 'इंतज़ार',
	'Start open': 'स्टार्ट खुला',
	'End open': 'एंड खुला',
	'Shift ended (start only)': 'शिफ्ट खत्म (सिर्फ स्टार्ट)',
	'Shift complete': 'शिफ्ट पूरी',
	'Review attendance': 'अटेंडेंस रिव्यू करें',
	'Photo needs a retry': 'फोटो दोबारा लें',
	'Shift in progress': 'शिफ्ट चल रही है',
	'End shift': 'शिफ्ट एंड करें',
	'Start shift': 'शिफ्ट स्टार्ट करें',

	// Group photo
	'Group photo': 'ग्रुप फोटो',
	'Keep every face visible and inside the frame.': 'हर चेहरा साफ़ और फ्रेम के अंदर रखें।',
	'Stand where the whole group is evenly lit and facing the camera.':
		'ऐसी जगह खड़े हों जहाँ पूरे ग्रुप पर बराबर रोशनी हो और सब कैमरे की तरफ देखें।',
	'Take photo': 'फोटो लें',
	'Capture video call': 'वीडियो कॉल से फोटो लें',
	'Keep the complete group inside the frame.': 'पूरा ग्रुप फ्रेम के अंदर रखें।',
	'Keep every worker visible before capturing the photo.':
		'फोटो लेने से पहले हर वर्कर दिखना चाहिए।',
	'Keep every worker visible in the WhatsApp call before capturing.':
		'फोटो लेने से पहले व्हाट्सऐप कॉल में हर वर्कर दिखना चाहिए।',

	// Operator photo
	'Operator photo': 'ऑपरेटर फोटो',
	'The pump operator alone, face clearly visible. Needed with every shift photo.':
		'सिर्फ पंप ऑपरेटर, चेहरा साफ़ दिखे। हर शिफ्ट फोटो के साथ ज़रूरी है।',
	'Retake operator photo': 'ऑपरेटर फोटो दोबारा लें',
	'Only the operator, face clearly visible.': 'सिर्फ ऑपरेटर, चेहरा साफ़ दिखे।',
	'Hold the phone at face height in good light.': 'अच्छी रोशनी में फ़ोन चेहरे की ऊँचाई पर रखें।',
	'Ask the operator to face the camera alone in the call.':
		'ऑपरेटर से कहें कि कॉल में अकेले कैमरे की तरफ देखें।',
	'Start with the operator': 'पहले ऑपरेटर की फोटो',
	'Now the group photo': 'अब ग्रुप फोटो',
	'Take the group photo first': 'पहले ग्रुप फोटो लें',
	'Take a photo of the pump operator alone, so their attendance is marked too.':
		'पंप ऑपरेटर की अकेले फोटो लें, ताकि उनकी अटेंडेंस भी लगे।',
	'Take operator photo': 'ऑपरेटर फोटो लें',
	'Submit photos': 'फोटो भेजें',
	Cancel: 'रद्द करें',

	// Camera and screen capture
	'Use this photo': 'यह फोटो लें',
	'Stop camera': 'कैमरा बंद करें',
	'Exit full screen': 'फुल स्क्रीन बंद करें',
	'Full screen': 'फुल स्क्रीन',
	'Switch to front camera': 'फ्रंट कैमरा चालू करें',
	'Switch to rear camera': 'रियर कैमरा चालू करें',
	'Use front camera': 'फ्रंट कैमरा',
	'Use rear camera': 'रियर कैमरा',
	'Use this frame': 'यह फ्रेम लें',
	'Stop sharing': 'शेयरिंग बंद करें',
	'Camera capture is not supported in this browser.': 'इस ब्राउज़र में कैमरा नहीं चलता।',
	'Camera permission was blocked. Allow camera access in the browser.':
		'कैमरा परमिशन ब्लॉक है। ब्राउज़र में कैमरा की अनुमति दें।',
	'Could not start the laptop camera. Check that no other app is using it.':
		'कैमरा शुरू नहीं हुआ। देखें कि कोई दूसरा ऐप कैमरा तो नहीं चला रहा।',
	'The camera preview is not ready yet.': 'कैमरा अभी तैयार नहीं है।',
	'Could not capture the camera frame.': 'कैमरा से फोटो नहीं ली जा सकी।',
	'Could not create a photo from the camera frame.': 'कैमरा फ्रेम से फोटो नहीं बन सकी।',
	'Screen capture is not supported in this browser. Use Chrome or Edge.':
		'इस ब्राउज़र में स्क्रीन कैप्चर नहीं चलता। क्रोम या एज इस्तेमाल करें।',
	'Screen capture permission was cancelled.': 'स्क्रीन कैप्चर की परमिशन रद्द हो गई।',
	'Could not start screen capture. Please select the WhatsApp call window again.':
		'स्क्रीन कैप्चर शुरू नहीं हुआ। व्हाट्सऐप कॉल की विंडो फिर से चुनें।',
	'The selected video window is not ready yet.': 'चुनी गई वीडियो विंडो अभी तैयार नहीं है।',
	'Could not capture the selected window.': 'चुनी गई विंडो की फोटो नहीं ली जा सकी।',
	'Could not create a photo from the selected window.': 'चुनी गई विंडो से फोटो नहीं बन सकी।',

	// Processing
	Uploading: 'अपलोड हो रहा है',
	Processing: 'प्रोसेस हो रहा है',
	'Sending the photo': 'फोटो भेजी जा रही है',
	'Reading attendance': 'अटेंडेंस पढ़ी जा रही है',
	'Photo received': 'फोटो मिल गई',
	'Detecting faces': 'चेहरे पहचाने जा रहे हैं',
	'Matching attendance': 'अटेंडेंस मिलाई जा रही है',
	Done: 'हो गया',
	'Keep this page open while the group is processed.': 'प्रोसेस पूरा होने तक यह पेज खुला रखें।',

	// Failures
	'Fake Image Detected': 'नकली फोटो पकड़ी गई',
	'This photo could not be verified as a live photo. Your login has been disabled and the plant manager has been notified. No attendance was recorded from this photo. Contact your plant manager or admin to get your login re-enabled.':
		'यह फोटो लाइव फोटो के रूप में वेरिफाई नहीं हो सकी। आपका लॉगिन बंद कर दिया गया है और प्लांट मैनेजर को बता दिया गया है। इस फोटो से कोई अटेंडेंस नहीं लगी। लॉगिन फिर से चालू करवाने के लिए प्लांट मैनेजर या एडमिन से संपर्क करें।',
	'Could not finish': 'पूरा नहीं हो सका',
	Retry: 'फिर से कोशिश करें',
	'Choose another': 'दूसरी फोटो चुनें',
	'Could not load the shift status. Check the connection and try again.':
		'शिफ्ट स्टेटस लोड नहीं हुआ। इंटरनेट कनेक्शन चेक करें और फिर से कोशिश करें।',
	'The photo could not be submitted.': 'फोटो सबमिट नहीं हो सकी।',
	'The service is not reachable. Your selected photo is still ready to retry.':
		'सर्वर से कनेक्शन नहीं हो रहा। आपकी फोटो रखी है, फिर से कोशिश करें।',
	'Could not prepare retry. Please ask admin to review this attendance.':
		'रीट्राई तैयार नहीं हो सका। एडमिन से यह अटेंडेंस चेक करवाएं।',
	'Could not connect to prepare retry. Please try again.': 'कनेक्शन नहीं हुआ। फिर से कोशिश करें।',
	'Could not complete this attendance review.': 'यह अटेंडेंस रिव्यू पूरा नहीं हो सका।',
	'Could not connect to complete this attendance review.':
		'कनेक्शन नहीं हुआ, अटेंडेंस रिव्यू पूरा नहीं हुआ।',
	'Processing failed. Please try another photo.': 'प्रोसेसिंग फेल हुई। दूसरी फोटो लें।',
	'The photo could not be processed.': 'फोटो प्रोसेस नहीं हो सकी।',
	'The connection was interrupted while checking the result.':
		'रिज़ल्ट चेक करते समय कनेक्शन टूट गया।',
	'Processing is taking longer than expected. Please retry the status check.':
		'प्रोसेसिंग में ज़्यादा समय लग रहा है। फिर से स्टेटस चेक करें।',
	'The photo is taking too long to process.': 'फोटो प्रोसेस होने में बहुत समय लग रहा है।',
	'Could not connect. Please try again.': 'कनेक्शन नहीं हुआ। फिर से कोशिश करें।',

	// Messages from the server and the worker
	'The face service did not answer. Tap Retry, or contact Admin if it keeps happening.':
		'फेस सर्विस से जवाब नहीं आया। फिर से कोशिश करें, बार-बार हो तो एडमिन से बात करें।',
	'No face was found in the operator photo. Tap Retry and take a clear photo of the operator.':
		'ऑपरेटर फोटो में चेहरा नहीं मिला। फिर से कोशिश करें और ऑपरेटर की साफ़ फोटो लें।',
	'The photo file is missing on the server. Tap Retry and take the photo again.':
		'सर्वर पर फोटो नहीं मिली। फिर से कोशिश करें और फोटो दोबारा लें।',
	'The photo could not be processed. Tap Retry, or contact Admin if it keeps happening.':
		'फोटो प्रोसेस नहीं हो सकी। फिर से कोशिश करें, बार-बार हो तो एडमिन से बात करें।',
	'Account disabled. Contact your Plant Manager.': 'अकाउंट बंद है। अपने प्लांट मैनेजर से बात करें।',
	'Photo must be smaller than 18 MB.': 'फोटो 18 MB से छोटी होनी चाहिए।',
	'Upload a JPEG, PNG, or WebP photo.': 'JPEG, PNG या WebP फोटो भेजें।',
	'Take the operator photo too.': 'ऑपरेटर फोटो भी लें।',
	'The operator photo must be smaller than 18 MB.': 'ऑपरेटर फोटो 18 MB से छोटी होनी चाहिए।',
	'The operator photo must be a JPEG, PNG, or WebP.': 'ऑपरेटर फोटो JPEG, PNG या WebP होनी चाहिए।',
	'Take a separate photo of the operator, not the group photo again.':
		'ऑपरेटर की अलग फोटो लें, ग्रुप फोटो दोबारा नहीं।',
	'Duplicate photo - already submitted': 'यह फोटो पहले ही भेजी जा चुकी है',
	'Concurrent submission already recorded': 'यह फोटो पहले ही दर्ज हो चुकी है',
	'Attendance submission failed': 'अटेंडेंस सबमिट नहीं हुई',
	'Could not end the session. Try again.': 'सेशन खत्म नहीं हुआ। फिर से कोशिश करें।',
	'There is no open shift to end.': 'खत्म करने के लिए कोई खुली शिफ्ट नहीं है।',
	'Finish reviewing the shift start photo first.': 'पहले शिफ्ट स्टार्ट फोटो का रिव्यू पूरा करें।',
	'This shift is no longer open.': 'यह शिफ्ट अब खुली नहीं है।',
	'Retry the shift end photo before retrying this shift start':
		'इस शिफ्ट स्टार्ट से पहले शिफ्ट एंड फोटो दोबारा भेजें',
	'This photo matched a worker at another pump. Only an administrator can redo it.':
		'यह फोटो दूसरे पंप के वर्कर से मिली। इसे सिर्फ एडमिन दोबारा कर सकते हैं।',
	'Could not prepare retry': 'रीट्राई तैयार नहीं हो सका',
	'This attendance is not awaiting review': 'यह अटेंडेंस रिव्यू के लिए नहीं है',
	'Could not complete attendance review': 'अटेंडेंस रिव्यू पूरा नहीं हुआ',

	// Result review
	'Review before completing': 'पूरा करने से पहले चेक करें',
	'{n} person marked present': '{n} व्यक्ति प्रेज़ेंट',
	'{n} people marked present': '{n} लोग प्रेज़ेंट',
	'{n} held for admin review': '{n} एडमिन रिव्यू के लिए रोके गए',
	'Waiting for plant manager approval.': 'प्लांट मैनेजर की मंज़ूरी का इंतज़ार।',
	'The shift has started; the plant manager has been emailed to verify it.':
		'शिफ्ट शुरू हो गई है; प्लांट मैनेजर को वेरिफाई करने के लिए ईमेल भेजा गया है।',
	'{n} need review.': '{n} का रिव्यू ज़रूरी।',
	'Check the marked faces before completing attendance.':
		'अटेंडेंस पूरी करने से पहले मार्क किए चेहरे चेक करें।',
	'Submitted group photo': 'भेजी गई ग्रुप फोटो',
	Matched: 'मिले हुए',
	'New people': 'नए लोग',
	'Needs review': 'रिव्यू ज़रूरी',
	'Awaiting guest review': 'गेस्ट रिव्यू बाकी',
	'These faces were saved for an administrator to review.':
		'ये चेहरे एडमिन के रिव्यू के लिए सेव किए गए हैं।',
	'Live check passed': 'लाइव चेक पास',
	'Could not verify': 'वेरिफाई नहीं हो सका',
	'Matched existing worker': 'पुराना वर्कर मिला',
	'New worker found': 'नया वर्कर मिला',
	Worker: 'वर्कर',
	Operator: 'ऑपरेटर',
	'a worker': 'एक वर्कर',
	'another pump': 'दूसरा पंप',
	'Already marked at {where}': '{where} पर पहले से मार्क',
	'A face in this photo matches {who}, already marked at {where}. Not counted here until an admin checks it.':
		'इस फोटो का एक चेहरा {who} से मिलता है, जो {where} पर पहले से मार्क है। एडमिन के चेक करने तक यहाँ नहीं गिना जाएगा।',
	'Guest {n}': 'गेस्ट {n}',
	'Waiting for admin review': 'एडमिन रिव्यू का इंतज़ार',
	'Check the count and face crops before completing this attendance.':
		'अटेंडेंस पूरी करने से पहले गिनती और चेहरे चेक करें।',
	'Preparing retry': 'रीट्राई तैयार हो रहा है',
	'Retry with better photo': 'बेहतर फोटो से दोबारा करें',
	'Completing attendance': 'अटेंडेंस पूरी हो रही है',
	'Done reviewing': 'रिव्यू पूरा',

	// Session details
	'Session status': 'सेशन स्टेटस',
	Date: 'तारीख',
	Today: 'आज',
	Started: 'शुरू हुई',
	'Next step': 'अगला कदम',
	'Shift ended without an end photo. The next shift starts tomorrow.':
		'एंड फोटो के बिना शिफ्ट खत्म हुई। अगली शिफ्ट कल शुरू होगी।',
	'Shift recorded. The next shift starts tomorrow.': 'शिफ्ट दर्ज हो गई। अगली शिफ्ट कल शुरू होगी।',
	'Finish reviewing the submitted group photo': 'भेजी गई ग्रुप फोटो का रिव्यू पूरा करें',
	'Retry the photo that could not be processed': 'जो फोटो प्रोसेस नहीं हुई, उसे दोबारा भेजें',
	'Shift end opens {time}': 'शिफ्ट एंड {time} पर खुलेगा',
	'Submit the group photo to end the shift': 'शिफ्ट एंड करने के लिए ग्रुप फोटो भेजें',
	'Submit the group photo to start the shift': 'शिफ्ट स्टार्ट करने के लिए ग्रुप फोटो भेजें',
	'Missed the end photo? End the shift here so your next photo starts a new one.':
		'एंड फोटो छूट गई? शिफ्ट यहाँ खत्म करें ताकि अगली फोटो से नई शिफ्ट शुरू हो।',
	'Ending session': 'सेशन खत्म हो रहा है',
	'End session': 'सेशन खत्म करें',

	// Worker preview
	'No face crop was returned for this worker.': 'इस वर्कर का चेहरा नहीं मिला।',
	Session: 'सेशन',
	'Shift start': 'शिफ्ट स्टार्ट',
	'Shift end': 'शिफ्ट एंड',
	Result: 'नतीजा',
	'Daily match': 'आज की हाज़िरी',
	'Not counted until an admin checks it': 'एडमिन के चेक करने तक नहीं गिना जाएगा',
	Start: 'स्टार्ट',
	End: 'एंड',
	and: 'और',
	'New attendance': 'नई अटेंडेंस'
};

export function t(english: string, vars: Record<string, string | number> = {}): string {
	const text = (pumpLang.hindi && HI[english]) || english;
	return text.replace(/\{(\w+)\}/g, (match, name) => (name in vars ? String(vars[name]) : match));
}

// Server-built worker labels ("ASLP1 Worker 3 (Operator)") in the chosen language.
export function tLabel(label: string): string {
	if (!pumpLang.hindi) return label;
	return label.replace(/\bWorker\b/g, HI.Worker).replace(/\(Operator\)/g, `(${HI.Operator})`);
}
