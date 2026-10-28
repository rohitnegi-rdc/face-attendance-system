<script lang="ts">
	import { resolve } from '$app/paths';
	import { onDestroy, onMount, tick } from 'svelte';
	import Camera from '@lucide/svelte/icons/camera';
	import Check from '@lucide/svelte/icons/check';
	import Eye from '@lucide/svelte/icons/eye';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import Maximize from '@lucide/svelte/icons/maximize';
	import Minimize from '@lucide/svelte/icons/minimize';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import SwitchCamera from '@lucide/svelte/icons/switch-camera';
	import Upload from '@lucide/svelte/icons/upload';
	import UserRound from '@lucide/svelte/icons/user-round';
	import Users from '@lucide/svelte/icons/users';
	import X from '@lucide/svelte/icons/x';
	import { dateKey, formatDate, formatDateTime, formatDayLabel, todayStr } from '$lib/date';
	import { personDisplayLabel } from '$lib/personLabel';
	import { t, tLabel } from '$lib/pumpLang.svelte';
	import { showErrorToast, toastConnectionLost, toastIfServerError } from '$lib/toast.svelte';

	type FlowStatus = 'idle' | 'submitting' | 'processing' | 'completed' | 'failed' | 'fraud';
	type WorkerResult = {
		person_id: string;
		display_seq: number;
		pump_code: string;
		name?: string | null;
		source_photo_crop_url?: string | null;
		morning_matched?: boolean;
		evening_matched?: boolean;
		first_seen_at?: string;
		liveness_status?: 'live' | 'suspicious' | 'unverified';
		liveness_score?: number | null;
		liveness_reason?: string | null;
		is_operator?: boolean;
	};

	// null when the spoof check is switched off (ai-service ANTI_SPOOF_ENABLED=false): show no badge.
	function livenessLabel(person: WorkerResult) {
		if (person.liveness_reason === 'disabled') return null;
		if (person.liveness_status === 'live') return t('Live check passed');
		if (person.liveness_status === 'suspicious') return t('Needs review');
		return t('Could not verify');
	}

	function workerLabel(person: WorkerResult) {
		return tLabel(
			personDisplayLabel(person.pump_code, person.display_seq, person.is_operator, person.name)
		);
	}
	type WorkerPreview = WorkerResult & {
		group: 'matched' | 'new' | 'held' | 'guest';
		label: string;
		statusLabel: string;
	};

	let status = $state<FlowStatus>('idle');
	let errorMsg = $state('');
	// Set when the shift start is on hold for the plant manager (location not verified).
	let locationHold = $state('');

	// The phone's position for the shift start location check. Never blocks the photo: if the
	// operator denies access or it times out, the server sends it for plant manager approval.
	function currentPosition(): Promise<GeolocationPosition | null> {
		if (!navigator.geolocation) return Promise.resolve(null);
		return new Promise((done) =>
			navigator.geolocation.getCurrentPosition(done, () => done(null), {
				enableHighAccuracy: true,
				timeout: 12000,
				maximumAge: 60000
			})
		);
	}
	let selectedFile = $state<File | null>(null);
	let previewUrl = $state('');
	// The operator photo, required with every shift photo: the pump operator alone.
	let operatorFile = $state<File | null>(null);
	let operatorPreviewUrl = $state('');
	// Which photo the open camera is taking.
	let captureTarget = $state<'group' | 'operator'>('group');
	let result = $state<any>(null);
	let today = $state<any>(null);
	// The date at the top right: the shift's own date (an end photo after midnight still
	// belongs to the start's date), labelled so the operator knows which date it is.
	const WEEKDAYS: Record<string, string> = {
		Sun: 'Sunday',
		Mon: 'Monday',
		Tue: 'Tuesday',
		Wed: 'Wednesday',
		Thu: 'Thursday',
		Fri: 'Friday',
		Sat: 'Saturday'
	};
	const shownDate = $derived(dateKey(today?.shift_date || today?.today || new Date()));
	const shownDateIsToday = $derived(shownDate === todayStr());
	// No photo can be sent now (shift done, or the end not open yet): the photo card goes away
	// instead of showing grey buttons, and the shift details say why and when.
	const captureClosed = $derived(
		status === 'idle' &&
			!operatorPreviewUrl &&
			(today?.state === 'locked' || today?.can_submit === false)
	);
	let todayLoading = $state(true);
	let processingStep = $state(0);
	let currentSessionId = $state('');
	let retryingSession = $state(false);
	let approvingReview = $state(false);
	let selectedWorkerPreview = $state<WorkerPreview | null>(null);
	let workerPreviewDialog = $state<HTMLElement>();
	let workerPreviewCloseButton = $state<HTMLButtonElement>();
	let workerPreviewTrigger: HTMLButtonElement | null = null;
	let cameraStream = $state<MediaStream | null>(null);
	let cameraPreview = $state<HTMLVideoElement>();
	let cameraCaptureActive = $state(false);
	let cameraCaptureReady = $state(false);
	let cameraCaptureError = $state('');
	let cameraFacingMode = $state<'environment' | 'user'>('environment');
	let canSwitchCamera = $state(false);
	let cameraPanel = $state<HTMLDivElement>();
	let cameraFullscreen = $state(false);
	const canFullscreen =
		typeof document !== 'undefined' && Boolean(document.documentElement.requestFullscreen);

	// Full screen for the camera panel; on phones also tries to turn the screen to landscape.
	async function toggleCameraFullscreen() {
		if (document.fullscreenElement) {
			await document.exitFullscreen().catch(() => {});
			return;
		}
		await cameraPanel?.requestFullscreen({ navigationUI: 'hide' }).catch(() => {});
		const orientation = screen.orientation as ScreenOrientation & {
			lock?: (value: string) => Promise<void>;
		};
		await orientation.lock?.('landscape').catch(() => {});
	}

	function syncCameraFullscreen() {
		cameraFullscreen = Boolean(document.fullscreenElement);
		if (!cameraFullscreen) screen.orientation?.unlock?.();
	}

	// How the phone is held, from gravity: 0 upright, 90 turned left (top to the left), 180 upside
	// down, 270 turned right; null while lying flat or without a motion sensor. The camera frame
	// follows the screen, not the phone: with auto-rotate off (or outside full screen, where the
	// screen is not locked to landscape) a phone held sideways gave a sideways photo, and the
	// face detector misses sideways faces. The capture turns the photo by the difference.
	let phoneAngle: number | null = null;
	const gravitySign =
		typeof navigator !== 'undefined' && /iPad|iPhone|iPod/.test(navigator.userAgent) ? -1 : 1;

	function readGravity(event: DeviceMotionEvent) {
		const gravity = event.accelerationIncludingGravity;
		if (gravity?.x == null || gravity?.y == null) return;
		// iOS reports gravity with the opposite sign to Android and the W3C spec.
		const x = gravity.x * gravitySign;
		const y = gravity.y * gravitySign;
		if (Math.max(Math.abs(x), Math.abs(y)) < 4) {
			phoneAngle = null;
			return;
		}
		phoneAngle = Math.abs(y) >= Math.abs(x) ? (y > 0 ? 0 : 180) : x > 0 ? 90 : 270;
	}

	// iOS asks for motion permission, and only inside a tap: call before any await.
	function watchPhoneAngle() {
		if (typeof DeviceMotionEvent === 'undefined') return;
		const motion = DeviceMotionEvent as typeof DeviceMotionEvent & {
			requestPermission?: () => Promise<'granted' | 'denied'>;
		};
		const listen = () => window.addEventListener('devicemotion', readGravity);
		if (motion.requestPermission) {
			motion
				.requestPermission()
				.then((answer) => answer === 'granted' && listen())
				.catch(() => {});
		} else listen();
	}

	function stopWatchingPhoneAngle() {
		if (typeof window !== 'undefined') window.removeEventListener('devicemotion', readGravity);
		phoneAngle = null;
	}

	// Degrees the frame is turned against the world: the phone's angle minus the screen's.
	function frameTurn() {
		if (phoneAngle === null) return 0;
		const legacy = (window as Window & { orientation?: number }).orientation;
		const screenAngle = screen.orientation?.angle ?? legacy ?? 0;
		return (((phoneAngle - screenAngle) % 360) + 360) % 360;
	}

	const processingLabels = ['Photo received', 'Detecting faces', 'Matching attendance'];

	onMount(loadToday);
	onDestroy(() => {
		clearPreview();
		stopCameraCapture();
	});

	// Text for a failed request. API routes answer JSON { error }, but SvelteKit's CSRF check,
	// the body-size limit and the nginx proxy answer plain text or HTML; reading those as JSON
	// fell back to a generic message and hid the cause.
	async function failureMessage(res: Response, fallback: string) {
		toastIfServerError(res);
		const text = await res.text().catch(() => '');
		try {
			const message = JSON.parse(text)?.error;
			if (message) return String(message);
		} catch {
			// not JSON
		}
		console.error(`${res.url} answered ${res.status}: ${text.slice(0, 200)}`);
		if (res.status === 403 && /cross-site/i.test(text))
			return 'The server refused this request (security check, 403). Open the app from its usual address and try again.';
		if (res.status === 401) return 'Your login has expired. Sign in again.';
		if (res.status === 413) return 'The photo is too large to upload.';
		if (res.status >= 500)
			return `${fallback} The server had a problem (${res.status}). Try again in a minute.`;
		return `${fallback} (error ${res.status})`;
	}

	async function loadToday() {
		todayLoading = true;
		try {
			const res = await fetch(resolve('/api/attendance/today'));
			if (!res.ok) {
				const message = await failureMessage(res, 'Could not load the shift status.');
				if (status === 'idle') {
					errorMsg = message;
					status = 'failed';
				}
				return;
			}
			today = await res.json();
			if (today.review_session_id && status === 'idle') {
				const review = await fetch(resolve(`/api/attendance/status/${today.review_session_id}`));
				if (review.ok) {
					result = await review.json();
					currentSessionId = today.review_session_id;
					status = 'completed';
				}
			} else if (today.failed_session_id && status === 'idle') {
				// Survives a reload: Retry clears this photo so a new one can be taken.
				const photo = today.failed_session_type === 'evening' ? 'shift end' : 'shift start';
				currentSessionId = today.failed_session_id;
				errorMsg = `The ${photo} photo could not be processed${
					today.failed_reason ? ` (${today.failed_reason})` : ''
				}. Tap Retry to clear it, then take the photo again.`;
				status = 'failed';
			}
		} catch {
			toastConnectionLost();
			if (status === 'idle') {
				errorMsg = 'Could not load the shift status. Check the connection and try again.';
				status = 'failed';
			}
		} finally {
			todayLoading = false;
		}
	}

	function clearPreview() {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = '';
	}

	function clearOperatorPreview() {
		if (operatorPreviewUrl) URL.revokeObjectURL(operatorPreviewUrl);
		operatorPreviewUrl = '';
	}

	// Puts a captured frame into the photo the capture was started for.
	function useCapturedFile(file: File) {
		if (captureTarget === 'operator') {
			clearOperatorPreview();
			operatorFile = file;
			operatorPreviewUrl = URL.createObjectURL(file);
		} else {
			clearPreview();
			selectedFile = file;
			previewUrl = URL.createObjectURL(file);
		}
	}

	// Clears the photo about to be retaken; the other one is kept.
	function clearTarget(target: 'group' | 'operator') {
		captureTarget = target;
		if (target === 'operator') {
			clearOperatorPreview();
			operatorFile = null;
		} else {
			clearPreview();
			selectedFile = null;
		}
	}

	function stopCameraCapture() {
		if (typeof document !== 'undefined' && document.fullscreenElement) {
			document.exitFullscreen().catch(() => {});
		}
		if (cameraStream) {
			for (const track of cameraStream.getTracks()) track.stop();
		}
		stopWatchingPhoneAngle();
		cameraStream = null;
		cameraCaptureActive = false;
		cameraCaptureReady = false;
	}

	async function refreshCameraSwitchAvailability() {
		if (!navigator.mediaDevices?.enumerateDevices) return;
		const devices = await navigator.mediaDevices.enumerateDevices();
		canSwitchCamera = devices.filter((device) => device.kind === 'videoinput').length > 1;
	}

	function resetCapture() {
		clearPreview();
		selectedFile = null;
		clearOperatorPreview();
		operatorFile = null;
		captureTarget = 'group';
		result = null;
		selectedWorkerPreview = null;
		errorMsg = '';
		currentSessionId = '';
		retryingSession = false;
		approvingReview = false;
		cameraCaptureError = '';
		status = 'idle';
		stopCameraCapture();
		loadToday();
	}

	async function startCameraCapture(target: 'group' | 'operator' = captureTarget) {
		cameraCaptureError = '';
		errorMsg = '';
		result = null;
		selectedWorkerPreview = null;
		status = 'idle';
		clearTarget(target);
		cameraCaptureReady = false;
		canSwitchCamera = false;
		stopCameraCapture();
		watchPhoneAngle();

		if (!navigator.mediaDevices?.getUserMedia) {
			cameraCaptureError = 'Camera capture is not supported in this browser.';
			return;
		}

		try {
			cameraStream = await navigator.mediaDevices.getUserMedia({
				video: {
					width: { ideal: 1280 },
					height: { ideal: 960 },
					facingMode: { ideal: cameraFacingMode }
				},
				audio: false
			});
			cameraCaptureActive = true;
			await refreshCameraSwitchAvailability();
			const [track] = cameraStream.getVideoTracks();
			track?.addEventListener('ended', () => {
				cameraStream = null;
				cameraCaptureActive = false;
			});
			await tick();
			if (cameraPreview) {
				cameraPreview.srcObject = cameraStream;
				await cameraPreview.play().catch(() => {});
				cameraCaptureReady = Boolean(cameraPreview.videoWidth && cameraPreview.videoHeight);
			}
		} catch (error) {
			cameraCaptureError =
				error instanceof DOMException && error.name === 'NotAllowedError'
					? 'Camera permission was blocked. Allow camera access in the browser.'
					: 'Could not start the laptop camera. Check that no other app is using it.';
		}
	}

	async function switchCamera() {
		cameraFacingMode = cameraFacingMode === 'environment' ? 'user' : 'environment';
		await startCameraCapture(captureTarget);
	}

	// The operator usually takes their own photo: start on the front camera.
	async function startOperatorCamera() {
		cameraFacingMode = 'user';
		await startCameraCapture('operator');
	}

	// The group photo is taken of the crew: back to the rear camera.
	async function startGroupCamera() {
		cameraFacingMode = 'environment';
		await startCameraCapture('group');
	}

	async function captureCameraFrame() {
		if (!cameraPreview || !cameraPreview.videoWidth || !cameraPreview.videoHeight) {
			cameraCaptureError = 'The camera preview is not ready yet.';
			return;
		}

		const sourceWidth = cameraPreview.videoWidth;
		const sourceHeight = cameraPreview.videoHeight;
		const turn = frameTurn();
		const sideways = turn === 90 || turn === 270;
		const canvas = document.createElement('canvas');
		canvas.width = sideways ? sourceHeight : sourceWidth;
		canvas.height = sideways ? sourceWidth : sourceHeight;
		const context = canvas.getContext('2d');
		if (!context) {
			cameraCaptureError = 'Could not capture the camera frame.';
			return;
		}

		// The rear camera sees the scene turned against the phone; the front camera sees it
		// mirrored, so a quarter turn goes the other way. Half turns are the same for both.
		const facing = cameraStream?.getVideoTracks()[0]?.getSettings().facingMode ?? cameraFacingMode;
		const degrees = facing === 'user' ? turn : -turn;
		context.translate(canvas.width / 2, canvas.height / 2);
		context.rotate((degrees * Math.PI) / 180);
		context.drawImage(
			cameraPreview,
			-sourceWidth / 2,
			-sourceHeight / 2,
			sourceWidth,
			sourceHeight
		);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/jpeg', 0.92)
		);
		if (!blob) {
			cameraCaptureError = 'Could not create a photo from the camera frame.';
			return;
		}

		const sessionName = today?.state === 'evening' ? 'shift-end' : 'shift-start';
		const file = new File([blob], `camera-${captureTarget}-${sessionName}-${Date.now()}.jpg`, {
			type: 'image/jpeg'
		});

		useCapturedFile(file);
		cameraCaptureError = '';
		status = 'idle';
		stopCameraCapture();
	}

	async function submitPhoto() {
		if (!selectedFile || !operatorFile) return;
		errorMsg = '';
		selectedWorkerPreview = null;
		retryingSession = false;
		currentSessionId = '';
		status = 'submitting';

		const form = new FormData();
		form.append('photo', selectedFile);
		form.append('operator_photo', operatorFile);
		locationHold = '';
		const position = await currentPosition();
		if (position) {
			form.append('lat', String(position.coords.latitude));
			form.append('lng', String(position.coords.longitude));
			form.append('accuracy', String(Math.round(position.coords.accuracy)));
		}

		try {
			const res = await fetch(resolve('/api/attendance/submit'), { method: 'POST', body: form });
			if (!res.ok) {
				status = 'failed';
				errorMsg = await failureMessage(res, 'The photo could not be submitted.');
				return;
			}
			const body = await res.json();

			currentSessionId = body.session_id;
			locationHold = body.location_hold ?? '';
			status = 'processing';
			processingStep = 0;
			await poll(body.session_id);
		} catch {
			toastConnectionLost();
			status = 'failed';
			errorMsg = 'The service is not reachable. Your selected photo is still ready to retry.';
		}
	}

	async function requestAttendanceRetry() {
		const sessionId = result?.session_id || currentSessionId;
		if (!sessionId || retryingSession) return;

		retryingSession = true;
		errorMsg = '';
		selectedWorkerPreview = null;
		try {
			const res = await fetch(resolve(`/api/attendance/retry/${sessionId}`), { method: 'POST' });
			if (!res.ok) {
				errorMsg = await failureMessage(
					res,
					'Could not prepare retry. Please ask admin to review this attendance.'
				);
				retryingSession = false;
				return;
			}
			resetCapture();
		} catch {
			toastConnectionLost();
			errorMsg = 'Could not connect to prepare retry. Please try again.';
			retryingSession = false;
		}
	}

	// Every worker in the photo needs a name before the operator can complete it (the server
	// checks too). Names typed here, by person id.
	let workerNames = $state<Record<string, string>>({});
	let nameError = $state('');
	const unnamedWorkers = $derived(
		[...(result?.matched ?? []), ...(result?.new_persons ?? [])].filter(
			(person: WorkerResult) => !person.name
		) as WorkerResult[]
	);
	const namesLeft = $derived(
		unnamedWorkers.filter((person) => (workerNames[person.person_id] ?? '').trim().length < 2)
			.length
	);

	async function approveAttendanceReview() {
		const sessionId = result?.session_id || currentSessionId;
		if (!sessionId || approvingReview) return;
		nameError = '';
		if (namesLeft) {
			nameError = t('Write a name for every worker before completing.');
			return;
		}
		const typed = unnamedWorkers.map((person) => workerNames[person.person_id].trim());
		const repeated = typed.find(
			(name, i) => typed.findIndex((other) => other.toLowerCase() === name.toLowerCase()) !== i
		);
		if (repeated) {
			nameError = t('"{name}" is written twice. Each worker needs a different name.', {
				name: repeated
			});
			return;
		}

		approvingReview = true;
		errorMsg = '';
		try {
			const res = await fetch(resolve(`/api/attendance/approve/${sessionId}`), {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({
					names: Object.fromEntries(
						unnamedWorkers.map((person) => [person.person_id, workerNames[person.person_id]])
					)
				})
			});
			if (res.status === 409 || res.status === 422) {
				const body = await res.json().catch(() => ({}));
				nameError = body.unnamed
					? t('Write a name for every worker before completing.')
					: t(body.error || 'Could not complete this attendance review.');
				approvingReview = false;
				return;
			}
			if (!res.ok) {
				errorMsg = await failureMessage(res, 'Could not complete this attendance review.');
				approvingReview = false;
				return;
			}
			workerNames = {};
			resetCapture();
		} catch {
			toastConnectionLost();
			errorMsg = 'Could not connect to complete this attendance review.';
			approvingReview = false;
		}
	}

	async function retryFailedCapture() {
		if (result?.session_id || currentSessionId) {
			await requestAttendanceRetry();
			return;
		}
		// Nothing to resend (the shift status failed to load): reload it.
		if (!selectedFile || !operatorFile) {
			resetCapture();
			return;
		}
		await submitPhoto();
	}

	async function poll(sessionId: string) {
		let connectionFailures = 0;
		for (let i = 0; i < 90; i++) {
			await new Promise((resolve) => setTimeout(resolve, 2000));
			processingStep = Math.min(2, Math.floor(i / 3));
			try {
				const res = await fetch(resolve(`/api/attendance/status/${sessionId}`));
				if (!res.ok) throw new Error('status unavailable');
				const body = await res.json();
				connectionFailures = 0;
				if (body.status === 'review' || body.status === 'completed') {
					status = 'completed';
					result = body;
					await loadToday();
					return;
				}
				if (body.status === 'failed') {
					status = 'failed';
					errorMsg = body.error_reason || 'Processing failed. Please try another photo.';
					showErrorToast(t(body.error_reason || 'The photo could not be processed.'));
					return;
				}
				if (body.status === 'fraud_detected') {
					status = 'fraud';
					return;
				}
			} catch {
				connectionFailures += 1;
				if (connectionFailures >= 5) {
					toastConnectionLost();
					status = 'failed';
					errorMsg = 'The connection was interrupted while checking the result.';
					return;
				}
			}
		}
		status = 'failed';
		errorMsg = 'Processing is taking longer than expected. Please retry the status check.';
		showErrorToast(t('The photo is taking too long to process.'));
	}

	// Faces held by a fraud flag are not counted here until an admin clears them.
	const peopleFound = $derived((result?.matched?.length || 0) + (result?.new_persons?.length || 0));

	// API states keep the database words: morning = shift start, evening = shift end.
	const sessionTitle = $derived.by(() => {
		if (today?.state === 'locked')
			return today?.shift_outcome === 'start_only' ? 'Shift ended (start only)' : 'Shift complete';
		if (today?.state === 'review') return 'Review attendance';
		if (today?.state === 'failed') return 'Photo needs a retry';
		if (today?.state === 'evening' && today?.can_submit === false) return 'Shift in progress';
		if (today?.state === 'evening') return 'End shift';
		return 'Start shift';
	});

	function formatIST(value: string | null | undefined) {
		if (!value) return '';
		return formatDateTime(value);
	}

	async function openWorkerPreview(
		person: WorkerResult,
		group: 'matched' | 'new',
		trigger: HTMLButtonElement
	) {
		const label = workerLabel(person);
		workerPreviewTrigger = trigger;
		selectedWorkerPreview = {
			...person,
			group,
			label,
			statusLabel: [
				group === 'matched' ? t('Matched existing worker') : t('New worker found'),
				livenessLabel(person)
			]
				.filter(Boolean)
				.join(' · ')
		};
		await tick();
		workerPreviewCloseButton?.focus();
	}

	// Faces that are not counted yet: matched at another pump (held) or not matched at all (guest).
	async function openHeldPreview(
		preview: Pick<WorkerPreview, 'group' | 'label' | 'statusLabel' | 'source_photo_crop_url'>,
		trigger: HTMLButtonElement
	) {
		workerPreviewTrigger = trigger;
		selectedWorkerPreview = { person_id: '', display_seq: 0, pump_code: '', ...preview };
		await tick();
		workerPreviewCloseButton?.focus();
	}

	function closeWorkerPreview() {
		selectedWorkerPreview = null;
		workerPreviewTrigger?.focus();
	}

	function handleWorkerPreviewKeydown(event: KeyboardEvent) {
		if (!selectedWorkerPreview) return;
		if (event.key === 'Escape') {
			event.preventDefault();
			closeWorkerPreview();
			return;
		}
		if (event.key !== 'Tab') return;
		if (!workerPreviewDialog) return;
		const focusable = Array.from(
			workerPreviewDialog.querySelectorAll<HTMLElement>('button:not([disabled]), a[href]')
		).filter((element) => element.offsetParent !== null);
		if (!focusable.length) return;
		const first = focusable[0];
		const last = focusable.at(-1)!;
		if (event.shiftKey && document.activeElement === first) {
			event.preventDefault();
			last.focus();
		} else if (!event.shiftKey && document.activeElement === last) {
			event.preventDefault();
			first.focus();
		}
	}
