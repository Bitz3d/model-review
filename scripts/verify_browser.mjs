#!/usr/bin/env node
// Installed headful Chrome on loopback or the exact public URL. Mobile checks use CDP touch/mobile emulation; this is not a physical-phone test.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const args = process.argv.slice(2);
const value = (flag) => args[args.indexOf(flag) + 1];
if (!args.includes('--url') || !args.includes('--out-dir')) throw new Error('Usage: verify_browser.mjs --url URL --out-dir NEW_DIR');
const base = value('--url');
const out = path.resolve(value('--out-dir'));
const localPattern = /^http:\/\/127\.0\.0\.1:\d+\/model-review\/$/;
const publicUrl = 'https://bitz3d.github.io/model-review/';
if (!localPattern.test(base) && base !== publicUrl) throw new Error(`URL must be loopback /model-review/ or exactly ${publicUrl}`);
if (fs.existsSync(out) || !fs.existsSync(path.dirname(out)) || !fs.statSync(path.dirname(out)).isDirectory()) throw new Error('Output directory must be new and its parent must exist');
fs.mkdirSync(out);

const playwrightPackage = process.env.PLAYWRIGHT_PACKAGE;
if (!playwrightPackage) throw new Error('Set PLAYWRIGHT_PACKAGE to an existing local package.json that can resolve Playwright');
const require = createRequire(path.resolve(playwrightPackage));
const { chromium } = require('playwright');
const browser = await chromium.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: false });
const expected = {
  'harabin-wind-stream': { triangles: 4630548, bytes: 169079420, sha256: '3d3ab52f44a6b6d0ca22e918b49ff3792f0713aa0b0baf32974a975c75f017e7' },
  'rollercoaster-1': { triangles: 1207952, bytes: 68148660, sha256: '348fd0562256e3592ddfceff880ea812bde8d4425961b81671c3fa19956166ed' },
  'rollercoaster-2': { triangles: 1228544, bytes: 68902128, sha256: 'ac5d4e14edff93bdd7e4dfc73d97f542b4c795e8226ad3557453dcd87e17cd47' },
  'rollercoaster-3': { triangles: 1250704, bytes: 69996064, sha256: '8a9739cd305add89a531b65e244077d573f6ed660c9a432960255c3cb554a8be' },
};
const record = {
  status: 'running',
  environment: 'Installed headful Google Chrome on macOS; desktop checks plus trusted CDP-dispatched touch input under Chrome mobile/touch emulation; not a physical phone',
  base,
  checks: {},
  errors: [],
  expectedErrors: [],
  modelPartRequests: [],
  scriptRequests: [],
  maxConcurrentPartRequests: 0,
};
const cameraClose = (actual, expectedPosition, epsilon = 0.045) => actual?.length === expectedPosition.length && actual.every((number, index) => Math.abs(number - expectedPosition[index]) <= epsilon);
const vectorDelta = (a, b) => Math.sqrt(a.reduce((sum, number, index) => sum + ((number - b[index]) ** 2), 0));

