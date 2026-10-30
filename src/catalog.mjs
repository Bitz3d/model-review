// Explicit UI grouping for the four authorized public entries.
// Additions must be listed here deliberately; model IDs are never inferred from suffixes.
export const FAMILY_DEFINITIONS = Object.freeze([
  Object.freeze({
    id: 'rollercoaster',
    label: 'Rollercoaster',
    entries: Object.freeze([
      Object.freeze({ modelId: 'rollercoaster-1', level: '1' }),
      Object.freeze({ modelId: 'rollercoaster-2', level: '2' }),
      Object.freeze({ modelId: 'rollercoaster-3', level: '3' }),
    ]),
  }),
  Object.freeze({
    id: 'harabin',
    label: 'Harabin',
    entries: Object.freeze([
      Object.freeze({ modelId: 'harabin-wind-stream', level: null }),
    ]),
  }),
]);

export function createUiCatalog(models) {
  const modelById = new Map(models.map((model) => [model.id, model]));
  const configuredIds = new Set();
  const families = FAMILY_DEFINITIONS.map((family) => ({
    ...family,
    entries: family.entries.map((entry) => {
      const model = modelById.get(entry.modelId);
      if (!model) throw new Error(`Brak jawnej pozycji interfejsu w manifeście: ${entry.modelId}.`);
      configuredIds.add(entry.modelId);
      return { ...entry, model };
    }),
  }));
  const unconfigured = models.filter((model) => !configuredIds.has(model.id));
  if (unconfigured.length) throw new Error(`Brak jawnego grupowania interfejsu: ${unconfigured.map((model) => model.id).join(', ')}.`);
  return { families, modelById };
}

export function selectionForModelId(catalog, modelId) {
  for (const family of catalog.families) {
    const entry = family.entries.find((candidate) => candidate.modelId === modelId);
    if (entry) return { familyId: family.id, level: entry.level };
  }
  return null;
}

export function modelForSelection(catalog, familyId, level) {
  const family = catalog.families.find((candidate) => candidate.id === familyId);
  if (!family) return null;
  const entry = family.entries.find((candidate) => candidate.level === (family.id === 'harabin' ? null : level));
  return entry?.model ?? null;
}

export function modelIdFromSearch(search, activeModel, knownIds) {
  const requested = new URLSearchParams(search).get('model');
  if (!requested) return { modelId: activeModel, missingId: null };
  return knownIds.has(requested) ? { modelId: requested, missingId: null } : { modelId: null, missingId: requested };
}