</script>

<svelte:head>
	<title>Pump capture | Face Attendance</title>
</svelte:head>

<svelte:window onkeydown={handleWorkerPreviewKeydown} />
<svelte:document onfullscreenchange={syncCameraFullscreen} />

{#snippet cameraCapturePanel(guidance: string, note: string)}
	<div
		class="screen-capture-panel camera-capture-panel"
		aria-label="Camera capture"
		bind:this={cameraPanel}
	>
		<div class="screen-preview">
			<video
				bind:this={cameraPreview}
				autoplay
				muted
				playsinline
				onloadedmetadata={() => (cameraCaptureReady = true)}
				oncanplay={() => (cameraCaptureReady = true)}
				aria-label="Laptop camera preview"
			></video>
		</div>
		<p class="camera-capture-guidance">{guidance}</p>
		<div class="screen-actions">
			<button
				class="button button--primary"
				type="button"
				onclick={captureCameraFrame}
				disabled={!cameraCaptureReady}
			>
				<Camera size={18} />
				{t('Use this photo')}
			</button>
			<button class="button button--secondary" type="button" onclick={stopCameraCapture}>
				{t('Stop camera')}
			</button>
			{#if canFullscreen}
				<button class="button button--secondary" type="button" onclick={toggleCameraFullscreen}>
					{#if cameraFullscreen}<Minimize size={18} /> {t('Exit full screen')}{:else}<Maximize
							size={18}
						/>
						{t('Full screen')}{/if}
				</button>
			{/if}
			{#if canSwitchCamera}
				<button
					class="button button--secondary"
					type="button"
					onclick={switchCamera}
					aria-label={cameraFacingMode === 'environment'
						? t('Switch to front camera')
						: t('Switch to rear camera')}
				>
					<SwitchCamera size={18} />
					{cameraFacingMode === 'environment' ? t('Use front camera') : t('Use rear camera')}
				</button>
			{/if}
		</div>
		<p class="capture-note">{note}</p>
		{#if cameraCaptureError}<p class="capture-error">{t(cameraCaptureError)}</p>{/if}
	</div>
{/snippet}

<div class="capture-page">
	<header class="capture-heading">
		<div class="heading-main">
			<h1 data-testid="session-title">{t(sessionTitle)}</h1>
			<p>
				{today?.pump_code
					? `${today.pump_code} · ${today.plant_name}`
					: t('Group photo attendance')}
			</p>
		</div>
		<div class="heading-side">
			<div class="heading-date" data-testid="heading-date">
				<span>
					{shownDateIsToday ? t('Today') : t('Shift date')} · {t(
						WEEKDAYS[formatDayLabel(shownDate).weekday]
					)}
				</span>
				<strong>{formatDate(shownDate)}</strong>
			</div>
			{#if todayLoading}
				<span class="status-badge"><LoaderCircle class="spin" size={14} /> {t('Checking')}</span>
			{:else if today?.state === 'locked'}
				{#if today?.shift_outcome === 'start_only'}
					<span class="status-badge" data-testid="shift-badge">{t('Start only')}</span>
				{:else}
					<span class="status-badge status-badge--success" data-testid="shift-badge"
						><Check size={14} /> {t('Complete')}</span
					>
				{/if}
			{:else}
				<span class="status-badge">
					{today?.can_submit === false
						? t('Waiting')
						: t(today?.state === 'evening' ? t('End open') : t('Start open'))}
				</span>
			{/if}
		</div>
	</header>

	<div class="capture-layout">
		{#if !(status === 'completed' && result) && !captureClosed}
			<section class="capture-workspace" aria-labelledby="photo-heading">
				<div class="section-heading">
					<div>
						<h2 id="photo-heading">{t('Pump Operator photo')}</h2>
						<p>
							{t('Only the Pump Operator, face clearly visible. Needed with every shift photo.')}
						</p>
					</div>
				</div>

				<div data-testid="operator-photo">
					{#if operatorPreviewUrl}
						<div class="photo-preview operator-preview">
							<img src={operatorPreviewUrl} alt="Selected Pump Operator" />
							{#if status === 'submitting' || status === 'processing'}
								<div class="processing-overlay" aria-hidden="true">
									<LoaderCircle class="spin" size={30} />
								</div>
							{/if}
						</div>
						{#if status === 'idle'}
							<button class="button button--secondary" type="button" onclick={startOperatorCamera}>
								<Camera size={18} />
								{t('Retake Pump Operator photo')}
							</button>
						{/if}
					{:else if cameraCaptureActive && captureTarget === 'operator'}
						{@render cameraCapturePanel(
							t('Only the Pump Operator, face clearly visible.'),
							t('Hold the phone at face height in good light.')
						)}
					{:else}
						<div class="capture-empty operator-empty">
							<span class="capture-icon"><UserRound size={30} strokeWidth={1.6} /></span>
							<div class="capture-choices">
								<button class="button button--primary" type="button" onclick={startOperatorCamera}>
									<Camera size={18} />
									{t('Take Pump Operator photo')}
								</button>
							</div>
							{#if cameraCaptureError}<p class="capture-error">{t(cameraCaptureError)}</p>{/if}
						</div>
					{/if}
				</div>

				{#if operatorPreviewUrl}
					<div class="second-step" data-testid="group-photo">
						<div class="section-heading">
							<div>
								<h2>{t('Pump Members photo')}</h2>
								<p>
									{t('Every Pump Member in the photo, every face clear and inside the frame.')}
									{t('Stand where all Pump Members are in good light and facing the camera.')}
								</p>
							</div>
						</div>
						{#if previewUrl}
							<div class="photo-preview">
								<img src={previewUrl} alt="Selected group attendance preview" />
								{#if status === 'submitting' || status === 'processing'}
									<div class="processing-overlay" aria-hidden="true">
										<LoaderCircle class="spin" size={30} />
									</div>
								{/if}
							</div>
							<div class="photo-meta">
								<span>{selectedFile?.name}</span>
								<span
									>{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(1)} MB` : ''}</span
								>
							</div>
						{:else if cameraCaptureActive && captureTarget === 'group'}
							{@render cameraCapturePanel(
								t('Keep all Pump Members inside the frame.'),
								t('Every Pump Member must be visible before you take the photo.')
							)}
						{:else}
							<div class="capture-empty">
								<span class="capture-icon"><Users size={34} strokeWidth={1.6} /></span>
								<div class="capture-choices">
									<button class="button button--primary" type="button" onclick={startGroupCamera}>
										<Camera size={18} />
										{t('Take Pump Members photo')}
									</button>
								</div>
								{#if cameraCaptureError}<p class="capture-error">{t(cameraCaptureError)}</p>{/if}
							</div>
						{/if}
					</div>
				{/if}
			</section>
		{/if}

		<aside class="session-panel" aria-live="polite">
			{#if status === 'submitting' || status === 'processing'}
				<div data-testid={status === 'submitting' ? 'status-submitting' : 'status-processing'}>
					<h2>{status === 'submitting' ? t('Sending the photo') : t('Reading attendance')}</h2>
					<ol class="processing-list">
						{#each processingLabels as label, index (label)}
							<li class:active={index === processingStep} class:complete={index < processingStep}>
								<span>{index < processingStep ? t('Done') : index + 1}</span>{t(label)}
							</li>
						{/each}
					</ol>
					<p class="muted">{t('Keep this page open while the group is processed.')}</p>
				</div>
			{:else if status === 'fraud'}
				<div class="result-state" data-testid="status-fraud">
					<span class="result-icon"><ShieldAlert size={25} /></span>
					<h2>{t('Fake Image Detected')}</h2>
					<p>
						{t(
							'This photo could not be verified as a live photo. Your login has been disabled and the plant manager has been notified. No attendance was recorded from this photo. Contact your plant manager or admin to get your login re-enabled.'
						)}
					</p>
				</div>
			{:else if status === 'failed'}
				<div class="result-state" data-testid="status-failed">
					<span class="result-icon"><ShieldAlert size={25} /></span>
					<h2>{t('Could not finish')}</h2>
					<p>{t(errorMsg)}</p>
					<div class="result-actions">
						<button class="button button--primary" type="button" onclick={retryFailedCapture}>
							<RefreshCw size={17} />
							{t('Retry')}
						</button>
						<button class="button button--secondary" type="button" onclick={resetCapture}
							>{t('Choose another')}</button
						>
					</div>
				</div>
			{:else if status === 'completed' && result}
				<div class="results" data-testid="result-screen">
					<div class="result-summary">
						{#if peopleFound > 0}
							<span class="result-icon result-icon--success"><Check size={25} /></span>
						{:else}
							<span class="result-icon"><ShieldAlert size={25} /></span>
						{/if}
						<div>
							<h2 data-testid="result-heading">
								{t(peopleFound === 1 ? '{n} person marked present' : '{n} people marked present', {
									n: peopleFound
								})}
							</h2>
							{#if result.fraud_flags?.length}
								<p data-testid="result-held">
									{t('{n} held for admin review', { n: result.fraud_flags.length })}
								</p>
							{/if}
						</div>
					</div>
					{#if locationHold}
						<div class="alert location-hold" data-testid="location-hold" role="status">
							<ShieldAlert size={18} aria-hidden="true" />
							<p>
								<strong>{t('Waiting for plant manager approval.')}</strong>
								{t(locationHold)}
								{t('The shift has started; the plant manager has been emailed to verify it.')}
							</p>
						</div>
					{/if}
					{#if result.liveness_summary?.suspicious || result.liveness_summary?.unverified}
						<div class="liveness-notice" data-testid="liveness-review-notice">
							<ShieldAlert size={18} aria-hidden="true" />
							<p>
								<strong
									>{t('{n} need review.', {
										n:
											(result.liveness_summary.suspicious || 0) +
											(result.liveness_summary.unverified || 0)
									})}</strong
								>
								{t('Check the marked faces before completing attendance.')}
							</p>
						</div>
					{/if}
					{#if result.photo_url}
						<div class="review-photo">
							<p class="photo-caption">{t('Submitted Pump Members photo')}</p>
							<img src={result.photo_url} alt="Corrected group attendance" />
						</div>
					{/if}

					{#if result.matched?.length}
						<div class="result-group">
							<h3>{t('Matched')} <span>{result.matched.length}</span></h3>
							<ul class="face-list">
								{#each result.matched as person (person.person_id)}
									<li>
										<button
											class="face-row"
											type="button"
											onclick={(event) => openWorkerPreview(person, 'matched', event.currentTarget)}
											aria-label={`Preview ${workerLabel(person)}`}
											data-testid="worker-preview-trigger"
										>
											{#if person.source_photo_crop_url}
												<img src={person.source_photo_crop_url} alt="" loading="lazy" />
											{:else}
												<span class="face-thumb-placeholder" aria-hidden="true"
													><UserRound size={16} /></span
												>
											{/if}
											<span class="face-label">{workerLabel(person)}</span>
											{#if livenessLabel(person)}
												<span
													class:liveness-warning={person.liveness_status !== 'live'}
													class="liveness-badge">{livenessLabel(person)}</span
												>
											{/if}
											<span class="face-row-icons">
												<Check size={16} aria-hidden="true" />
												<Eye size={15} aria-hidden="true" />
											</span>
										</button>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if result.new_persons?.length}
						<div class="result-group">
							<h3>{t('New people')} <span>{result.new_persons.length}</span></h3>
							<ul class="face-list">
								{#each result.new_persons as person (person.person_id)}
									<li>
										<button
											class="face-row"
											type="button"
											onclick={(event) => openWorkerPreview(person, 'new', event.currentTarget)}
											aria-label={`Preview ${workerLabel(person)}`}
											data-testid="worker-preview-trigger"
										>
											{#if person.source_photo_crop_url}
												<img src={person.source_photo_crop_url} alt="" loading="lazy" />
											{:else}
												<span class="face-thumb-placeholder" aria-hidden="true"
													><UserRound size={16} /></span
												>
											{/if}
											<span class="face-label">{workerLabel(person)}</span>
											{#if livenessLabel(person)}
												<span
													class:liveness-warning={person.liveness_status !== 'live'}
													class="liveness-badge">{livenessLabel(person)}</span
												>
											{/if}
											<span class="face-row-icons"><Eye size={15} aria-hidden="true" /></span>
										</button>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if result.fraud_flags?.length}
						<div class="result-group attention-group">
							<h3>{t('Needs review')} <span>{result.fraud_flags.length}</span></h3>
							<ul class="face-list">
								{#each result.fraud_flags as flag (flag.id)}
									{@const where = `${flag.other_pump_code || t('another pump')}${flag.other_plant_name ? ` (${flag.other_plant_name})` : ''}`}
									<li>
										<button
											class="face-row"
											type="button"
											onclick={(event) =>
												openHeldPreview(
													{
														group: 'held',
														label: tLabel(flag.person_label || t('Worker')),
														statusLabel: t('Already marked at {where}', { where }),
														source_photo_crop_url: flag.source_photo_crop_url
													},
													event.currentTarget
												)}
											aria-label={`Preview ${flag.person_label || 'held face'}`}
											data-testid="held-preview-trigger"
										>
											{#if flag.source_photo_crop_url}
												<img src={flag.source_photo_crop_url} alt="" loading="lazy" />
											{:else}
												<span class="face-thumb-placeholder" aria-hidden="true"
													><UserRound size={16} /></span
												>
											{/if}
											<span class="face-label">{tLabel(flag.person_label || t('Worker'))}</span>
											<span class="face-row-icons"><Eye size={15} aria-hidden="true" /></span>
										</button>
										<p data-testid="fraud-flag-line">
											{t(
												'A face in this photo matches {who}, already marked at {where}. Not counted here until an admin checks it.',
												{ who: tLabel(flag.person_label || t('a worker')), where }
											)}
										</p>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if result.unknown_faces?.length}
						<div class="result-group attention-group">
							<h3>{t('Awaiting guest review')} <span>{result.unknown_faces.length}</span></h3>
							<p>{t('These faces were saved for an administrator to review.')}</p>
							<ul class="face-list">
								{#each result.unknown_faces as face, index (face.id)}
									<li>
										<button
											class="face-row"
											type="button"
											onclick={(event) =>
												openHeldPreview(
													{
														group: 'guest',
														label: t('Guest {n}', { n: index + 1 }),
														statusLabel: t('Waiting for admin review'),
														source_photo_crop_url: face.face_crop_url
													},
													event.currentTarget
												)}
											aria-label={`Preview guest ${index + 1}`}
											data-testid="guest-preview-trigger"
										>
											{#if face.face_crop_url}
												<img src={face.face_crop_url} alt="" loading="lazy" />
											{:else}
												<span class="face-thumb-placeholder" aria-hidden="true"
													><UserRound size={16} /></span
												>
											{/if}
											<span class="face-label">{t('Guest {n}', { n: index + 1 })}</span>
											<span class="face-row-icons"><Eye size={15} aria-hidden="true" /></span>
										</button>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if unnamedWorkers.length}
						<div class="result-group name-group" data-testid="name-workers">
							<h3>
								{t('Name your workers')}
								<span data-testid="names-left"
									>{namesLeft ? t('{n} left', { n: namesLeft }) : t('All named')}</span
								>
							</h3>
							<p class="name-help">
								{t(
									'Write the full name of each worker. Attendance cannot be completed without it.'
								)}
							</p>
							<ul class="name-list">
								{#each unnamedWorkers as person (person.person_id)}
									<li>
										{#if person.source_photo_crop_url}
											<img src={person.source_photo_crop_url} alt="" loading="lazy" />
										{:else}
											<span class="face-thumb-placeholder" aria-hidden="true"
												><UserRound size={20} /></span
											>
										{/if}
										<label>
											<span>{workerLabel(person)}</span>
											<input
												type="text"
												autocomplete="off"
												autocapitalize="words"
												maxlength="60"
												required
												placeholder={t('Full name')}
												bind:value={workerNames[person.person_id]}
												aria-invalid={Boolean(nameError) &&
													(workerNames[person.person_id] ?? '').trim().length < 2}
												data-testid="worker-name-input"
											/>
										</label>
									</li>
								{/each}
							</ul>
							{#if nameError}<p class="capture-error" role="alert" data-testid="name-error">
									{nameError}
								</p>{/if}
						</div>
					{/if}

					<div class="result-review-actions">
						<p>{t('Check the count and face crops before completing this attendance.')}</p>
						{#if errorMsg}<p class="capture-error">{t(errorMsg)}</p>{/if}
						<button
							class="button button--primary full-button"
							type="button"
							onclick={requestAttendanceRetry}
							disabled={retryingSession}
						>
							<RefreshCw size={17} class={retryingSession ? 'spin' : ''} />
							{retryingSession ? t('Preparing retry') : t('Retry with better photo')}
						</button>
						<button
							class="button button--secondary full-button"
							type="button"
							onclick={approveAttendanceReview}
							disabled={approvingReview}
							aria-describedby={unnamedWorkers.length ? 'names-left-note' : undefined}
							data-testid="complete-review"
						>
							<Check size={17} />
							{approvingReview ? t('Completing attendance') : t('Done reviewing')}
						</button>
						{#if unnamedWorkers.length && namesLeft}
							<p id="names-left-note">{t('{n} names still to write above.', { n: namesLeft })}</p>
						{/if}
					</div>
				</div>
			{:else}
				<div class="session-details">
					<h2>{t('Shift details')}</h2>
					<dl>
						{#if today?.shift_started_at}
							<div>
								<dt>{t('Started')}</dt>
								<dd>{formatIST(today.shift_started_at)}</dd>
							</div>
						{/if}
						<div>
							<dt>{t('Next step')}</dt>
							<dd data-testid="next-step">
								{today?.state === 'locked'
									? today?.shift_outcome === 'start_only'
										? t('Shift ended without an end photo. The next shift starts tomorrow.')
										: t('Shift recorded. The next shift starts tomorrow.')
									: today?.state === 'review'
										? t('Finish reviewing the submitted Pump Members photo')
										: today?.state === 'failed'
											? t('Retry the photo that could not be processed')
											: today?.state === 'evening' && today?.can_submit === false
												? t('Shift end opens {time}', { time: formatIST(today?.next_allowed_at) })
												: today?.state === 'evening'
													? t('Send the photos to end the shift')
													: t('Send the photos to start the shift')}
							</dd>
						</div>
					</dl>
				</div>
			{/if}
		</aside>
	</div>

	{#if operatorFile && status === 'idle'}
		<div class="sticky-submit">
			<button
				class="button button--primary"
				type="button"
				onclick={submitPhoto}
				disabled={!selectedFile}
			>
				<Upload size={18} />
				{selectedFile ? t('Submit photos') : t('Take the Pump Members photo first')}
			</button>
			<button class="button button--ghost" type="button" onclick={resetCapture}
				>{t('Cancel')}</button
			>
		</div>
	{/if}

	{#if selectedWorkerPreview}
		<button
			class="worker-preview-backdrop"
			type="button"
			onclick={closeWorkerPreview}
			aria-label="Dismiss worker preview"
		></button>
		<div
			bind:this={workerPreviewDialog}
			class="worker-preview-dialog"
			role="dialog"
			tabindex="-1"
			aria-modal="true"
			aria-labelledby="worker-preview-title"
			data-testid="worker-preview"
		>
			<header class="worker-preview-header">
				<div>
					<h2 id="worker-preview-title">{selectedWorkerPreview.label}</h2>
					<p class="preview-status">{selectedWorkerPreview.statusLabel}</p>
				</div>
				<button
					bind:this={workerPreviewCloseButton}
					class="icon-button"
					type="button"
					onclick={closeWorkerPreview}
					aria-label="Close worker preview"
					title="Close worker preview"
				>
					<X size={20} />
				</button>
			</header>

			<div class="worker-preview-image" data-testid="worker-preview-image">
				{#if selectedWorkerPreview.source_photo_crop_url}
					<img
						src={selectedWorkerPreview.source_photo_crop_url}
						alt={`Face crop for ${selectedWorkerPreview.label}`}
					/>
				{:else}
					<div class="worker-preview-empty">
						<UserRound size={44} strokeWidth={1.5} />
						<span>{t('No face crop was returned for this worker.')}</span>
					</div>
				{/if}
			</div>

			<dl class="worker-preview-meta">
				<div>
					<dt>{t('Session')}</dt>
					<dd>{result?.session_type === 'evening' ? t('Shift end') : t('Shift start')}</dd>
				</div>
				<div>
					<dt>{t('Result')}</dt>
					<dd>{selectedWorkerPreview.statusLabel}</dd>
				</div>
				<div>
					<dt>{t('Daily match')}</dt>
					<dd>
						{#if selectedWorkerPreview.group === 'held' || selectedWorkerPreview.group === 'guest'}
							{t('Not counted until an admin checks it')}
						{:else}
							{selectedWorkerPreview.morning_matched ? t('Start') : ''}
							{selectedWorkerPreview.morning_matched && selectedWorkerPreview.evening_matched
								? ` ${t('and')} `
								: ''}
							{selectedWorkerPreview.evening_matched ? t('End') : ''}
							{!selectedWorkerPreview.morning_matched && !selectedWorkerPreview.evening_matched
								? t('New attendance')
								: ''}
						{/if}
					</dd>
				</div>
			</dl>
		</div>
	{/if}
</div>

<style>
	.capture-page {
		width: min(100%, 72rem);
		margin: 0 auto;
		padding: clamp(1.25rem, 4vw, 2.5rem);
		padding-bottom: 7rem;
	}

	.capture-heading,
	.section-heading,
	.result-summary,
	.photo-meta {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: var(--space-4);
	}

	/* Page heading: what to do now and which pump on the left; the date and the shift state
	   on the right, both columns starting on the same top line. */
	.capture-heading {
		align-items: flex-start;
		margin-bottom: var(--space-5);
	}
	.heading-main {
		display: grid;
		gap: var(--space-1);
		min-width: 0;
	}
	.heading-side {
		display: grid;
		flex-shrink: 0;
		justify-items: end;
		gap: var(--space-2);
	}
	.heading-date {
		display: grid;
		justify-items: end;
		gap: 0.125rem;
		text-align: right;
		line-height: 1.2;
	}
	.heading-date span {
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
	}
	.heading-date strong {
		color: var(--ink-strong);
		font-size: var(--text-lg);
		font-weight: 800;
		font-variant-numeric: tabular-nums;
		white-space: nowrap;
	}
	.capture-heading h1 {
		margin: 0;
		font-size: var(--text-3xl);
		line-height: 1.15;
	}
	.heading-main p,
	.section-heading p {
		margin: 0;
		color: var(--ink-muted);
	}
	.preview-status {
		margin: var(--space-1) 0 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 600;
	}

	.capture-layout {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 0.8fr);
		gap: var(--space-5);
		align-items: start;
	}
	/* Only the shift details are left (no photo can be sent now): one column, the same width as
	   the heading above it, sized to its content. */
	.capture-layout:not(:has(.capture-workspace)) {
		grid-template-columns: minmax(0, 1fr);
	}
	.capture-layout:not(:has(.capture-workspace)) .session-panel {
		min-height: 0;
	}

	.capture-workspace,
	.session-panel {
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
	}

	.capture-workspace {
		padding: var(--space-5);
	}
	.session-panel {
		min-height: 18rem;
		padding: var(--space-5);
	}
	.section-heading {
		margin-bottom: var(--space-4);
	}
	.section-heading > div {
		display: grid;
		gap: var(--space-1);
	}
	.section-heading h2,
	.session-panel h2 {
		margin: 0;
		font-size: var(--text-xl);
	}

	.capture-empty {
		display: grid;
		min-height: 16rem;
		place-items: center;
		align-content: center;
		gap: var(--space-5);
		padding: var(--space-6);
		text-align: center;
		background: var(--surface-subtle);
		border: 1px dashed var(--brand-steel);
		border-radius: var(--radius-md);
	}

	.capture-empty p {
		max-width: 27rem;
		margin: var(--space-2) auto var(--space-5);
		color: var(--ink-muted);
	}
	.capture-icon,
	.result-icon {
		display: grid;
		width: 3.25rem;
		height: 3.25rem;
		place-items: center;
		color: var(--brand-teal);
		background: var(--primary-tint);
		border-radius: var(--radius-md);
	}
	.capture-choices,
	.result-actions {
		display: flex;
		flex-wrap: wrap;
		justify-content: center;
		gap: var(--space-2);
	}

	.second-step {
		display: grid;
		gap: var(--space-3);
		margin-top: var(--space-5);
		padding-top: var(--space-5);
		border-top: 1px solid var(--brand-mist);
	}
	.second-step .section-heading {
		margin-bottom: 0;
	}
	.operator-preview {
		max-width: 20rem;
	}
	.operator-empty {
		min-height: 14rem;
	}
	.photo-preview {
		position: relative;
		overflow: hidden;
		aspect-ratio: 4 / 3;
		background: var(--surface-muted);
		border-radius: var(--radius-md);
	}
	.photo-preview img {
		width: 100%;
		height: 100%;
		object-fit: contain;
	}
	.processing-overlay {
		position: absolute;
		inset: 0;
		display: grid;
		place-items: center;
		color: var(--brand-white);
		background: color-mix(in srgb, var(--ink-strong) 55%, transparent);
	}
	.photo-meta {
		margin-top: var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.photo-meta span:first-child {
		overflow: hidden;
		color: var(--ink-default);
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.screen-capture-panel {
		display: grid;
		gap: var(--space-3);
	}
	.screen-preview {
		overflow: hidden;
		aspect-ratio: 16 / 9;
		background: var(--ink-strong);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.screen-preview video {
		width: 100%;
		height: 100%;
		object-fit: contain;
		background: var(--ink-strong);
	}
	.screen-actions {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-2);
	}
	.camera-capture-guidance {
		display: none;
	}
	.location-hold {
		margin-bottom: var(--space-3);
		background: #fff6dd;
		border-color: #f0d48a;
	}
	.location-hold p {
		margin: 0;
	}
	.camera-capture-panel:where(:fullscreen) {
		display: flex;
		flex-direction: column;
		padding: var(--space-3);
		background: var(--ink-strong);
	}
	.camera-capture-panel:where(:fullscreen) .screen-preview {
		flex: 1;
		min-height: 0;
		aspect-ratio: auto;
		border: 0;
	}
	.capture-note,
	.capture-error {
		margin: 0;
		font-size: var(--text-sm);
	}
	.capture-note {
		color: var(--ink-muted);
	}
	.capture-error {
		color: #9f1239;
		font-weight: 700;
	}

	.processing-list {
		display: grid;
		gap: var(--space-3);
		padding: 0;
		margin: var(--space-6) 0;
		list-style: none;
	}
	.processing-list li {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		color: var(--ink-muted);
	}
	.processing-list li span {
		display: grid;
		width: 1.75rem;
		height: 1.75rem;
		place-items: center;
		border: 1px solid var(--brand-mist);
		border-radius: 50%;
	}
	.processing-list li.active {
		color: var(--ink-strong);
		font-weight: 700;
	}
	.processing-list li.active span,
	.processing-list li.complete span {
		color: var(--primary-on);
		background: var(--brand-teal);
		border-color: var(--brand-teal);
	}
	.muted {
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}

	.result-state {
		display: grid;
		justify-items: start;
	}
	.result-state h2 {
		margin: var(--space-4) 0 var(--space-2);
	}
	.result-state p {
		color: var(--ink-muted);
	}
	.result-icon--success {
		color: var(--primary-on);
		background: var(--brand-teal);
	}
	.result-summary {
		justify-content: flex-start;
		padding-bottom: var(--space-5);
		border-bottom: 1px solid var(--brand-mist);
	}
	.review-photo {
		display: grid;
		gap: var(--space-2);
		margin: var(--space-4) 0;
	}
	.photo-caption {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
		font-weight: 600;
	}
	.review-photo img {
		display: block;
		width: 100%;
		max-height: 24rem;
		object-fit: contain;
		background: var(--surface-muted);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.result-summary h2 {
		margin-top: var(--space-1);
	}
	.result-group {
		padding: var(--space-4) 0;
		border-bottom: 1px solid var(--brand-mist);
	}
	.result-group h3 {
		display: flex;
		justify-content: space-between;
		margin: 0 0 var(--space-3);
		font-size: var(--text-sm);
	}
	.result-group h3 span {
		color: var(--ink-muted);
	}
	.face-list {
		display: grid;
		gap: var(--space-2);
		padding: 0;
		margin: 0;
		list-style: none;
	}
	.face-list li {
		min-width: 0;
	}
	.face-row {
		display: grid;
		grid-template-columns: 2.25rem minmax(0, 1fr) auto auto;
		align-items: center;
		gap: var(--space-2);
		width: 100%;
		min-height: 2.25rem;
		padding: 0.2rem;
		color: var(--ink-strong);
		text-align: left;
		background: transparent;
		border: 1px solid transparent;
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	.face-row:hover {
		background: var(--surface-muted);
		border-color: var(--brand-mist);
	}
	.face-row:focus-visible {
		outline: 3px solid rgba(5, 173, 152, 0.28);
		outline-offset: 2px;
	}
	.face-row img,
	.face-thumb-placeholder {
		width: 2.25rem;
		height: 2.25rem;
		border-radius: var(--radius-sm);
	}
	.face-row img {
		object-fit: cover;
	}
	.face-thumb-placeholder {
		display: grid;
		place-items: center;
		color: var(--ink-muted);
		background: var(--surface-muted);
		border: 1px solid var(--brand-mist);
	}
	.face-label {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-weight: 700;
	}
	.face-row-icons {
		display: inline-flex;
		align-items: center;
		gap: var(--space-1);
		color: var(--brand-teal);
	}
	.face-row-icons :global(svg:last-child) {
		color: var(--ink-muted);
	}
	.face-row:hover .face-row-icons :global(svg:last-child),
	.face-row:focus-visible .face-row-icons :global(svg:last-child) {
		color: var(--brand-teal);
	}
	.liveness-badge {
		padding: 0.15rem 0.4rem;
		color: #047857;
		font-size: 0.75rem;
		font-weight: 700;
		background: #ecfdf5;
		border: 1px solid #a7f3d0;
		border-radius: var(--radius-sm);
		white-space: nowrap;
	}
	.liveness-badge.liveness-warning {
		color: #92400e;
		background: #fffbeb;
		border-color: #fde68a;
	}
	.liveness-notice {
		display: flex;
		align-items: flex-start;
		gap: var(--space-2);
		padding: var(--space-3);
		color: #92400e;
		background: #fffbeb;
		border: 1px solid #fde68a;
		border-radius: var(--radius-sm);
	}
	.liveness-notice p {
		margin: 0;
	}
	.attention-group p {
		margin: var(--space-2) 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	/* Naming: one row per unnamed worker, big face so the operator knows who to name. */
	.name-group h3 span {
		color: var(--brand-teal);
	}
	.name-help {
		margin: 0 0 var(--space-3);
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.name-list {
		display: grid;
		gap: var(--space-3);
		padding: 0;
		margin: 0;
		list-style: none;
	}
	.name-list li {
		display: grid;
		grid-template-columns: 3.5rem minmax(0, 1fr);
		align-items: center;
		gap: var(--space-3);
	}
	.name-list img,
	.name-list .face-thumb-placeholder {
		width: 3.5rem;
		height: 3.5rem;
		object-fit: cover;
		border-radius: var(--radius-sm);
	}
	.name-list label {
		display: grid;
		gap: 0.2rem;
		min-width: 0;
	}
	.name-list label span {
		overflow: hidden;
		color: var(--ink-muted);
		font-size: var(--text-xs, 0.75rem);
		font-weight: 700;
		text-overflow: ellipsis;
		white-space: nowrap;
	}
	.name-list input {
		width: 100%;
		min-height: 2.75rem;
		font-size: 1rem;
	}
	.name-list input[aria-invalid='true'] {
		border-color: #9f1239;
	}
	.name-group .capture-error {
		margin: var(--space-3) 0 0;
		color: #9f1239;
	}
	.result-review-actions {
		display: grid;
		gap: var(--space-2);
		padding-top: var(--space-4);
	}
	.result-review-actions p {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-sm);
	}
	.result-review-actions .capture-error {
		color: #9f1239;
	}
	.full-button {
		width: 100%;
	}

	.worker-preview-backdrop {
		position: fixed;
		inset: 0;
		z-index: var(--z-backdrop);
		padding: 0;
		background: rgba(0, 0, 0, 0.42);
		border: 0;
		cursor: pointer;
		appearance: none;
	}
	.worker-preview-dialog {
		position: fixed;
		top: 50%;
		left: 50%;
		z-index: var(--z-drawer);
		display: grid;
		gap: var(--space-4);
		width: min(calc(100vw - 2rem), 30rem);
		max-height: min(44rem, calc(100vh - 2rem));
		overflow: auto;
		padding: var(--space-5);
		background: var(--brand-white);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-lg);
		box-shadow: var(--shadow-lg);
		transform: translate(-50%, -50%);
	}
	.worker-preview-header {
		display: flex;
		align-items: start;
		justify-content: space-between;
		gap: var(--space-4);
	}
	.worker-preview-header h2 {
		margin: var(--space-1) 0 0;
		font-size: var(--text-xl);
	}
	.icon-button {
		display: grid;
		width: 2.5rem;
		height: 2.5rem;
		flex: 0 0 auto;
		place-items: center;
		color: var(--ink-muted);
		background: var(--surface-muted);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-sm);
		cursor: pointer;
	}
	.icon-button:hover,
	.icon-button:focus-visible {
		color: var(--ink-strong);
		border-color: var(--brand-steel);
	}
	.worker-preview-image {
		display: grid;
		min-height: 16rem;
		place-items: center;
		overflow: hidden;
		background: var(--surface-muted);
		border: 1px solid var(--brand-mist);
		border-radius: var(--radius-md);
	}
	.worker-preview-image img {
		display: block;
		width: 100%;
		max-height: 24rem;
		object-fit: contain;
	}
	.worker-preview-empty {
		display: grid;
		gap: var(--space-2);
		place-items: center;
		padding: var(--space-5);
		color: var(--ink-muted);
		text-align: center;
	}
	.worker-preview-meta {
		display: grid;
		gap: var(--space-2);
		margin: 0;
	}
	.worker-preview-meta div {
		display: flex;
		justify-content: space-between;
		gap: var(--space-4);
		padding: var(--space-2) 0;
		border-bottom: 1px solid var(--brand-mist);
	}
	.worker-preview-meta div:last-child {
		border-bottom: 0;
	}
	.worker-preview-meta dt {
		color: var(--ink-muted);
		font-weight: 700;
	}
	.worker-preview-meta dd {
		margin: 0;
		text-align: right;
	}

	/* Label and value rows share one label column, so every value starts on the same line and
	   a long value wraps under itself, not under its label. */
	.session-details dl {
		display: grid;
		grid-template-columns: minmax(5.5rem, max-content) minmax(0, 1fr);
		margin: var(--space-4) 0 0;
	}
	.session-details dl div {
		display: grid;
		grid-column: 1 / -1;
		grid-template-columns: subgrid;
		column-gap: var(--space-4);
		padding: var(--space-3) 0;
		border-top: 1px solid var(--brand-mist);
	}
	.session-details dt {
		color: var(--ink-muted);
	}
	.session-details dd {
		margin: 0;
		color: var(--ink-strong);
		font-weight: 600;
		font-variant-numeric: tabular-nums;
	}

	.sticky-submit {
		position: fixed;
		z-index: var(--z-sticky);
		right: 0;
		bottom: 0;
		left: 0;
		display: flex;
		justify-content: center;
		gap: var(--space-2);
		padding: var(--space-3) var(--space-4) max(var(--space-3), env(safe-area-inset-bottom));
		background: var(--brand-white);
		border-top: 1px solid var(--brand-mist);
		box-shadow: var(--shadow-lg);
	}

	:global(.spin) {
		animation: spin 0.8s linear infinite;
	}
	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}

	@media (max-width: 48rem) {
		.capture-page {
			padding: var(--space-4);
			padding-bottom: 7rem;
		}
		.capture-heading {
			align-items: flex-start;
		}
		.capture-layout {
			grid-template-columns: 1fr;
		}
		.capture-workspace {
			padding: var(--space-4);
		}
		.capture-empty {
			min-height: 13rem;
			padding: var(--space-5);
		}
		.session-panel {
			min-height: auto;
			padding: var(--space-4);
		}
	}

	/* Full-screen camera on phones, portrait or landscape (a landscape phone is wider than 48rem). */
	@media (max-width: 48rem), (pointer: coarse) and (max-height: 32rem) {
		.camera-capture-panel {
			position: fixed;
			inset: 0;
			z-index: calc(var(--z-sticky) + 1);
			display: flex;
			flex-direction: column;
			min-height: 100dvh;
			padding: max(var(--space-4), env(safe-area-inset-top)) var(--space-4)
				max(var(--space-4), env(safe-area-inset-bottom));
			background: var(--ink-strong);
		}
		.camera-capture-panel .screen-preview {
			flex: 1;
			min-height: 0;
			aspect-ratio: auto;
			border: 0;
			border-radius: 0;
		}
		.camera-capture-panel .screen-preview video {
			object-fit: contain;
		}
		.camera-capture-guidance {
			display: block;
			margin: 0;
			color: var(--brand-white);
			font-size: var(--text-sm);
			text-align: center;
		}
		.camera-capture-panel .screen-actions {
			display: grid;
			grid-template-columns: repeat(2, minmax(0, 1fr));
			width: 100%;
		}
		.camera-capture-panel .screen-actions .button:first-child {
			grid-column: 1 / -1;
		}
		.camera-capture-panel .screen-actions .button {
			justify-content: center;
			min-height: 3.25rem;
		}
		.camera-capture-panel .capture-note {
			display: none;
		}
	}

	/* Landscape phone: video fills the left, buttons stack on the right. */
	@media (pointer: coarse) and (max-height: 32rem) and (orientation: landscape) {
		.camera-capture-panel {
			display: grid;
			grid-template-columns: minmax(0, 1fr) 14rem;
			grid-template-rows: minmax(0, 1fr) auto;
			gap: var(--space-2) var(--space-3);
			padding: var(--space-2) max(var(--space-3), env(safe-area-inset-right)) var(--space-2)
				max(var(--space-3), env(safe-area-inset-left));
		}
		.camera-capture-panel .screen-preview {
			grid-row: 1 / -1;
			height: 100%;
		}
		.camera-capture-panel .screen-actions {
			grid-template-columns: 1fr;
			align-content: center;
		}
		.camera-capture-panel .screen-actions .button {
			min-height: 2.75rem;
		}
		.camera-capture-guidance {
			grid-column: 2;
			grid-row: 2;
		}
	}

	@media (max-width: 30rem) {
		.capture-heading h1 {
			font-size: var(--text-2xl);
		}
		/* The page heading leads; card headings sit one step below it. */
		.section-heading h2,
		.session-panel h2 {
			font-size: var(--text-lg);
		}
		.capture-choices {
			width: 100%;
		}
		.capture-choices .button {
			width: 100%;
		}
		.sticky-submit .button:first-child {
			flex: 1;
		}
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.spin) {
			animation: none;
		}
	}
</style>
