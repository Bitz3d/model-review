export const PORTRAIT_FIT_MARGIN_ASPECT = 1.08;

export function fitScaleForAspect(isFullScene, aspect) {
  if (!isFullScene) return 1;
  const safeAspect = Number.isFinite(aspect) && aspect > 0 ? aspect : 1;
  return Math.max(1, PORTRAIT_FIT_MARGIN_ASPECT / safeAspect);
}

export function fitDistanceForAspect(baselineDistance, isFullScene, aspect) {
  return baselineDistance * fitScaleForAspect(isFullScene, aspect);
}

export function distanceLimitsForFit(fitDistance, isFullScene, baselineMinimum, baselineMaximum, baselineDistance) {
  if (!isFullScene) return { minimum: baselineMinimum, maximum: baselineMaximum };
  return {
    minimum: fitDistance * (baselineMinimum / baselineDistance),
    maximum: fitDistance * (baselineMaximum / baselineDistance),
  };
}
