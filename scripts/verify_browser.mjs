#!/usr/bin/env node
// Installed desktop Chrome on loopback. Not a phone, network, FPS, or universal compatibility test.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--url') || !args.includes('--out-dir')) throw new Error('Usage: verify_browser.mjs --url http://127.0.0.1:PORT/model-review/ --out-dir NEW_DIR');
const base = value('--url');
const out = path.resolve(value('--out-dir'));
if (!/^http:\/\/127\.0\.0\.1:\d+\/model-review\/$/.test(base)) throw new Error('Explicit loopback /model-review/ URL required');
if (fs.existsSync(out) || !fs.statSync(path.dirname(out)).isDirectory()) throw new Error('Output directory must be new and its parent must exist');
fs.mkdirSync(out);

const playwrightPackage = process.env.PLAYWRIGHT_PACKAGE;
if (!playwrightPackage) throw new Error('Set PLAYWRIGHT_PACKAGE to an existing local package.json that can resolve Playwright');
const require = createRequire(path.resolve(playwrightPackage));
const { chromium } = require('playwright');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false });
const record = {
  status: 'running',
  environment: 'Installed desktop Google Chrome on macOS, loopback, DPR1; not a physical phone',
  base,
  checks: {},
  errors: [],
  expectedErrors: [],
  modelPartRequests: [],
  scriptRequests: [],
};
const modelId = 'harabin-wind-stream';
const cameraClose = (actual, expected, epsilon = 0.035) => actual?.length === expected.length && actual.every((value, index) => Math.abs(value - expected[index]) <= epsilon);

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  page.on('pageerror', (error) => record.errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') record.errors.push(message.text()); });
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/\.glb\.gz\.part\d+$/.test(pathname)) record.modelPartRequests.push(request.url());
    if (pathname.endsWith('.js')) record.scriptRequests.push(pathname);
  });
  await page.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith(base.slice(0, -1)) || url.startsWith('blob:') || url.startsWith('data:') ? route.continue() : route.abort();
  });

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__modelReviewProbe?.().manifestLoaded === true);
  await page.locator('.preview-image').waitFor({ state: 'visible' });
  const initial = await page.evaluate(() => ({
    probe: window.__modelReviewProbe(),
    cards: document.querySelectorAll('[data-testid^="card-"]').length,
    canvases: document.querySelectorAll('canvas').length,
    previewLabel: document.querySelector('.preview-badge')?.textContent,
    startLabel: document.querySelector('[data-testid="start-3d"]')?.textContent,
  }));
  if (initial.cards !== 1 || initial.canvases !== 0 || initial.probe.selectedId !== modelId) throw new Error('Default catalog/selection/preview state is incorrect');
  if (!initial.previewLabel?.includes('Podgląd statyczny') || initial.startLabel?.trim() !== 'Uruchom 3D') throw new Error('Static-preview disclosure or explicit start button missing');
  if (record.modelPartRequests.length !== 0) throw new Error('Heavy model downloaded eagerly on default page');
  if (record.scriptRequests.some((pathname) => /(?:modelLoader|Viewer|three\.module)-/.test(pathname))) throw new Error(`3D runtime loaded eagerly: ${record.scriptRequests}`);
  initial.initialScripts = [...record.scriptRequests];
  record.checks.catalogDefaultNoEagerDownload = initial;
  await page.screenshot({ path: path.join(out, 'default-static-preview.png'), fullPage: false });

  await page.goto(`${base}?model=${modelId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__modelReviewProbe?.().selectedId === 'harabin-wind-stream');
  if (record.modelPartRequests.length !== 0) throw new Error('Heavy model downloaded eagerly on direct link');
  record.checks.directLink = await page.evaluate(() => window.__modelReviewProbe());

  await page.goto(`${base}?model=does-not-exist`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('model-not-found').waitFor();
  const missing = await page.evaluate(() => ({ probe: window.__modelReviewProbe(), reviewCards: document.querySelectorAll('[data-testid="review-card"]').length }));
  if (missing.probe.missingId !== 'does-not-exist' || missing.reviewCards !== 0 || record.modelPartRequests.length !== 0) throw new Error('Unknown model handling failed or downloaded model data');
  record.checks.unknownModel404 = missing;

  await page.goto(`${base}?model=${modelId}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__modelReviewProbe?.().selectedId === 'harabin-wind-stream');

  const slowPart = async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1500));
    try { await route.continue(); } catch { /* cancellation intentionally closes the request */ }
  };
  await page.route('**/*.part01', slowPart);
  await page.getByTestId('start-3d').click();
  await page.getByTestId('loading-panel').waitFor();
  await page.getByTestId('cancel-load').click();
  await page.getByTestId('canceled-panel').waitFor();
  await page.unroute('**/*.part01', slowPart);
  const canceled = await page.evaluate(() => window.__modelReviewProbe());
  if (canceled.loadState.kind !== 'canceled' || canceled.diagnostics.cancellations < 1 || canceled.viewer !== null) throw new Error('Cancellation did not release the active viewer state');
  record.checks.cancellation = canceled;

  const failPart = (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'intentional local retry test' });
  await page.route('**/*.part01', failPart);
  await page.getByRole('button', { name: 'Spróbuj ponownie' }).click();
  await page.getByTestId('error-panel').waitFor({ timeout: 15000 });
  const failed = await page.evaluate(() => window.__modelReviewProbe());
  if (failed.loadState.kind !== 'error' || !failed.loadState.message.includes('503')) throw new Error('HTTP load error was not shown truthfully');
  record.checks.error = failed;
  await page.unroute('**/*.part01', failPart);

  await page.getByTestId('retry-load').click();
  await page.waitForFunction(() => {
    const probe = window.__modelReviewProbe?.();
    return probe?.loadState?.kind === 'ready' && probe?.viewer?.triangles === 4630548;
  }, null, { timeout: 360000 });
  await page.waitForTimeout(800);
  const loaded = await page.evaluate(() => window.__modelReviewProbe());
  if (loaded.viewer.contextLost || loaded.loadState.decodedBytes !== 169079420 || loaded.loadState.decodedSha256 !== '3d3ab52f44a6b6d0ca22e918b49ff3792f0713aa0b0baf32974a975c75f017e7') throw new Error('Loaded model integrity/context result is incorrect');
  if (loaded.diagnostics.loadAttempts < 3) throw new Error('Expected cancel/error/retry attempts were not observed');
  const presentation = loaded.viewer.presentation;
  const lightSignature = presentation.lights.map((light) => [light.type, light.intensity, light.position]);
  if (loaded.viewer.camera.fov !== 35 || presentation.background !== 'f5f1e8' || !cameraClose(presentation.modelScale, [0.55, 0.55, 0.55])) throw new Error('Fixed camera/background/model scale differs from the accepted review scene');
  if (lightSignature.length !== 3 || lightSignature[0][0] !== 'AmbientLight' || lightSignature[0][1] !== 0.9 || lightSignature[1][1] !== 2.2 || !cameraClose(lightSignature[1][2], [3, 4, 5]) || lightSignature[2][1] !== 0.7 || !cameraClose(lightSignature[2][2], [-4, -1, -3])) throw new Error(`Lighting differs from the accepted review scene: ${JSON.stringify(lightSignature)}`);
  const successfulPartOrder = record.modelPartRequests.slice(-3).map((url) => new URL(url).pathname.match(/part\d+$/)?.[0]);
  if (successfulPartOrder.join(',') !== 'part01,part02,part03') throw new Error(`Successful chunk order is incorrect: ${successfulPartOrder}`);
  record.checks.fullApprovedAsset = loaded;

  for (const [testId, expectedPosition, expectedTarget] of [
    ['preset-front', [0, 0.15, 2.4], [0, 0.02, 0]],
    ['preset-quarter', [-1.697, 0.35, 1.697], [0, 0, 0]],
    ['preset-side', [-2.4, 0.35, 0], [0, 0, 0]],
    ['preset-rear', [0, 0.35, -2.4], [0, 0, 0]],
    ['preset-reset', [0, 0.35, 2.4], [0, 0, 0]],
  ]) {
    await page.getByTestId(testId).click();
    await page.waitForTimeout(120);
    const camera = (await page.evaluate(() => window.__modelReviewProbe())).viewer.camera;
    if (!cameraClose(camera.position, expectedPosition) || !cameraClose(camera.target, expectedTarget)) throw new Error(`${testId} camera mismatch: ${JSON.stringify(camera)}`);
  }
  record.checks.cameraPresets = 'front, quarter, side, rear and reset positions/targets matched the fixed review camera';
  await page.screenshot({ path: path.join(out, 'full-approved-model.png'), fullPage: false });

  await page.locator('canvas').evaluate((canvas) => canvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true })));
  await page.getByTestId('error-panel').waitFor();
  const contextHandled = await page.evaluate(() => window.__modelReviewProbe());
  if (!contextHandled.loadState.contextLost || contextHandled.diagnostics.contextLosses !== 1 || contextHandled.diagnostics.disposals < 1 || contextHandled.viewer !== null) throw new Error('Synthetic context-loss lifecycle handling failed');
  record.checks.contextLossAndDisposal = contextHandled;

  record.userAgent = await page.evaluate(() => navigator.userAgent);
  record.requestSummary = {
    modelPartRequests: record.modelPartRequests.length,
    uniqueModelParts: [...new Set(record.modelPartRequests.map((url) => new URL(url).pathname))],
  };
  const intentional503 = record.errors.filter((message) => message.includes('status of 503'));
  record.expectedErrors.push(...intentional503);
  record.errors = record.errors.filter((message) => !message.includes('status of 503'));
  if (record.errors.length) throw new Error(`Unexpected browser console/page errors: ${record.errors.join(' | ')}`);
  record.status = 'passed';
  await context.close();
} catch (error) {
  record.status = 'failed';
  record.failure = String(error);
} finally {
  fs.writeFileSync(path.join(out, 'verification.json'), `${JSON.stringify(record, null, 2)}\n`);
  await browser.close();
}
console.log(record.status, record.failure || '');
if (record.status !== 'passed') process.exitCode = 1;
