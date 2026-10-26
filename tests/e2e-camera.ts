// The pump screen takes photos only from the camera: a Pump Operator photo, then the Pump
// Members photo. These helpers swap the camera for a canvas stream that shows a fixture image,
// so the E2E scripts send real photos through the real screen flow.
import { expect, type Page } from '@playwright/test';

export type CameraImage = { buffer: Buffer; mimeType?: string };

// Call before the first page.goto. Every frame also gets one random corner pixel, so two
// captures of the same fixture never share a photo hash (duplicate photos are rejected).
export async function installFakeCamera(page: Page) {
	await page.addInitScript(() => {
		const w = window as unknown as { __cameraImage: HTMLImageElement | null };
		w.__cameraImage = null;
		if (!navigator.mediaDevices) return;
		navigator.mediaDevices.getUserMedia = async () => {
			const canvas = document.createElement('canvas');
			canvas.width = 1280;
			canvas.height = 960;
			const context = canvas.getContext('2d')!;
			const draw = () => {
				const image = w.__cameraImage;
				if (image?.naturalWidth) {
					if (canvas.width !== image.naturalWidth) canvas.width = image.naturalWidth;
					if (canvas.height !== image.naturalHeight) canvas.height = image.naturalHeight;
					context.drawImage(image, 0, 0);
				} else {
					context.fillStyle = '#777';
					context.fillRect(0, 0, canvas.width, canvas.height);
				}
				context.fillStyle = `rgb(${Math.floor(Math.random() * 256)},0,0)`;
				context.fillRect(0, 0, 1, 1);
			};
			draw();
			setInterval(draw, 100);
			return canvas.captureStream(10);
		};
	});
}

async function showOnCamera(page: Page, image: CameraImage) {
	const dataUrl = `data:${image.mimeType ?? 'image/jpeg'};base64,${image.buffer.toString('base64')}`;
	await page.evaluate(async (src) => {
		const element = new Image();
		element.src = src;
		await element.decode();
		(window as unknown as { __cameraImage: HTMLImageElement }).__cameraImage = element;
	}, dataUrl);
}

async function takePhoto(page: Page, button: string, image: CameraImage) {
	await showOnCamera(page, image);
	await page.getByRole('button', { name: button, exact: true }).click();
	await expect(page.getByLabel('Laptop camera preview')).toBeVisible();
	const use = page.getByRole('button', { name: 'Use this photo' });
	await expect(use).toBeEnabled();
	await use.click();
}

export async function takeOperatorPhoto(page: Page, image: CameraImage) {
	await takePhoto(page, 'Take Pump Operator photo', image);
	await expect(page.getByAltText('Selected Pump Operator')).toBeVisible();
}

export async function takeMembersPhoto(page: Page, image: CameraImage) {
	await takePhoto(page, 'Take Pump Members photo', image);
	await expect(page.getByAltText('Selected group attendance preview')).toBeVisible();
}

// Both photos of a shift. The operator photo defaults to the group photo: its largest face is
// one of the group faces, so the operator is tagged and never counted twice.
export async function takeShiftPhotos(page: Page, members: CameraImage, operator = members) {
	await takeOperatorPhoto(page, operator);
	await takeMembersPhoto(page, members);
}

export async function submitPhotos(page: Page) {
	await page.getByRole('button', { name: 'Submit photos' }).click();
}

// "Done reviewing" needs a different name for every new worker: write one for each, then finish.
export async function completeReview(page: Page, namePrefix = 'E2E Worker') {
	const inputs = page.getByTestId('worker-name-input');
	const count = await inputs.count();
	for (let i = 0; i < count; i++) {
		const input = inputs.nth(i);
		if (!(await input.inputValue()).trim()) await input.fill(`${namePrefix} ${i + 1}`);
	}
	await page.getByTestId('complete-review').click();
}
