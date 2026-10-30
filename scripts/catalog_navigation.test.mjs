import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createUiCatalog,
  modelForSelection,
  modelIdFromSearch,
  selectionForModelId,
} from '../src/catalog.mjs';
import {
  PORTRAIT_FIT_MARGIN_ASPECT,
  distanceLimitsForFit,
  fitDistanceForAspect,
} from '../src/cameraFraming.mjs';

const models = [
  { id: 'harabin-wind-stream' },
  { id: 'rollercoaster-1' },
  { id: 'rollercoaster-2' },
  { id: 'rollercoaster-3' },
];
const catalog = createUiCatalog(models);

test('explicit metadata groups only the four published IDs', () => {
  assert.equal(catalog.families.length, 2);
  assert.deepEqual(catalog.families.map((family) => family.id), ['rollercoaster', 'harabin']);
  assert.equal(modelForSelection(catalog, 'rollercoaster', '3').id, 'rollercoaster-3');
  assert.equal(modelForSelection(catalog, 'harabin', null).id, 'harabin-wind-stream');
  assert.deepEqual(selectionForModelId(catalog, 'rollercoaster-2'), { familyId: 'rollercoaster', level: '2' });
});

test('unknown and unconfigured IDs fail closed', () => {
  assert.equal(modelForSelection(catalog, 'rollercoaster', '9'), null);
  assert.equal(selectionForModelId(catalog, 'not-listed'), null);
  assert.throws(() => createUiCatalog([...models, { id: 'future-unmapped-model' }]), /Brak jawnego grupowania/);
});

test('legacy model query and root active model navigation are exact', () => {
  const known = new Set(models.map((model) => model.id));
  assert.deepEqual(modelIdFromSearch('?model=rollercoaster-3', 'harabin-wind-stream', known), {
    modelId: 'rollercoaster-3', missingId: null,
  });
  assert.deepEqual(modelIdFromSearch('', 'harabin-wind-stream', known), {
    modelId: 'harabin-wind-stream', missingId: null,
  });
  assert.deepEqual(modelIdFromSearch('?model=rollercoaster-33', 'harabin-wind-stream', known), {
    modelId: null, missingId: 'rollercoaster-33',
  });
});

test('portrait full-scene framing scales distance and clamps while preserving desktop and Harabin baselines', () => {
  assert.equal(PORTRAIT_FIT_MARGIN_ASPECT, 1.08);
  assert.equal(fitDistanceForAspect(3, true, 16 / 9), 3);
  assert.equal(fitDistanceForAspect(2.4, false, 0.626), 2.4);
  const portraitFit = fitDistanceForAspect(3, true, 0.626);
  assert.ok(Math.abs(portraitFit - 5.17571884984) < 1e-9);
  const limits = distanceLimitsForFit(portraitFit, true, 1.15, 6, 3);
  assert.ok(Math.abs(limits.minimum / portraitFit - 1.15 / 3) < 1e-12);
  assert.ok(Math.abs(limits.maximum / portraitFit - 2) < 1e-12);
});