try {
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, deviceScaleFactor: 1, reducedMotion: 'reduce' });
  const page = await context.newPage();
  let activePartRequests = 0;
  page.on('pageerror', (error) => record.errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error') record.errors.push(message.text()); });
  page.on('request', (request) => {
    const pathname = new URL(request.url()).pathname;
    if (/\.glb\.gz\.part\d+$/.test(pathname)) {
      record.modelPartRequests.push(request.url());
      activePartRequests += 1;
      record.maxConcurrentPartRequests = Math.max(record.maxConcurrentPartRequests, activePartRequests);
    }
    if (pathname.endsWith('.js')) record.scriptRequests.push(pathname);
  });
  const finishRequest = (request) => {
    if (/\.glb\.gz\.part\d+$/.test(new URL(request.url()).pathname)) activePartRequests = Math.max(0, activePartRequests - 1);
  };
  page.on('requestfinished', finishRequest);
  page.on('requestfailed', finishRequest);
  const allowedPrefix = base.slice(0, -1);
  await page.route('**/*', (route) => {
    const url = route.request().url();
    return url.startsWith(allowedPrefix) || url.startsWith('blob:') || url.startsWith('data:') ? route.continue() : route.abort();
  });

  const probe = () => page.evaluate(() => window.__modelReviewProbe());
  const waitReady = async (modelId, timeout = 360000) => {
    const item = expected[modelId];
    await page.waitForFunction(({ modelId: id, item: expectation }) => {
      const state = window.__modelReviewProbe?.();
      return state?.selectedId === id && state?.loadedModelId === id && state?.loadState?.kind === 'ready'
        && state.loadState.decodedBytes === expectation.bytes && state.loadState.decodedSha256 === expectation.sha256
        && state?.viewer?.triangles === expectation.triangles;
    }, { modelId, item }, { timeout });
    const state = await probe();
    if (state.diagnostics.maxConcurrentLoads !== 1) throw new Error(`More than one model loader ran concurrently: ${state.diagnostics.maxConcurrentLoads}`);
    if (await page.locator('canvas').count() !== 1) throw new Error(`Expected exactly one canvas for ${modelId}`);
    return state;
  };
  const selectLevel = async (level) => {
    await page.getByTestId('level-select').selectOption(level);
    return waitReady(`rollercoaster-${level}`);
  };
  const renderFrame = async () => (await probe()).viewer?.renderFrame ?? -1;
  const waitForViewerConvergence = async (label, beforeFrame, expectedViewport = null, timeout = 15000) => {
    await page.waitForFunction(({ minimumFrame, viewport }) => {
      const viewer = window.__modelReviewProbe?.().viewer;
      const dimensions = viewer?.dimensions;
      if (!viewer || !dimensions || dimensions.dpr !== 1 || viewer.renderFrame <= minimumFrame) return false;
      const [cssWidth, cssHeight] = dimensions.canvasCss;
      const close = (left, right, epsilon = 0.51) => Math.abs(left - right) <= epsilon;
      const pairMatchesCss = (pair) => Array.isArray(pair) && close(pair[0], cssWidth) && close(pair[1], cssHeight);
      // CSS sizes may be fractional while canvas/WebGL raster dimensions are integers.
      // A one-device-pixel rounding delta is agreement at the fixed DPR of 1.
      const pixelMatchesCss = (pair) => Array.isArray(pair) && close(pair[0], cssWidth, 1.01) && close(pair[1], cssHeight, 1.01);
      const viewportMatches = (value) => Array.isArray(value) && value.length === 4
        && close(value[0], 0) && close(value[1], 0) && close(value[2], cssWidth, 1.01) && close(value[3], cssHeight, 1.01);
      return cssWidth > 0 && cssHeight > 0
        && (!viewport || (innerWidth === viewport[0] && innerHeight === viewport[1]))
        && pairMatchesCss(dimensions.viewerShellCss)
        && pairMatchesCss(dimensions.r3fSize)
        && pixelMatchesCss(dimensions.backingBuffer)
        && pixelMatchesCss(dimensions.drawingBuffer)
        && viewportMatches(dimensions.rendererViewport)
        && viewportMatches(dimensions.gpuViewport)
        && close(viewer.camera.aspect, cssWidth / cssHeight, 0.0001);
    }, { minimumFrame: beforeFrame, viewport: expectedViewport }, { timeout });

    let previous = (await probe()).viewer;
    for (let attempt = 0; attempt < 8; attempt += 1) {
      await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      const current = (await probe()).viewer;
      if (current && previous && current.renderFrame === previous.renderFrame
        && JSON.stringify(current.dimensions) === JSON.stringify(previous.dimensions)
        && current.camera.aspect === previous.camera.aspect) {
        return { label, renderFrame: current.renderFrame, camera: current.camera, dimensions: current.dimensions };
      }
      previous = current;
    }
    throw new Error(`${label}: CSS/R3F/WebGL dimensions did not settle after a fresh render`);
  };
  const resetAndSettle = async (label, expectedViewport = null) => {
    const before = await renderFrame();
    await page.getByTestId('preset-reset').click();
    return waitForViewerConvergence(label, before, expectedViewport);
  };
  const responsiveLayout = async (label) => {
    const layout = await page.evaluate(() => ({
      viewport: [innerWidth, innerHeight],
      overflowX: document.documentElement.scrollWidth > document.documentElement.clientWidth,
      controls: document.querySelector('.viewer-controls')?.getBoundingClientRect().toJSON(),
      controlBoxes: Array.from(document.querySelectorAll('.immersive-frame button, .immersive-frame select')).map((element) => ({
        testId: element.getAttribute('data-testid'),
        tag: element.tagName.toLowerCase(),
        text: element.textContent?.trim(),
        rect: element.getBoundingClientRect().toJSON(),
      })),
    }));
    if (layout.overflowX || !layout.controls || layout.controls.bottom > layout.viewport[1] + 1
      || layout.controls.left < -1 || layout.controls.right > layout.viewport[0] + 1) {
      throw new Error(`${label} controls overflow: ${JSON.stringify(layout)}`);
    }
    const invalid = layout.controlBoxes.filter(({ rect }) => rect.width < 43.5 || rect.height < 43.5 || rect.left < -1 || rect.right > layout.viewport[0] + 1 || rect.top < -1 || rect.bottom > layout.viewport[1] + 1);
    if (invalid.length) throw new Error(`${label} has clipped or sub-44px controls: ${JSON.stringify(invalid)}`);
    return layout;
  };
  const rollerBoundsEvidence = async (label, maximumAbsoluteXY = 0.95) => {
    const viewer = (await probe()).viewer;
    const bounds = viewer?.intendedBounds;
    const dimensions = viewer?.dimensions;
    if (!bounds || !dimensions || !bounds.fullyInsideClip || bounds.maximumAbsoluteXY > maximumAbsoluteXY) {
      throw new Error(`${label} intended Rollercoaster bounds are clipped or lack margin: ${JSON.stringify({ bounds, dimensions })}`);
    }
    const [width, height] = dimensions.canvasCss;
    const pixels = bounds.canvasPixels;
    const margins = {
      left: pixels.left,
      right: width - pixels.right,
      top: pixels.top,
      bottom: height - pixels.bottom,
    };
    if (Object.values(margins).some((margin) => margin < -0.5)) throw new Error(`${label} projected source Box3 leaves the canvas: ${JSON.stringify(margins)}`);
    return {
      label,
      camera: viewer.camera,
      sourceWorldBox: bounds.sourceWorldBox,
      ndc: bounds.ndc,
      maximumAbsoluteXY: bounds.maximumAbsoluteXY,
      canvasPixels: pixels,
      canvasMargins: margins,
      canvasCss: dimensions.canvasCss,
    };
  };
  const presetAndBounds = async (label, preset) => {
    const before = await renderFrame();
    await page.getByTestId('view-preset').selectOption(preset);
    await waitForViewerConvergence(`${label} ${preset}`, before);
    return rollerBoundsEvidence(`${label} ${preset}`);
  };

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__modelReviewProbe?.().manifestLoaded === true);
  await page.locator('.preview-image').waitFor({ state: 'visible' });
  const initial = await page.evaluate(() => ({
    probe: window.__modelReviewProbe(),
    cards: document.querySelectorAll('[data-testid^="card-"]').length,
    canvases: document.querySelectorAll('canvas').length,
    family: document.querySelector('[data-testid="family-select"]')?.value,
    levelDisabled: document.querySelector('[data-testid="level-select"]')?.disabled,
    startLabel: document.querySelector('[data-testid="start-3d"]')?.textContent,
    overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
  }));
  if (initial.cards !== 0 || initial.canvases !== 0 || initial.probe.selectedId !== 'harabin-wind-stream') throw new Error('Default single-view Harabin selection is incorrect');
  if (initial.family !== 'harabin' || !initial.levelDisabled || initial.startLabel?.trim() !== 'Uruchom 3D' || initial.overflow) throw new Error('Default selectors/start/desktop overflow state is incorrect');
  if (record.modelPartRequests.length !== 0) throw new Error('Heavy model downloaded eagerly on the root page');
  if (record.scriptRequests.some((pathname) => /(?:modelLoader|Viewer|three\.module)-/.test(pathname))) throw new Error(`3D runtime loaded eagerly: ${record.scriptRequests}`);
  initial.initialScripts = [...record.scriptRequests];
  record.checks.defaultSingleViewerNoEager = initial;
  await page.screenshot({ path: path.join(out, 'desktop-default.png'), fullPage: false });

  await page.goto(`${base}?model=rollercoaster-3`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__modelReviewProbe?.().selectedId === 'rollercoaster-3');
  const direct = await page.evaluate(() => ({
    probe: window.__modelReviewProbe(),
    cards: document.querySelectorAll('[data-testid^="card-"]').length,
    family: document.querySelector('[data-testid="family-select"]')?.value,
    level: document.querySelector('[data-testid="level-select"]')?.value,
  }));
  if (direct.cards !== 0 || direct.family !== 'rollercoaster' || direct.level !== '3' || record.modelPartRequests.length !== 0) throw new Error('Exact legacy Rollercoaster 3 direct link failed or downloaded eagerly');
  record.checks.exactLegacyDirectLink = direct;

  await page.goto(`${base}?model=does-not-exist`, { waitUntil: 'domcontentloaded' });
  await page.getByTestId('model-not-found').waitFor();
  const missing = await page.evaluate(() => ({ probe: window.__modelReviewProbe(), cards: document.querySelectorAll('[data-testid^="card-"]').length, canvases: document.querySelectorAll('canvas').length }));
  if (missing.probe.missingId !== 'does-not-exist' || missing.cards !== 0 || missing.canvases !== 0 || record.modelPartRequests.length !== 0) throw new Error('Unknown model fail-closed state is incorrect');
  record.checks.unknownModel404 = missing;

  await page.goto(base, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__modelReviewProbe?.().selectedId === 'harabin-wind-stream');
  const slowPart = async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 1200));
    try { await route.continue(); } catch { /* cancellation intentionally closes the request */ }
  };
  await page.route('**/*.part01', slowPart);
  await page.getByTestId('start-3d').click();
  await page.getByTestId('loading-panel').waitFor();
  await page.getByTestId('cancel-load').click();
  await page.getByTestId('canceled-panel').waitFor();
  await page.unroute('**/*.part01', slowPart);
  const canceled = await probe();
  if (canceled.loadState.kind !== 'canceled' || canceled.sessionActive || canceled.diagnostics.cancellations < 1 || canceled.viewer !== null) throw new Error('Cancellation did not stop the session and leave a released viewer state');
  const requestsAfterCancel = record.modelPartRequests.length;
  await page.getByTestId('family-select').selectOption('rollercoaster');
  await page.waitForFunction(() => window.__modelReviewProbe?.().selectedId === 'rollercoaster-1');
  await page.waitForTimeout(500);
  await page.getByTestId('family-select').selectOption('harabin');
  await page.waitForTimeout(500);
  const canceledReselection = await probe();
  if (canceledReselection.sessionActive || canceledReselection.loadState.kind !== 'idle' || record.modelPartRequests.length !== requestsAfterCancel) throw new Error('Selection after cancellation restarted a heavy download');
  record.checks.cancellation = { canceled, canceledReselection, modelRequestsStayedAt: requestsAfterCancel };

  const failPart = (route) => route.fulfill({ status: 503, contentType: 'text/plain', body: 'intentional browser retry test' });
  await page.route('**/*.part01', failPart);
  await page.getByTestId('start-3d').click();
  await page.getByTestId('error-panel').waitFor({ timeout: 15000 });
  const failed = await probe();
  if (failed.loadState.kind !== 'error' || !failed.loadState.message.includes('503')) throw new Error('HTTP error/retry UI was not truthful');
  await page.unroute('**/*.part01', failPart);
  record.checks.retryError = failed;

  await page.getByTestId('retry-load').click();
  const harabin = await waitReady('harabin-wind-stream');
  record.checks.initialViewerConvergence = await waitForViewerConvergence('initial desktop viewer', -1, [1440, 1000]);
  const lights = harabin.viewer.presentation.lights;
  if (harabin.viewer.camera.fov !== 35 || harabin.viewer.presentation.background !== 'f5f1e8' || !cameraClose(harabin.viewer.presentation.modelScale, [0.55, 0.55, 0.55])) throw new Error('Harabin camera/background/scale changed');
  if (lights.length !== 3 || lights[0].intensity !== 0.9 || lights[1].intensity !== 2.2 || lights[2].intensity !== 0.7) throw new Error('Review lights changed');
  record.checks.harabinIntegrityAndPresentation = harabin;

  await page.getByTestId('preset-reset').click();
  await page.waitForTimeout(100);
  const desktopStart = (await probe()).viewer.camera;
  const canvas = page.locator('canvas');
  const box = await canvas.boundingBox();
  if (!box) throw new Error('Canvas has no desktop bounding box');
  await page.mouse.move(box.x + box.width * 0.45, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(box.x + box.width * 0.65, box.y + box.height * 0.44, { steps: 8 });
  await page.mouse.up({ button: 'left' });
  const afterRotate = (await probe()).viewer.camera;
  if (vectorDelta(desktopStart.position, afterRotate.position) < 0.08) throw new Error('Desktop left-drag did not rotate');
  await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(box.x + box.width * 0.57, box.y + box.height * 0.57, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  const afterRightPan = (await probe()).viewer.camera;
  if (vectorDelta(afterRotate.target, afterRightPan.target) < 0.015) throw new Error('Desktop right-drag did not pan');
  const targetBeforeShiftPan = afterRightPan.target;
  await page.keyboard.down('Shift');
  await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.48);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(box.x + box.width * 0.54, box.y + box.height * 0.52, { steps: 6 });
  await page.mouse.up({ button: 'left' });
  await page.keyboard.up('Shift');
  const afterShiftPan = (await probe()).viewer.camera;
  if (vectorDelta(targetBeforeShiftPan, afterShiftPan.target) < 0.015) throw new Error('Desktop Shift+left-drag did not pan');
  const beforeWheel = afterShiftPan.distance;
  await page.mouse.wheel(0, -420);
  await page.waitForTimeout(100);
  const afterWheel = (await probe()).viewer.camera;
  if (Math.abs(afterWheel.distance - beforeWheel) < 0.03) throw new Error('Desktop wheel did not zoom');
  await page.getByTestId('mode-pan').focus();
  await page.keyboard.press('Enter');
  if (await page.getByTestId('mode-pan').getAttribute('aria-pressed') !== 'true') throw new Error('Keyboard did not activate pan mode');
  const beforeLeftPan = (await probe()).viewer.camera;
  await page.mouse.move(box.x + box.width * 0.48, box.y + box.height * 0.48);
  await page.mouse.down({ button: 'left' });
  await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.48, { steps: 6 });
  await page.mouse.up({ button: 'left' });
  const afterLeftPan = (await probe()).viewer.camera;
  if (vectorDelta(beforeLeftPan.target, afterLeftPan.target) < 0.015) throw new Error('Selected desktop pan mode did not pan with left drag');
  await page.getByTestId('mode-rotate').click();
  await page.getByTestId('preset-reset').click();
  await page.waitForTimeout(100);
  const resetDesktop = (await probe()).viewer.camera;
  if (!cameraClose(resetDesktop.position, [0, 0.35, 2.4]) || !cameraClose(resetDesktop.target, [0, 0, 0])) throw new Error('Desktop center/reset did not restore Harabin framing');
  const beforePlus = resetDesktop.distance;
  await page.getByTestId('zoom-in').click();
  const afterPlus = (await probe()).viewer.camera.distance;
  await page.getByTestId('zoom-out').click();
  const afterMinus = (await probe()).viewer.camera.distance;
  if (!(afterPlus < beforePlus && afterMinus > afterPlus)) throw new Error('Explicit +/- controls did not alter camera distance');
  record.checks.desktopControls = { desktopStart, afterRotate, afterRightPan, afterShiftPan, afterWheel, afterLeftPan, resetDesktop, afterPlus, afterMinus };

  let beforeResizeFrame = await renderFrame();
  await page.getByTestId('fullscreen').click();
  await page.waitForFunction(() => document.fullscreenElement !== null, null, { timeout: 10000 });
  if (!(await probe()).fullscreen.native) throw new Error('Native fullscreen state was not reported');
  const nativeOpenConvergence = await waitForViewerConvergence('native fullscreen open', beforeResizeFrame);
  beforeResizeFrame = await renderFrame();
  await page.getByTestId('immersive-exit').click();
  await page.waitForFunction(() => document.fullscreenElement === null);
  const nativeCloseConvergence = await waitForViewerConvergence('native fullscreen close', beforeResizeFrame, [1440, 1000]);
  await page.evaluate(() => Object.defineProperty(Element.prototype, 'requestFullscreen', { configurable: true, value: undefined }));
  beforeResizeFrame = await renderFrame();
  await page.getByTestId('fullscreen').click();
  await page.waitForFunction(() => window.__modelReviewProbe?.().fullscreen.fallback === true);
  const fallbackOpenConvergence = await waitForViewerConvergence('fallback immersive open', beforeResizeFrame, [1440, 1000]);
  const fallbackA11y = await page.evaluate(() => ({
    role: document.querySelector('.is-fallback-immersive')?.getAttribute('role'),
    modal: document.querySelector('.is-fallback-immersive')?.getAttribute('aria-modal'),
    focusInside: Boolean(document.querySelector('.is-fallback-immersive')?.contains(document.activeElement)),
  }));
  if (fallbackA11y.role !== 'dialog' || fallbackA11y.modal !== 'true' || !fallbackA11y.focusInside) throw new Error(`Fallback dialog accessibility state is incorrect: ${JSON.stringify(fallbackA11y)}`);
  beforeResizeFrame = await renderFrame();
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => window.__modelReviewProbe?.().fullscreen.fallback === false);
  const fallbackEscapeConvergence = await waitForViewerConvergence('fallback immersive Escape close', beforeResizeFrame, [1440, 1000]);
  beforeResizeFrame = await renderFrame();
  await page.getByTestId('fullscreen').click();
  await page.waitForFunction(() => window.__modelReviewProbe?.().fullscreen.fallback === true);
  const fallbackReopenConvergence = await waitForViewerConvergence('fallback immersive reopen', beforeResizeFrame, [1440, 1000]);
  beforeResizeFrame = await renderFrame();
  await page.getByTestId('immersive-exit').click();
  await page.waitForFunction(() => window.__modelReviewProbe?.().fullscreen.fallback === false);
  const fallbackButtonCloseConvergence = await waitForViewerConvergence('fallback immersive button close', beforeResizeFrame, [1440, 1000]);
  record.checks.fullscreenNativeAndFallback = {
    result: 'Native fullscreen and accessible in-page fallback opened and closed by Escape/button after CSS/R3F/WebGL convergence',
    fallbackA11y,
    nativeOpenConvergence,
    nativeCloseConvergence,
    fallbackOpenConvergence,
    fallbackEscapeConvergence,
    fallbackReopenConvergence,
    fallbackButtonCloseConvergence,
  };

  const rapidSlowPart = async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 900));
    try { await route.continue(); } catch { /* stale request intentionally canceled */ }
  };
  await page.route('**/*.part01', rapidSlowPart);
  await page.getByTestId('family-select').selectOption('rollercoaster');
  await page.waitForFunction(() => window.__modelReviewProbe?.().selectedId === 'rollercoaster-1');
  await page.getByTestId('level-select').selectOption('2');
  await page.getByTestId('level-select').selectOption('3');
  await page.unroute('**/*.part01', rapidSlowPart);
  const roller3 = await waitReady('rollercoaster-3');
  const rapidUrl = page.url();
  if (!rapidUrl.endsWith('?model=rollercoaster-3') || roller3.selectedId !== roller3.loadedModelId || roller3.diagnostics.cancellations < 3) throw new Error('Rapid switching left a stale model, URL, or cancellation state');
  const desktopRoller3ResetConvergence = await resetAndSettle('desktop Rollercoaster 3 baseline reset', [1440, 1000]);
  const desktopRoller3Reset = (await probe()).viewer.camera;
  if (!cameraClose(desktopRoller3Reset.position, [0, 0.35, 3]) || desktopRoller3Reset.fitDistance !== 3 || desktopRoller3Reset.fitScale !== 1) throw new Error(`Desktop Rollercoaster 3 baseline framing changed: ${JSON.stringify(desktopRoller3Reset)}`);
  record.checks.rapidSwitchToRoller3 = { probe: roller3, url: rapidUrl, desktopRoller3ResetConvergence, desktopRoller3Reset };

  const roller1 = await selectLevel('1');
  const roller2 = await selectLevel('2');
  record.checks.allPublishedAssetsLoaded = {
    'harabin-wind-stream': { bytes: harabin.loadState.decodedBytes, sha256: harabin.loadState.decodedSha256, triangles: harabin.viewer.triangles },
    'rollercoaster-1': { bytes: roller1.loadState.decodedBytes, sha256: roller1.loadState.decodedSha256, triangles: roller1.viewer.triangles },
    'rollercoaster-2': { bytes: roller2.loadState.decodedBytes, sha256: roller2.loadState.decodedSha256, triangles: roller2.viewer.triangles },
    'rollercoaster-3': { bytes: roller3.loadState.decodedBytes, sha256: roller3.loadState.decodedSha256, triangles: roller3.viewer.triangles },
  };

  await page.goBack({ waitUntil: 'domcontentloaded' });
  const backState = await waitReady('rollercoaster-1');
  await page.goForward({ waitUntil: 'domcontentloaded' });
  const forwardState = await waitReady('rollercoaster-2');
  if (backState.selectedId !== backState.loadedModelId || forwardState.selectedId !== forwardState.loadedModelId) throw new Error('Back/forward loaded identity mismatch');
  record.checks.backForward = { back: backState.selectedId, forward: forwardState.selectedId };
  const desktopRollerResetConvergence = await resetAndSettle('desktop Rollercoaster baseline reset', [1440, 1000]);
  const desktopRollerReset = (await probe()).viewer.camera;
  if (!cameraClose(desktopRollerReset.position, [0, 0.35, 3]) || desktopRollerReset.fitDistance !== 3 || desktopRollerReset.fitScale !== 1) throw new Error(`Desktop Rollercoaster baseline framing changed: ${JSON.stringify(desktopRollerReset)}`);
  record.checks.desktopRollercoasterBaseline = { desktopRollerResetConvergence, desktopRollerReset };

  const cdp = await context.newCDPSession(page);
  await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  beforeResizeFrame = await renderFrame();
  await page.setViewportSize({ width: 390, height: 844 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
  const mobilePortraitWindowConvergence = await waitForViewerConvergence('mobile portrait window resize', beforeResizeFrame, [390, 844]);
  const normalPortraitSelection = await selectLevel('3');
  const normalPortraitSelectionConvergence = await waitForViewerConvergence('normal portrait level selection', -1, [390, 844]);
  if (normalPortraitSelection.selectedId !== 'rollercoaster-3') throw new Error('Normal portrait level selection did not load Rollercoaster 3');
  await page.evaluate(() => {
    window.__trustedTouchMoves = 0;
    document.addEventListener('pointermove', (event) => {
      if (event.isTrusted && event.pointerType === 'touch') window.__trustedTouchMoves += 1;
    }, { passive: true });
  });
  const touch = (type, points) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: points.map((point, index) => ({ id: index + 1, x: point.x, y: point.y, radiusX: 6, radiusY: 6, force: type === 'touchEnd' ? 0 : 1 })), modifiers: 0 });
  const mobileBox = await canvas.boundingBox();
  if (!mobileBox) throw new Error('Canvas has no mobile bounding box');
  const center = { x: mobileBox.x + mobileBox.width / 2, y: mobileBox.y + mobileBox.height / 2 };
  await page.getByTestId('preset-reset').click();
  await page.getByTestId('mode-rotate').click();
  const touchStart = (await probe()).viewer.camera;
  await touch('touchStart', [{ x: center.x - 45, y: center.y }]);
  for (let step = 1; step <= 7; step += 1) await touch('touchMove', [{ x: center.x - 45 + step * 14, y: center.y - step * 2 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(120);
  const touchRotated = (await probe()).viewer.camera;
  if (vectorDelta(touchStart.position, touchRotated.position) < 0.08) throw new Error('Trusted one-finger touch did not rotate');

  const targetBeforeTwo = touchRotated.target;
  await touch('touchStart', [{ x: center.x - 50, y: center.y }, { x: center.x + 50, y: center.y }]);
  for (let step = 1; step <= 6; step += 1) await touch('touchMove', [{ x: center.x - 50 + step * 5, y: center.y + step * 5 }, { x: center.x + 50 + step * 5, y: center.y + step * 5 }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(120);
  const touchPanned = (await probe()).viewer.camera;
  if (vectorDelta(targetBeforeTwo, touchPanned.target) < 0.012) throw new Error('Trusted two-finger touch did not pan');

  const distanceBeforePinch = touchPanned.distance;
  await touch('touchStart', [{ x: center.x - 35, y: center.y }, { x: center.x + 35, y: center.y }]);
  for (let step = 1; step <= 6; step += 1) await touch('touchMove', [{ x: center.x - 35 - step * 7, y: center.y }, { x: center.x + 35 + step * 7, y: center.y }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(120);
  const touchPinched = (await probe()).viewer.camera;
  if (Math.abs(distanceBeforePinch - touchPinched.distance) < 0.03) throw new Error('Trusted pinch did not zoom');

  await page.getByTestId('mode-pan').click();
  const targetBeforeOnePan = (await probe()).viewer.camera.target;
  await touch('touchStart', [{ x: center.x - 30, y: center.y }]);
  for (let step = 1; step <= 6; step += 1) await touch('touchMove', [{ x: center.x - 30 + step * 8, y: center.y }]);
  await touch('touchEnd', []);
  await page.waitForTimeout(120);
  const oneFingerPanned = (await probe()).viewer.camera;
  const trustedMoves = await page.evaluate(() => window.__trustedTouchMoves);
  if (vectorDelta(targetBeforeOnePan, oneFingerPanned.target) < 0.012 || trustedMoves < 10) throw new Error(`Trusted one-finger pan/move evidence failed (${trustedMoves} trusted moves)`);
  const mobileResetConvergence = await resetAndSettle('mobile touch reset', [390, 844]);
  const mobileReset = (await probe()).viewer.camera;
  if (Math.abs(mobileReset.distance - mobileReset.fitDistance) > 0.045 || !cameraClose(mobileReset.target, [0, 0, 0])) throw new Error('Mobile center/reset did not restore corrected Rollercoaster framing');
  const normalPortraitBounds = { reset: await rollerBoundsEvidence('normal portrait reset') };
  for (const preset of ['front', 'quarter', 'side', 'rear']) normalPortraitBounds[preset] = await presetAndBounds('normal portrait preset', preset);
  const normalPortraitFinalResetConvergence = await resetAndSettle('normal portrait final reset', [390, 844]);
  normalPortraitBounds.finalReset = await rollerBoundsEvidence('normal portrait final reset');
  await page.evaluate(() => document.querySelector('.immersive-frame')?.scrollIntoView({ block: 'start' }));
  const normalPortraitLayout = await responsiveLayout('Normal portrait');
  await page.screenshot({ path: path.join(out, 'mobile-portrait-normal-emulation.png'), fullPage: false });
  record.checks.trustedMobileTouchControls = {
    trustedMoves,
    mobilePortraitWindowConvergence,
    normalPortraitSelection: normalPortraitSelection.selectedId,
    normalPortraitSelectionConvergence,
    touchStart,
    touchRotated,
    touchPanned,
    touchPinched,
    oneFingerPanned,
    mobileReset,
    mobileResetConvergence,
    normalPortraitFinalResetConvergence,
    normalPortraitBounds,
    normalPortraitLayout,
  };

  const resizeCanvasBox = await canvas.boundingBox();
  if (!resizeCanvasBox) throw new Error('Canvas has no normal portrait resize-test bounds');
  await page.mouse.move(resizeCanvasBox.x + resizeCanvasBox.width * 0.5, resizeCanvasBox.y + resizeCanvasBox.height * 0.5);
  await page.mouse.down({ button: 'right' });
  await page.mouse.move(resizeCanvasBox.x + resizeCanvasBox.width * 0.58, resizeCanvasBox.y + resizeCanvasBox.height * 0.55, { steps: 6 });
  await page.mouse.up({ button: 'right' });
  await page.getByTestId('zoom-out').click();
  const beforeFullscreenResizeCamera = (await probe()).viewer.camera;
  if (vectorDelta(beforeFullscreenResizeCamera.target, [0, 0, 0]) < 0.01) throw new Error('Resize preservation setup did not create a panned target');
  const relativeZoomBeforeFullscreen = beforeFullscreenResizeCamera.distance / beforeFullscreenResizeCamera.fitDistance;
  const directionBeforeFullscreen = beforeFullscreenResizeCamera.position.map((value, index) => (value - beforeFullscreenResizeCamera.target[index]) / beforeFullscreenResizeCamera.distance);
  beforeResizeFrame = await renderFrame();
  await page.getByTestId('fullscreen').click();
  await page.waitForFunction(() => window.__modelReviewProbe?.().fullscreen.fallback === true);
  const portraitFullscreenConvergence = await waitForViewerConvergence('mobile portrait fallback immersive open', beforeResizeFrame, [390, 844]);
  const afterFullscreenResizeCamera = (await probe()).viewer.camera;
  const relativeZoomAfterFullscreen = afterFullscreenResizeCamera.distance / afterFullscreenResizeCamera.fitDistance;
  const directionAfterFullscreen = afterFullscreenResizeCamera.position.map((value, index) => (value - afterFullscreenResizeCamera.target[index]) / afterFullscreenResizeCamera.distance);
  if (Math.abs(relativeZoomBeforeFullscreen - relativeZoomAfterFullscreen) > 0.01
    || vectorDelta(beforeFullscreenResizeCamera.target, afterFullscreenResizeCamera.target) > 0.0001
    || vectorDelta(directionBeforeFullscreen, directionAfterFullscreen) > 0.0001) {
    throw new Error(`Fullscreen resize did not preserve pan/direction/relative zoom or replayed the prior command: ${JSON.stringify({ beforeFullscreenResizeCamera, afterFullscreenResizeCamera })}`);
  }
  const portraitResetConvergence = await resetAndSettle('mobile portrait fullscreen reset', [390, 844]);
  const fullscreenPortraitBounds = { reset: await rollerBoundsEvidence('fullscreen portrait reset') };
  for (const preset of ['front', 'quarter', 'side', 'rear']) fullscreenPortraitBounds[preset] = await presetAndBounds('fullscreen portrait preset', preset);
  const fullscreenPortraitFinalResetConvergence = await resetAndSettle('fullscreen portrait final reset', [390, 844]);
  fullscreenPortraitBounds.finalReset = await rollerBoundsEvidence('fullscreen portrait final reset');
  for (let attempt = 0; attempt < 12; attempt += 1) await page.getByTestId('zoom-in').click();
  const portraitMinimumClamp = (await probe()).viewer.camera;
  if (Math.abs(portraitMinimumClamp.distance - portraitMinimumClamp.minimumDistance) > 0.02) throw new Error(`Portrait minimum zoom clamp mismatch: ${JSON.stringify(portraitMinimumClamp)}`);
  for (let attempt = 0; attempt < 14; attempt += 1) await page.getByTestId('zoom-out').click();
  const portraitMaximumClamp = (await probe()).viewer.camera;
  if (Math.abs(portraitMaximumClamp.distance - portraitMaximumClamp.maximumDistance) > 0.02) throw new Error(`Portrait maximum zoom clamp mismatch: ${JSON.stringify(portraitMaximumClamp)}`);
  const fullscreenPortraitPostClampResetConvergence = await resetAndSettle('fullscreen portrait reset after clamp checks', [390, 844]);

  beforeResizeFrame = await renderFrame();
  await page.setViewportSize({ width: 320, height: 568 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
  const smallPortraitConvergence = await waitForViewerConvergence('small 320px portrait resize', beforeResizeFrame, [320, 568]);
  const smallPortraitResetConvergence = await resetAndSettle('small 320px portrait reset', [320, 568]);
  const smallPortraitBounds = await rollerBoundsEvidence('small 320px portrait reset');
  const smallPortraitLayout = await responsiveLayout('Small 320px portrait');

  beforeResizeFrame = await renderFrame();
  await page.setViewportSize({ width: 390, height: 844 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'portraitPrimary', angle: 0 } });
  const portraitConvergence = await waitForViewerConvergence('final mobile portrait resize', beforeResizeFrame, [390, 844]);
  const finalPortraitResetConvergence = await resetAndSettle('final mobile portrait reset before capture', [390, 844]);
  const finalPortraitBounds = await rollerBoundsEvidence('final fullscreen portrait reset before capture');
  const portraitLayout = await responsiveLayout('Portrait');
  await page.screenshot({ path: path.join(out, 'mobile-portrait-emulation.png'), fullPage: false });

  beforeResizeFrame = await renderFrame();
  await page.setViewportSize({ width: 844, height: 390 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 844, height: 390, deviceScaleFactor: 1, mobile: true, screenOrientation: { type: 'landscapePrimary', angle: 90 } });
  const landscapeConvergence = await waitForViewerConvergence('mobile landscape resize', beforeResizeFrame, [844, 390]);
  const landscapeResetConvergence = await resetAndSettle('mobile landscape reset before capture', [844, 390]);
  const landscapeBounds = await rollerBoundsEvidence('mobile landscape reset before capture');
  const landscapeLayout = await responsiveLayout('Landscape');
  await page.screenshot({ path: path.join(out, 'mobile-landscape-emulation.png'), fullPage: false });
  beforeResizeFrame = await renderFrame();
  await page.getByTestId('immersive-exit').click();
  await page.waitForFunction(() => window.__modelReviewProbe?.().fullscreen.fallback === false);
  const landscapeFallbackCloseConvergence = await waitForViewerConvergence('landscape fallback close', beforeResizeFrame, [844, 390]);
  record.checks.responsiveLayouts = {
    portraitFullscreenConvergence,
    portraitResetConvergence,
    fullscreenPortraitFinalResetConvergence,
    fullscreenPortraitPostClampResetConvergence,
    fullscreenPortraitBounds,
    portraitZoomClamps: { minimum: portraitMinimumClamp, maximum: portraitMaximumClamp },
    resizeZoomPreservation: {
      relativeZoomBeforeFullscreen,
      relativeZoomAfterFullscreen,
      directionBeforeFullscreen,
      directionAfterFullscreen,
      beforeFullscreenResizeCamera,
      afterFullscreenResizeCamera,
    },
    smallPortraitConvergence,
    smallPortraitResetConvergence,
    smallPortraitBounds,
    smallPortraitLayout,
    portraitConvergence,
    finalPortraitResetConvergence,
    finalPortraitBounds,
    portraitLayout,
    landscapeConvergence,
    landscapeResetConvergence,
    landscapeBounds,
    landscapeLayout,
    landscapeFallbackCloseConvergence,
  };

  beforeResizeFrame = await renderFrame();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false, screenOrientation: { type: 'landscapePrimary', angle: 0 } });
  record.checks.desktopRestoreConvergence = await waitForViewerConvergence('desktop restore resize', beforeResizeFrame, [1440, 1000]);
  const requestsBeforeClose = record.modelPartRequests.length;
  await page.getByTestId('close-3d').click();
  await page.getByTestId('family-select').selectOption('harabin');
  await page.waitForTimeout(700);
  const stopped = await probe();
  if (stopped.sessionActive || stopped.loadState.kind !== 'idle' || stopped.viewer !== null || await page.locator('canvas').count() !== 0 || record.modelPartRequests.length !== requestsBeforeClose) throw new Error('Stopped viewer selection eagerly downloaded or retained 3D state');
  record.checks.closeAndNoEagerReselection = stopped;

  await page.getByTestId('start-3d').click();
  await waitReady('harabin-wind-stream');
  const lost = await page.locator('canvas').evaluate((element) => {
    const context = element.getContext('webgl2') || element.getContext('webgl');
    const extension = context?.getExtension('WEBGL_lose_context');
    extension?.loseContext();
    return Boolean(extension);
  });
  if (!lost) throw new Error('WEBGL_lose_context was unavailable');
  await page.getByTestId('error-panel').waitFor({ timeout: 10000 });
  const contextHandled = await probe();
  if (!contextHandled.loadState.contextLost || contextHandled.diagnostics.contextLosses !== 1 || contextHandled.diagnostics.disposals < 1 || contextHandled.viewer !== null) throw new Error('Real WebGL context-loss lifecycle handling failed');
  record.checks.contextLossAndDisposal = contextHandled;

  record.userAgent = await page.evaluate(() => navigator.userAgent);
  const resourceTimings = await page.evaluate(() => performance.getEntriesByType('resource')
    .filter((entry) => /\.glb\.gz\.part\d+$/.test(new URL(entry.name).pathname))
    .map((entry) => ({ name: entry.name, startTime: entry.startTime, responseStart: entry.responseStart, responseEnd: entry.responseEnd, transferSize: entry.transferSize, encodedBodySize: entry.encodedBodySize })));
  const heavyIntervals = resourceTimings
    .filter((entry) => entry.transferSize > 1_000_000 && entry.responseEnd > entry.responseStart)
    .flatMap((entry) => [{ time: entry.responseStart, delta: 1 }, { time: entry.responseEnd, delta: -1 }])
    .sort((left, right) => left.time - right.time || left.delta - right.delta);
  let activeHeavyTransfers = 0;
  let maxConcurrentHeavyTransfers = 0;
  for (const point of heavyIntervals) {
    activeHeavyTransfers += point.delta;
    maxConcurrentHeavyTransfers = Math.max(maxConcurrentHeavyTransfers, activeHeavyTransfers);
  }
  record.requestSummary = {
    modelPartRequests: record.modelPartRequests.length,
    uniqueModelParts: [...new Set(record.modelPartRequests.map((url) => new URL(url).pathname))],
    maxConcurrentRequestObjects: record.maxConcurrentPartRequests,
    maxConcurrentHeavyPayloadTransfers: maxConcurrentHeavyTransfers,
    resourceTimings,
  };
  const expected503 = record.errors.filter((message) => message.includes('status of 503'));
  record.expectedErrors.push(...expected503);
  record.errors = record.errors.filter((message) => !message.includes('status of 503'));
  if (maxConcurrentHeavyTransfers > 1) throw new Error(`Heavy model part payload transfers overlapped unexpectedly: ${maxConcurrentHeavyTransfers}`);
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
