<script lang="ts">
	import { onDestroy, onMount, tick } from 'svelte';
	import Camera from '@lucide/svelte/icons/camera';
	import Check from '@lucide/svelte/icons/check';
	import Eye from '@lucide/svelte/icons/eye';
	import LoaderCircle from '@lucide/svelte/icons/loader-circle';
	import MonitorUp from '@lucide/svelte/icons/monitor-up';
	import RefreshCw from '@lucide/svelte/icons/refresh-cw';
	import ShieldAlert from '@lucide/svelte/icons/shield-alert';
	import SwitchCamera from '@lucide/svelte/icons/switch-camera';
	import Upload from '@lucide/svelte/icons/upload';
	import UserRound from '@lucide/svelte/icons/user-round';
	import Users from '@lucide/svelte/icons/users';
	import X from '@lucide/svelte/icons/x';
	import { personDisplayLabel } from '$lib/personLabel';

	type FlowStatus = 'idle' | 'submitting' | 'processing' | 'completed' | 'failed' | 'fraud';
	type WorkerResult = {
		person_id: string;
		display_seq: number;
		pump_code: string;
		source_photo_crop_url?: string | null;
		morning_matched?: boolean;
		evening_matched?: boolean;
		first_seen_at?: string;
		liveness_status?: 'live' | 'suspicious' | 'unverified';
		liveness_score?: number | null;
		liveness_reason?: string | null;
	};

	function livenessLabel(person: WorkerResult) {
		if (person.liveness_status === 'live') return 'Live check passed';
		if (person.liveness_status === 'suspicious') return 'Needs review';
		return 'Could not verify';
	}
	type WorkerPreview = WorkerResult & {
		group: 'matched' | 'new';
		label: string;
		statusLabel: string;
	};

	let status = $state<FlowStatus>('idle');
	let errorMsg = $state('');
	let selectedFile = $state<File | null>(null);
	let previewUrl = $state('');
	let result = $state<any>(null);
	let today = $state<any>(null);
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
	let screenStream = $state<MediaStream | null>(null);
	let screenPreview = $state<HTMLVideoElement>();
	let screenCaptureActive = $state(false);
	let screenCaptureReady = $state(false);
	let screenCaptureError = $state('');

	const processingLabels = ['Photo received', 'Detecting faces', 'Matching attendance'];

	onMount(loadToday);
	onDestroy(() => {
		clearPreview();
		stopCameraCapture();
		stopScreenCapture();
	});

	async function loadToday() {
		todayLoading = true;
		try {
			const res = await fetch('/api/attendance/today');
			if (!res.ok) return;
			today = await res.json();
			if (today.review_session_id && status === 'idle') {
				const review = await fetch(`/api/attendance/status/${today.review_session_id}`);
				if (review.ok) {
					result = await review.json();
					currentSessionId = today.review_session_id;
					status = 'completed';
				}
			}
		} finally {
			todayLoading = false;
		}
	}

	function clearPreview() {
		if (previewUrl) URL.revokeObjectURL(previewUrl);
		previewUrl = '';
	}

	function stopScreenCapture() {
		if (screenStream) {
			for (const track of screenStream.getTracks()) track.stop();
		}
		screenStream = null;
		screenCaptureActive = false;
		screenCaptureReady = false;
	}

	function stopCameraCapture() {
		if (cameraStream) {
			for (const track of cameraStream.getTracks()) track.stop();
		}
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
		result = null;
		selectedWorkerPreview = null;
		errorMsg = '';
		currentSessionId = '';
		retryingSession = false;
		approvingReview = false;
		cameraCaptureError = '';
		screenCaptureError = '';
		status = 'idle';
		stopCameraCapture();
		stopScreenCapture();
		loadToday();
	}

	async function startCameraCapture() {
		cameraCaptureError = '';
		screenCaptureError = '';
		errorMsg = '';
		result = null;
		selectedWorkerPreview = null;
		status = 'idle';
		clearPreview();
		selectedFile = null;
		cameraCaptureReady = false;
		canSwitchCamera = false;
		stopScreenCapture();
		stopCameraCapture();

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
		await startCameraCapture();
	}

	async function captureCameraFrame() {
		if (!cameraPreview || !cameraPreview.videoWidth || !cameraPreview.videoHeight) {
			cameraCaptureError = 'The camera preview is not ready yet.';
			return;
		}

		const sourceWidth = cameraPreview.videoWidth;
		const sourceHeight = cameraPreview.videoHeight;
		const canvas = document.createElement('canvas');
		canvas.width = sourceWidth;
		canvas.height = sourceHeight;
		const context = canvas.getContext('2d');
		if (!context) {
			cameraCaptureError = 'Could not capture the camera frame.';
			return;
		}

		context.drawImage(cameraPreview, 0, 0, sourceWidth, sourceHeight);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/jpeg', 0.92)
		);
		if (!blob) {
			cameraCaptureError = 'Could not create a photo from the camera frame.';
			return;
		}

		const sessionName = today?.state === 'evening' ? 'evening' : 'morning';
		const file = new File([blob], `camera-${sessionName}-${Date.now()}.jpg`, {
			type: 'image/jpeg'
		});

		clearPreview();
		selectedFile = file;
		previewUrl = URL.createObjectURL(file);
		cameraCaptureError = '';
		status = 'idle';
		stopCameraCapture();
	}

	async function startScreenCapture() {
		cameraCaptureError = '';
		screenCaptureError = '';
		errorMsg = '';
		result = null;
		selectedWorkerPreview = null;
		status = 'idle';
		clearPreview();
		selectedFile = null;
		screenCaptureReady = false;
		stopCameraCapture();
		stopScreenCapture();

		if (!navigator.mediaDevices?.getDisplayMedia) {
			screenCaptureError = 'Screen capture is not supported in this browser. Use Chrome or Edge.';
			return;
		}

		try {
			screenStream = await navigator.mediaDevices.getDisplayMedia({
				video: { frameRate: { ideal: 10, max: 15 } },
				audio: false
			});
			screenCaptureActive = true;
			const [track] = screenStream.getVideoTracks();
			track?.addEventListener('ended', () => {
				screenStream = null;
				screenCaptureActive = false;
			});
			await tick();
			if (screenPreview) {
				screenPreview.srcObject = screenStream;
				await screenPreview.play().catch(() => {});
				screenCaptureReady = Boolean(screenPreview.videoWidth && screenPreview.videoHeight);
			}
		} catch (error) {
			screenCaptureError =
				error instanceof DOMException && error.name === 'NotAllowedError'
					? 'Screen capture permission was cancelled.'
					: 'Could not start screen capture. Please select the WhatsApp call window again.';
		}
	}

	async function captureScreenFrame() {
		if (!screenPreview || !screenPreview.videoWidth || !screenPreview.videoHeight) {
			screenCaptureError = 'The selected video window is not ready yet.';
			return;
		}

		const canvas = document.createElement('canvas');
		canvas.width = screenPreview.videoWidth;
		canvas.height = screenPreview.videoHeight;
		const context = canvas.getContext('2d');
		if (!context) {
			screenCaptureError = 'Could not capture the selected window.';
			return;
		}

		context.drawImage(screenPreview, 0, 0, canvas.width, canvas.height);
		const blob = await new Promise<Blob | null>((resolve) =>
			canvas.toBlob(resolve, 'image/jpeg', 0.92)
		);
		if (!blob) {
			screenCaptureError = 'Could not create a photo from the selected window.';
			return;
		}

		const sessionName = today?.state === 'evening' ? 'evening' : 'morning';
		const file = new File([blob], `video-call-${sessionName}-${Date.now()}.jpg`, {
			type: 'image/jpeg'
		});

		clearPreview();
		selectedFile = file;
		previewUrl = URL.createObjectURL(file);
		screenCaptureError = '';
		status = 'idle';
		stopScreenCapture();
	}
	async function submitPhoto() {
		if (!selectedFile) return;
		errorMsg = '';
		selectedWorkerPreview = null;
		retryingSession = false;
		currentSessionId = '';
		status = 'submitting';

		const form = new FormData();
		form.append('photo', selectedFile);

		try {
			const res = await fetch('/api/attendance/submit', { method: 'POST', body: form });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				status = 'failed';
				errorMsg = body.error || 'The photo could not be submitted.';
				return;
			}

			currentSessionId = body.session_id;
			status = 'processing';
			processingStep = 0;
			await poll(body.session_id);
		} catch {
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
			const res = await fetch(`/api/attendance/retry/${sessionId}`, { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				errorMsg =
					body.error || 'Could not prepare retry. Please ask admin to review this attendance.';
				retryingSession = false;
				return;
			}
			resetCapture();
		} catch {
			errorMsg = 'Could not connect to prepare retry. Please try again.';
			retryingSession = false;
		}
	}

	async function approveAttendanceReview() {
		const sessionId = result?.session_id || currentSessionId;
		if (!sessionId || approvingReview) return;

		approvingReview = true;
		errorMsg = '';
		try {
			const res = await fetch(`/api/attendance/approve/${sessionId}`, { method: 'POST' });
			const body = await res.json().catch(() => ({}));
			if (!res.ok) {
				errorMsg = body.error || 'Could not complete this attendance review.';
				approvingReview = false;
				return;
			}
			resetCapture();
		} catch {
			errorMsg = 'Could not connect to complete this attendance review.';
			approvingReview = false;
		}
	}

	async function retryFailedCapture() {
		if (result?.session_id || currentSessionId) {
			await requestAttendanceRetry();
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
				const res = await fetch(`/api/attendance/status/${sessionId}`);
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
					return;
				}
				if (body.status === 'fraud_detected') {
					status = 'fraud';
					return;
				}
			} catch {
				connectionFailures += 1;
				if (connectionFailures >= 5) {
					status = 'failed';
					errorMsg = 'The connection was interrupted while checking the result.';
					return;
				}
			}
		}
		status = 'failed';
		errorMsg = 'Processing is taking longer than expected. Please retry the status check.';
	}

	const sessionTitle = $derived.by(() => {
		if (today?.state === 'locked') return 'Attendance complete';
		if (today?.state === 'review') return 'Review attendance';
		if (today?.state === 'evening' && today?.can_submit === false)
			return 'Evening attendance scheduled';
		if (today?.state === 'evening') return 'Evening attendance';
		return 'Morning attendance';
	});

	function formatIST(value: string | null | undefined) {
		if (!value) return '';
		return new Intl.DateTimeFormat('en-IN', {
			dateStyle: 'medium',
			timeStyle: 'short',
			timeZone: 'Asia/Kolkata'
		}).format(new Date(value));
	}

	async function openWorkerPreview(
		person: WorkerResult,
		group: 'matched' | 'new',
		trigger: HTMLButtonElement
	) {
		const label = personDisplayLabel(person.pump_code, person.display_seq);
		workerPreviewTrigger = trigger;
		selectedWorkerPreview = {
			...person,
			group,
			label,
			statusLabel: `${group === 'matched' ? 'Matched existing worker' : 'New worker found'} · ${livenessLabel(person)}`
		};
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

<div class="capture-page">
	<header class="capture-heading">
		<div>
			<p class="eyebrow">Today's session</p>
			<h1 data-testid="session-title">{sessionTitle}</h1>
			<p>
				{today?.pump_code ? `${today.pump_code} - ${today.plant_name}` : 'Group photo attendance'}
			</p>
		</div>
		{#if todayLoading}
			<span class="status-badge"><LoaderCircle class="spin" size={14} /> Checking</span>
		{:else if today?.state === 'locked'}
			<span class="status-badge status-badge--success"><Check size={14} /> Complete</span>
		{:else}
			<span class="status-badge">
				{today?.can_submit === false
					? 'Waiting'
					: `${today?.state === 'evening' ? 'Evening' : 'Morning'} open`}
			</span>
		{/if}
	</header>

	<div class="capture-layout">
		{#if !(status === 'completed' && result)}
			<section class="capture-workspace" aria-labelledby="photo-heading">
				<div class="section-heading">
					<div>
						<h2 id="photo-heading">Group photo</h2>
						<p>Keep every face visible and inside the frame.</p>
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
						<span>{selectedFile ? `${(selectedFile.size / 1024 / 1024).toFixed(1)} MB` : ''}</span>
					</div>
				{:else if cameraCaptureActive}
					<div class="screen-capture-panel camera-capture-panel" aria-label="Camera capture">
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
						<p class="camera-capture-guidance">Keep the complete group inside the frame.</p>
						<div class="screen-actions">
							<button
								class="button button--primary"
								type="button"
								onclick={captureCameraFrame}
								disabled={!cameraCaptureReady}
							>
								<Camera size={18} /> Use this photo
							</button>
							<button class="button button--secondary" type="button" onclick={stopCameraCapture}>
								Stop camera
							</button>
							{#if canSwitchCamera}
								<button
									class="button button--secondary"
									type="button"
									onclick={switchCamera}
									aria-label={cameraFacingMode === 'environment'
										? 'Switch to front camera'
										: 'Switch to rear camera'}
								>
									<SwitchCamera size={18} />
									{cameraFacingMode === 'environment' ? 'Use front camera' : 'Use rear camera'}
								</button>
							{/if}
						</div>
						<p class="capture-note">Keep every worker visible before capturing the photo.</p>
						{#if cameraCaptureError}<p class="capture-error">{cameraCaptureError}</p>{/if}
					</div>
				{:else if screenCaptureActive}
					<div class="screen-capture-panel">
						<div class="screen-preview">
							<video
								bind:this={screenPreview}
								autoplay
								muted
								playsinline
								onloadedmetadata={() => (screenCaptureReady = true)}
								oncanplay={() => (screenCaptureReady = true)}
								aria-label="Selected video call preview"
							></video>
						</div>
						<div class="screen-actions">
							<button
								class="button button--primary"
								type="button"
								onclick={captureScreenFrame}
								disabled={!screenCaptureReady}
							>
								<Camera size={18} /> Use this frame
							</button>
							<button class="button button--secondary" type="button" onclick={stopScreenCapture}>
								Stop sharing
							</button>
						</div>
						<p class="capture-note">
							Keep every worker visible in the WhatsApp call before capturing.
						</p>
						{#if screenCaptureError}<p class="capture-error">{screenCaptureError}</p>{/if}
					</div>
				{:else}
					<div class="capture-empty">
						<span class="capture-icon"><Users size={34} strokeWidth={1.6} /></span>
						<strong>Ready for the team photo</strong>
						<p>Stand where the whole group is evenly lit and facing the camera.</p>
						<div class="capture-choices">
							<button
								class="button button--primary"
								type="button"
								onclick={startCameraCapture}
								disabled={today?.state === 'locked' || today?.can_submit === false}
							>
								<Camera size={18} /> Take photo
							</button>
							<button
								class="button button--secondary"
								type="button"
								onclick={startScreenCapture}
								disabled={today?.state === 'locked' || today?.can_submit === false}
							>
								<MonitorUp size={18} /> Capture video call
							</button>
						</div>
						{#if cameraCaptureError}<p class="capture-error">{cameraCaptureError}</p>{/if}
						{#if screenCaptureError}<p class="capture-error">{screenCaptureError}</p>{/if}
					</div>
				{/if}
			</section>
		{/if}

		<aside class="session-panel" aria-live="polite">
			{#if status === 'submitting' || status === 'processing'}
				<div data-testid={status === 'submitting' ? 'status-submitting' : 'status-processing'}>
					<p class="eyebrow">{status === 'submitting' ? 'Uploading' : 'Processing'}</p>
					<h2>{status === 'submitting' ? 'Sending the photo' : 'Reading attendance'}</h2>
					<ol class="processing-list">
						{#each processingLabels as label, index}
							<li class:active={index === processingStep} class:complete={index < processingStep}>
								<span>{index < processingStep ? 'Done' : index + 1}</span>{label}
							</li>
						{/each}
					</ol>
					<p class="muted">Keep this page open while the group is processed.</p>
				</div>
			{:else if status === 'fraud'}
				<div class="result-state" data-testid="status-fraud">
					<span class="result-icon"><ShieldAlert size={25} /></span>
					<h2>Fake Image Detected</h2>
					<p>
						This photo could not be verified as a live photo. Your login has been disabled and the
						plant manager has been notified. No attendance was recorded from this photo. Contact
						your plant manager or admin to get your login re-enabled.
					</p>
				</div>
			{:else if status === 'failed'}
				<div class="result-state" data-testid="status-failed">
					<span class="result-icon"><ShieldAlert size={25} /></span>
					<h2>Could not finish</h2>
					<p>{errorMsg}</p>
					<div class="result-actions">
						<button class="button button--primary" type="button" onclick={retryFailedCapture}>
							<RefreshCw size={17} /> Retry
						</button>
						<button class="button button--secondary" type="button" onclick={resetCapture}
							>Choose another</button
						>
					</div>
				</div>
			{:else if status === 'completed' && result}
				<div class="results" data-testid="result-screen">
					<div class="result-summary">
						<span class="result-icon result-icon--success"><Check size={25} /></span>
						<div>
							<p class="eyebrow">Review before completing</p>
							<h2>
								{(result.matched?.length || 0) + (result.new_persons?.length || 0)} people found
							</h2>
						</div>
					</div>
					{#if result.liveness_summary?.suspicious || result.liveness_summary?.unverified}
						<div class="liveness-notice" data-testid="liveness-review-notice">
							<ShieldAlert size={18} aria-hidden="true" />
							<p>
								<strong
									>{(result.liveness_summary.suspicious || 0) +
										(result.liveness_summary.unverified || 0)} need review.</strong
								>
								Check the marked faces before completing attendance.
							</p>
						</div>
					{/if}
					{#if result.photo_url}
						<div class="review-photo">
							<p class="eyebrow">Submitted group photo</p>
							<img src={result.photo_url} alt="Corrected group attendance" />
						</div>
					{/if}

					{#if result.matched?.length}
						<div class="result-group">
							<h3>Matched <span>{result.matched.length}</span></h3>
							<ul class="face-list">
								{#each result.matched as person}
									<li>
										<button
											class="face-row"
											type="button"
											onclick={(event) => openWorkerPreview(person, 'matched', event.currentTarget)}
											aria-label={`Preview ${personDisplayLabel(person.pump_code, person.display_seq)}`}
											data-testid="worker-preview-trigger"
										>
											{#if person.source_photo_crop_url}
												<img src={person.source_photo_crop_url} alt="" loading="lazy" />
											{:else}
												<span class="face-thumb-placeholder" aria-hidden="true"
													><UserRound size={16} /></span
												>
											{/if}
											<span class="face-label"
												>{personDisplayLabel(person.pump_code, person.display_seq)}</span
											>
											<span
												class:liveness-warning={person.liveness_status !== 'live'}
												class="liveness-badge">{livenessLabel(person)}</span
											>
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
							<h3>New people <span>{result.new_persons.length}</span></h3>
							<ul class="face-list">
								{#each result.new_persons as person}
									<li>
										<button
											class="face-row"
											type="button"
											onclick={(event) => openWorkerPreview(person, 'new', event.currentTarget)}
											aria-label={`Preview ${personDisplayLabel(person.pump_code, person.display_seq)}`}
											data-testid="worker-preview-trigger"
										>
											{#if person.source_photo_crop_url}
												<img src={person.source_photo_crop_url} alt="" loading="lazy" />
											{:else}
												<span class="face-thumb-placeholder" aria-hidden="true"
													><UserRound size={16} /></span
												>
											{/if}
											<span class="face-label"
												>{personDisplayLabel(person.pump_code, person.display_seq)}</span
											>
											<span
												class:liveness-warning={person.liveness_status !== 'live'}
												class="liveness-badge">{livenessLabel(person)}</span
											>
											<span class="face-row-icons"><Eye size={15} aria-hidden="true" /></span>
										</button>
									</li>
								{/each}
							</ul>
						</div>
					{/if}

					{#if result.fraud_flags?.length}
						<div class="result-group attention-group">
							<h3>Needs review <span>{result.fraud_flags.length}</span></h3>
							{#each result.fraud_flags as flag}
								<p>
									{flag.person_label || 'An attendance overlap'} was also found at {flag.other_pump_code ||
										'another pump'}.
								</p>
							{/each}
						</div>
					{/if}

					{#if result.unknown_faces?.length}
						<div class="result-group attention-group">
							<h3>Awaiting guest review <span>{result.unknown_faces.length}</span></h3>
							<p>These faces were saved for an administrator to review.</p>
						</div>
					{/if}

					<div class="result-review-actions">
						<p>Check the count and face crops before completing this attendance.</p>
						{#if errorMsg}<p class="capture-error">{errorMsg}</p>{/if}
						<button
							class="button button--primary full-button"
							type="button"
							onclick={requestAttendanceRetry}
							disabled={retryingSession}
						>
							<RefreshCw size={17} class={retryingSession ? 'spin' : ''} />
							{retryingSession ? 'Preparing retry' : 'Retry with better photo'}
						</button>
						<button
							class="button button--secondary full-button"
							type="button"
							onclick={approveAttendanceReview}
							disabled={approvingReview}
						>
							<Check size={17} />
							{approvingReview ? 'Completing attendance' : 'Done reviewing'}
						</button>
					</div>
				</div>
			{:else}
				<div class="session-details">
					<p class="eyebrow">Session status</p>
					<h2>{sessionTitle}</h2>
					<dl>
						<div>
							<dt>Date</dt>
							<dd>{today?.today || 'Today'}</dd>
						</div>
						<div>
							<dt>Next step</dt>
							<dd>
								{today?.state === 'locked'
									? 'No more uploads today'
									: today?.state === 'review'
										? 'Finish reviewing the submitted group photo'
										: today?.can_submit === false
											? `Available ${formatIST(today?.next_allowed_at)}`
											: 'Submit the group photo'}
							</dd>
						</div>
					</dl>
				</div>
			{/if}
		</aside>
	</div>

	{#if selectedFile && status === 'idle'}
		<div class="sticky-submit">
			<button class="button button--primary" type="button" onclick={submitPhoto}>
				<Upload size={18} /> Submit group photo
			</button>
			<button class="button button--ghost" type="button" onclick={resetCapture}>Cancel</button>
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
					<p class="eyebrow">{selectedWorkerPreview.statusLabel}</p>
					<h2 id="worker-preview-title">{selectedWorkerPreview.label}</h2>
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
						<span>No face crop was returned for this worker.</span>
					</div>
				{/if}
			</div>

			<dl class="worker-preview-meta">
				<div>
					<dt>Session</dt>
					<dd>{result?.session_type === 'evening' ? 'Evening' : 'Morning'}</dd>
				</div>
				<div>
					<dt>Result</dt>
					<dd>{selectedWorkerPreview.statusLabel}</dd>
				</div>
				<div>
					<dt>Daily match</dt>
					<dd>
						{selectedWorkerPreview.morning_matched ? 'Morning' : ''}
						{selectedWorkerPreview.morning_matched && selectedWorkerPreview.evening_matched
							? ' and '
							: ''}
						{selectedWorkerPreview.evening_matched ? 'Evening' : ''}
						{!selectedWorkerPreview.morning_matched && !selectedWorkerPreview.evening_matched
							? 'New attendance'
							: ''}
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

	.capture-heading {
		margin-bottom: var(--space-6);
	}
	.capture-heading h1 {
		margin: var(--space-1) 0;
		font-size: var(--text-3xl);
	}
	.capture-heading p:last-child,
	.section-heading p {
		margin: 0;
		color: var(--ink-muted);
	}
	.eyebrow {
		margin: 0;
		color: var(--ink-muted);
		font-size: var(--text-xs);
		font-weight: 700;
		text-transform: uppercase;
	}

	.capture-layout {
		display: grid;
		grid-template-columns: minmax(0, 1.6fr) minmax(18rem, 0.8fr);
		gap: var(--space-5);
		align-items: start;
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
	.section-heading h2,
	.session-panel h2 {
		margin: 0;
		font-size: var(--text-xl);
	}

	.capture-empty {
		display: grid;
		min-height: 25rem;
		place-items: center;
		align-content: center;
		padding: var(--space-7);
		text-align: center;
		background: var(--surface-subtle);
		border: 1px dashed var(--brand-steel);
		border-radius: var(--radius-md);
	}

	.capture-empty strong {
		margin-top: var(--space-3);
		font-size: var(--text-lg);
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
	.review-photo .eyebrow {
		margin: 0;
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

	.session-details dl {
		display: grid;
		gap: var(--space-3);
		margin: var(--space-6) 0 0;
	}
	.session-details dl div {
		display: grid;
		grid-template-columns: 6rem 1fr;
		gap: var(--space-3);
		padding-top: var(--space-3);
		border-top: 1px solid var(--brand-mist);
	}
	.session-details dt {
		color: var(--ink-muted);
	}
	.session-details dd {
		margin: 0;
		text-align: right;
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
		.capture-empty {
			min-height: 21rem;
			padding: var(--space-5);
		}
		.session-panel {
			min-height: auto;
			padding: var(--space-3);
		}
		.session-details dl {
			margin-top: var(--space-4);
		}
	}

	@media (max-width: 30rem) {
		.capture-heading h1 {
			font-size: var(--text-2xl);
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
