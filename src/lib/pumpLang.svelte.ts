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
	Help: 'मदद',

	// First sign-in guide (PumpGuide.svelte); button names are filled from the entries below
	'Take the Pump Operator photo': 'पंप ऑपरेटर की फोटो लें',
	'Tap the "{button}" button. Only the operator should be in the photo, with the face clearly visible.':
		'"{button}" बटन पर क्लिक करें। फोटो में केवल ऑपरेटर हों और उनका चेहरा साफ़ दिखे।',
	'Take the photo of all Pump Members': 'सभी पंप मेंबर्स की फोटो लें',
	'Tap the "{button}" button. Every member\'s face should be clearly visible.':
		'"{button}" बटन पर क्लिक करें। सभी मेंबर्स के चेहरे साफ़ दिखाई दें।',
	'Send the photos and write the names': 'फोटो भेजें और नाम लिखें',
	'Tap the "{send}" button. Then write the full names of all members and tap "{button}". Your shift will start.':
		'"{send}" बटन पर क्लिक करें। फिर सभी मेंबर्स के पूरे नाम लिखकर "{button}" दबाएँ। आपकी शिफ्ट शुरू हो जाएगी।',
	'Close the shift after 9 hours': '9 घंटे बाद शिफ्ट बंद करें',
	'After 9 hours, take and send the photos of the operator and all members again. Then tap "{button}". The shift will close.':
		'9 घंटे बाद ऑपरेटर और सभी मेंबर्स की दोबारा फोटो लेकर भेजें। फिर "{button}" दबाएँ। शिफ्ट बंद हो जाएगी।',
	'Any problem? Tap the "Help" button.': 'कोई परेशानी हो तो "मदद" बटन दबाएँ।',
	'Ramesh Kumar': 'रमेश कुमार',
	'Step {n} of {total}': 'स्टेप {n} / {total}',
	Listen: 'सुनें',
	Next: 'आगे',
	Back: 'पीछे',
	'Close guide': 'गाइड बंद करें',
	'How to use the app': 'ऐप कैसे चलाएँ',

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
	'Pump Members photo': 'पंप मेंबर्स फोटो',
	'Every Pump Member in the photo, every face clear and inside the frame.':
		'हर पंप मेंबर फोटो में हो, हर चेहरा साफ़ और फ्रेम के अंदर।',
	'Stand where all Pump Members are in good light and facing the camera.':
		'ऐसी जगह खड़े हों जहाँ सभी पंप मेंबर्स पर अच्छी रोशनी हो और सब कैमरे की तरफ देखें।',
	'Take photo': 'फोटो लें',
	'Take Pump Members photo': 'पंप मेंबर्स फोटो लें',
	'Keep all Pump Members inside the frame.': 'सभी पंप मेंबर्स फ्रेम के अंदर रखें।',
	'Every Pump Member must be visible before you take the photo.':
		'फोटो लेने से पहले हर पंप मेंबर दिखना चाहिए।',

	// Operator photo
	'Pump Operator photo': 'पंप ऑपरेटर फोटो',
	'Only the Pump Operator, face clearly visible. Needed with every shift photo.':
		'सिर्फ पंप ऑपरेटर, चेहरा साफ़ दिखे। हर शिफ्ट फोटो के साथ ज़रूरी है।',
	'Retake Pump Operator photo': 'पंप ऑपरेटर फोटो दोबारा लें',
	'Only the Pump Operator, face clearly visible.': 'सिर्फ पंप ऑपरेटर, चेहरा साफ़ दिखे।',
	'Hold the phone at face height in good light.': 'अच्छी रोशनी में फ़ोन चेहरे की ऊँचाई पर रखें।',
	'Start with the Pump Operator': 'पहले पंप ऑपरेटर की फोटो',
	'Now the Pump Members photo': 'अब पंप मेंबर्स की फोटो',
	'Take the Pump Members photo first': 'पहले पंप मेंबर्स की फोटो लें',
	'Take a photo of the Pump Operator alone, so their attendance is marked too.':
		'पंप ऑपरेटर की अकेले फोटो लें, ताकि उनकी अटेंडेंस भी लगे।',
	'Take Pump Operator photo': 'पंप ऑपरेटर फोटो लें',
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
	'Camera capture is not supported in this browser.': 'इस ब्राउज़र में कैमरा नहीं चलता।',
	'Camera permission was blocked. Allow camera access in the browser.':
		'कैमरा परमिशन ब्लॉक है। ब्राउज़र में कैमरा की अनुमति दें।',
	'Could not start the laptop camera. Check that no other app is using it.':
		'कैमरा शुरू नहीं हुआ। देखें कि कोई दूसरा ऐप कैमरा तो नहीं चला रहा।',
	'The camera preview is not ready yet.': 'कैमरा अभी तैयार नहीं है।',
	'Could not capture the camera frame.': 'कैमरा से फोटो नहीं ली जा सकी।',
	'Could not create a photo from the camera frame.': 'कैमरा फ्रेम से फोटो नहीं बन सकी।',

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
	'Submitted Pump Members photo': 'भेजी गई पंप मेंबर्स फोटो',
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
	'Shift date': 'शिफ्ट की तारीख',
	'Shift details': 'शिफ्ट की जानकारी',
	Sunday: 'रविवार',
	Monday: 'सोमवार',
	Tuesday: 'मंगलवार',
	Wednesday: 'बुधवार',
	Thursday: 'गुरुवार',
	Friday: 'शुक्रवार',
	Saturday: 'शनिवार',
	Started: 'शुरू हुई',
	'Next step': 'अगला कदम',
	'Shift ended without an end photo. The next shift starts tomorrow.':
		'एंड फोटो के बिना शिफ्ट खत्म हुई। अगली शिफ्ट कल शुरू होगी।',
	'Shift recorded. The next shift starts tomorrow.': 'शिफ्ट दर्ज हो गई। अगली शिफ्ट कल शुरू होगी।',
	'Finish reviewing the submitted Pump Members photo':
		'भेजी गई पंप मेंबर्स फोटो का रिव्यू पूरा करें',
	'Retry the photo that could not be processed': 'जो फोटो प्रोसेस नहीं हुई, उसे दोबारा भेजें',
	'Shift end opens {time}': 'शिफ्ट एंड {time} पर खुलेगा',
	'Send the photos to end the shift': 'शिफ्ट एंड करने के लिए फोटो भेजें',
	'Send the photos to start the shift': 'शिफ्ट स्टार्ट करने के लिए फोटो भेजें',

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
	'New attendance': 'नई अटेंडेंस',

	// Naming workers before completing
	'Name your workers': 'वर्कर्स के नाम लिखें',
	'{n} left': '{n} बाकी',
	'All named': 'सबके नाम लिखे गए',
	'Write the full name of each worker. Attendance cannot be completed without it.':
		'हर वर्कर का पूरा नाम लिखें। नाम के बिना अटेंडेंस पूरी नहीं होगी।',
	'Full name': 'पूरा नाम',
	'Write a name for every worker before completing.': 'पूरा करने से पहले हर वर्कर का नाम लिखें।',
	'"{name}" is written twice. Each worker needs a different name.':
		'"{name}" दो बार लिखा है। हर वर्कर का नाम अलग होना चाहिए।',
	'{n} names still to write above.': 'ऊपर {n} नाम लिखने बाकी हैं।',

	// Shift end reminders (PumpReminders.svelte)
	'Turn on reminders': 'रिमाइंडर चालू करें',
	'Get a reminder on this phone when it is time to end the shift.':
		'शिफ्ट एंड करने का समय होने पर इस फ़ोन पर रिमाइंडर पाएँ।',
	'Enable notifications': 'नोटिफिकेशन चालू करें',
	'Tap the button, then tap "Allow".': 'बटन दबाएँ, फिर "अनुमति दें" (Allow) दबाएँ।',
	'Not now': 'अभी नहीं',
	Close: 'बंद करें',
	'Reminders are blocked on this phone.': 'इस फ़ोन पर रिमाइंडर बंद हैं।',
	'To turn them on, allow notifications for this site in the browser settings.':
		'चालू करने के लिए ब्राउज़र की सेटिंग में इस साइट के नोटिफिकेशन की अनुमति दें।',
	'Reminders could not be turned on.': 'रिमाइंडर चालू नहीं हो पाए।',
	'Check the internet and open the app again.': 'इंटरनेट चेक करें और ऐप फिर से खोलें।',
	'Reminders need the secure (https) address.': 'रिमाइंडर के लिए सुरक्षित (https) पता चाहिए।',
	'Open the app with its https:// address to get reminders.':
		'रिमाइंडर पाने के लिए ऐप को https:// वाले पते से खोलें।',
	'This browser cannot show reminders.': 'यह ब्राउज़र रिमाइंडर नहीं दिखा सकता।',
	'Open the app in Chrome to get reminders.': 'रिमाइंडर पाने के लिए ऐप को Chrome में खोलें।',
	'On iPhone, tap Share, then "Add to Home Screen", and open the app from the Home Screen.':
		'iPhone पर Share दबाएँ, फिर "Add to Home Screen" चुनें, और ऐप को होम स्क्रीन से खोलें।'
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
