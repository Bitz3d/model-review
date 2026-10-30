import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { createUiCatalog, modelForSelection, modelIdFromSearch, selectionForModelId } from './catalog.mjs';
import { validateManifest } from './manifest';
import type { CameraCommand, InteractionMode, PresetName } from './Viewer';
import type { LoadProgress, ModelsManifest, PublicModel } from './types';
import './styles.css';

const Viewer = React.lazy(() => import('./Viewer').then((module) => ({ default: module.Viewer })));

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; modelId: string; progress: LoadProgress }
  | { kind: 'ready'; modelId: string; decodedBytes: number; decodedSha256: string }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string; contextLost?: boolean };

const EMPTY_PROGRESS: LoadProgress = { phase: 'download', loaded: 0, total: 1, detail: 'Przygotowanie pobierania' };

function formatBytes(bytes: number): string {
  return `${(bytes / 1_000_000).toLocaleString('pl-PL', { maximumFractionDigits: 1 })} MB`;
}

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === 'AbortError') return 'Ładowanie anulowane.';
  return error instanceof Error ? error.message : String(error);
}

function App() {
  const [manifest, setManifest] = useState<ModelsManifest | null>(null);
  const [manifestError, setManifestError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [missingId, setMissingId] = useState<string | null>(null);
  const [loadState, setLoadState] = useState<LoadState>({ kind: 'idle' });
  const [gltf, setGltf] = useState<GLTF | null>(null);
  const [sessionActive, setSessionActive] = useState(false);
  const [interactionMode, setInteractionMode] = useState<InteractionMode>('rotate');
  const [cameraCommand, setCameraCommand] = useState<CameraCommand>(null);
  const [copyStatus, setCopyStatus] = useState('');
  const [fallbackImmersive, setFallbackImmersive] = useState(false);
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  const manifestUrl = useMemo(() => new URL('models.json', document.baseURI), []);
  const controller = useRef<AbortController | null>(null);
  const loadTicket = useRef(0);
  const loadQueue = useRef<Promise<void>>(Promise.resolve());
  const loadedRef = useRef<GLTF | null>(null);
  const loadedModelIdRef = useRef<string | null>(null);
  const disposerRef = useRef<((gltf: GLTF) => void) | null>(null);
  const viewerProbe = useRef<(() => object) | null>(null);
  const immersiveFrame = useRef<HTMLDivElement>(null);
  const sessionActiveRef = useRef(false);
  const lastRollerLevel = useRef('1');
  const diagnostics = useRef({ loadAttempts: 0, cancellations: 0, disposals: 0, contextLosses: 0, activeLoads: 0, maxConcurrentLoads: 0 });

  const releaseLoaded = useCallback(() => {
    const current = loadedRef.current;
    loadedRef.current = null;
    loadedModelIdRef.current = null;
    if (current) {
      disposerRef.current?.(current);
      diagnostics.current.disposals += 1;
    }
    setGltf(null);
  }, []);

  const stopCurrent = useCallback((countCancellation = false) => {
    loadTicket.current += 1;
    if (controller.current) {
      controller.current.abort();
      controller.current = null;
      if (countCancellation) diagnostics.current.cancellations += 1;
    }
    releaseLoaded();
  }, [releaseLoaded]);

  const startLoadFor = useCallback((model: PublicModel) => {
    stopCurrent(true);
    diagnostics.current.loadAttempts += 1;
    const ticket = loadTicket.current;
    const nextController = new AbortController();
    controller.current = nextController;
    setCameraCommand(null);
    setLoadState({ kind: 'loading', modelId: model.id, progress: EMPTY_PROGRESS });

    const task = async () => {
      if (ticket !== loadTicket.current || nextController.signal.aborted) return;
      diagnostics.current.activeLoads += 1;
      diagnostics.current.maxConcurrentLoads = Math.max(diagnostics.current.maxConcurrentLoads, diagnostics.current.activeLoads);
      try {
        const loader = await import('./modelLoader');
        if (ticket !== loadTicket.current || nextController.signal.aborted) return;
        disposerRef.current = loader.disposeGLTF;
        const loaded = await loader.loadModel(model, manifestUrl, nextController.signal, (progress) => {
          if (ticket === loadTicket.current) setLoadState({ kind: 'loading', modelId: model.id, progress });
        });
        if (ticket !== loadTicket.current || nextController.signal.aborted) {
          loader.disposeGLTF(loaded.gltf);
          diagnostics.current.disposals += 1;
          return;
        }
        if (controller.current === nextController) controller.current = null;
        loadedRef.current = loaded.gltf;
        loadedModelIdRef.current = model.id;
        setGltf(loaded.gltf);
        setLoadState({ kind: 'ready', modelId: model.id, decodedBytes: loaded.decodedBytes, decodedSha256: loaded.decodedSha256 });
      } catch (error) {
        if (ticket !== loadTicket.current) return;
        if (controller.current === nextController) controller.current = null;
        if (nextController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) setLoadState({ kind: 'canceled' });
        else setLoadState({ kind: 'error', message: errorMessage(error) });
      } finally {
        diagnostics.current.activeLoads -= 1;
      }
    };
    loadQueue.current = loadQueue.current.catch(() => undefined).then(task);
  }, [manifestUrl, stopCurrent]);

  useEffect(() => {
    let active = true;
    fetch(manifestUrl, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Manifest HTTP ${response.status}.`);
        const data: unknown = await response.json();
        validateManifest(data);
        createUiCatalog(data.models);
        return data;
      })
      .then((data) => {
        if (!active) return;
        setManifest(data);
        const navigation = modelIdFromSearch(location.search, data.activeModel, new Set(data.models.map((model) => model.id)));
        setMissingId(navigation.missingId);
        setSelectedId(navigation.modelId);
      })
      .catch((error) => active && setManifestError(errorMessage(error)));
    return () => { active = false; };
  }, [manifestUrl]);

  useEffect(() => {
    if (!manifest) return;
    const onPopState = () => {
      const navigation = modelIdFromSearch(location.search, manifest.activeModel, new Set(manifest.models.map((model) => model.id)));
      stopCurrent(true);
      setCameraCommand(null);
      setLoadState({ kind: 'idle' });
      setMissingId(navigation.missingId);
      setSelectedId(navigation.modelId);
      if (!navigation.modelId) {
        setFallbackImmersive(false);
        if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      } else if (sessionActiveRef.current) {
        const model = manifest.models.find((candidate) => candidate.id === navigation.modelId);
        if (model) startLoadFor(model);
      }
    };
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, [manifest, startLoadFor, stopCurrent]);

  useEffect(() => {
    const onFullscreenChange = () => setNativeFullscreen(Boolean(immersiveFrame.current && document.fullscreenElement === immersiveFrame.current));
    document.addEventListener('fullscreenchange', onFullscreenChange);
    return () => document.removeEventListener('fullscreenchange', onFullscreenChange);
  }, []);

  useEffect(() => {
    if (!fallbackImmersive || !immersiveFrame.current) return;
    const frame = immersiveFrame.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(frame.querySelectorAll<HTMLElement>('button:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex="-1"])'));
    focusable()[0]?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setFallbackImmersive(false);
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      previousFocus?.focus({ preventScroll: true });
    };
  }, [fallbackImmersive]);

  useEffect(() => () => {
    loadTicket.current += 1;
    controller.current?.abort();
    if (loadedRef.current) disposerRef.current?.(loadedRef.current);
    loadedRef.current = null;
  }, []);

  const uiCatalog = useMemo(() => manifest ? createUiCatalog(manifest.models) : null, [manifest]);
  const selected = manifest?.models.find((model) => model.id === selectedId) ?? null;
  const selection = uiCatalog && selectedId ? selectionForModelId(uiCatalog, selectedId) : null;
  if (selection?.familyId === 'rollercoaster' && selection.level) lastRollerLevel.current = selection.level;

  const chooseModel = useCallback((model: PublicModel, navigation: 'push' | 'replace' = 'push') => {
    const sameModel = model.id === selectedId && !missingId;
    if (!sameModel) {
      stopCurrent(true);
      setCameraCommand(null);
      setLoadState({ kind: 'idle' });
      setMissingId(null);
      setSelectedId(model.id);
      const url = new URL(location.href);
      url.searchParams.set('model', model.id);
      history[navigation === 'push' ? 'pushState' : 'replaceState']({}, '', url);
      if (sessionActiveRef.current) startLoadFor(model);
    }
  }, [missingId, selectedId, startLoadFor, stopCurrent]);

  const startLoad = () => {
    if (!selected) return;
    sessionActiveRef.current = true;
    setSessionActive(true);
    startLoadFor(selected);
  };

  const cancelLoad = () => {
    if (loadState.kind !== 'loading') return;
    diagnostics.current.cancellations += 1;
    controller.current?.abort();
    controller.current = null;
    loadTicket.current += 1;
    sessionActiveRef.current = false;
    setSessionActive(false);
    setLoadState({ kind: 'canceled' });
  };

  const leaveImmersive = useCallback(async () => {
    setFallbackImmersive(false);
    if (document.fullscreenElement) {
      try { await document.exitFullscreen(); } catch { /* browser already left fullscreen */ }
    }
  }, []);

  const close3D = async () => {
    await leaveImmersive();
    sessionActiveRef.current = false;
    setSessionActive(false);
    stopCurrent(true);
    setCameraCommand(null);
    setLoadState({ kind: 'idle' });
  };

  const handleContextLost = useCallback(() => {
    diagnostics.current.contextLosses += 1;
    sessionActiveRef.current = false;
    setSessionActive(false);
    stopCurrent();
    setLoadState({ kind: 'error', contextLost: true, message: 'Kontekst WebGL został utracony. Zamknęliśmy model, aby zwolnić zasoby.' });
  }, [stopCurrent]);

  const applyPreset = (preset: PresetName) => setCameraCommand((current) => ({
    sequence: (current?.sequence ?? 0) + 1,
    action: 'preset',
    preset,
  }));

  const applyZoom = (factor: number) => setCameraCommand((current) => ({
    sequence: (current?.sequence ?? 0) + 1,
    action: 'zoom',
    factor,
  }));

  const toggleImmersive = async () => {
    if (nativeFullscreen || fallbackImmersive) {
      await leaveImmersive();
      return;
    }
    const element = immersiveFrame.current;
    if (!element) return;
    if (typeof element.requestFullscreen === 'function') {
      try {
        await element.requestFullscreen();
        return;
      } catch { /* iPhone and restricted browsers use the in-page fallback */ }
    }
    setFallbackImmersive(true);
  };

  const copyLink = async () => {
    const link = location.href;
    let copied = false;
    try {
      await navigator.clipboard.writeText(link);
      copied = true;
    } catch {
      const field = document.createElement('textarea');
      field.value = link;
      field.style.position = 'fixed';
      field.style.opacity = '0';
      document.body.appendChild(field);
      try {
        field.select();
        copied = document.execCommand('copy');
      } catch {
        copied = false;
      } finally {
        field.remove();
      }
    }
    setCopyStatus(copied ? 'Skopiowano' : 'Nie udało się skopiować');
    setTimeout(() => setCopyStatus(''), 1800);
  };

  useEffect(() => {
    (window as any).__modelReviewProbe = () => ({
      manifestLoaded: Boolean(manifest),
      activeModel: manifest?.activeModel ?? null,
      selectedId,
      loadedModelId: loadedModelIdRef.current,
      missingId,
      sessionActive: sessionActiveRef.current,
      loadState,
      fullscreen: { native: Boolean(immersiveFrame.current && document.fullscreenElement === immersiveFrame.current), fallback: fallbackImmersive },
      viewer: viewerProbe.current?.() ?? null,
      diagnostics: { ...diagnostics.current },
    });
    return () => { delete (window as any).__modelReviewProbe; };
  }, [fallbackImmersive, gltf, loadState, manifest, selectedId]);

  if (manifestError) {
    return <main className="fatal" role="alert"><p className="eyebrow">BŁĄD KATALOGU</p><h1>Nie można otworzyć strony.</h1><p>{manifestError}</p></main>;
  }
  if (!manifest || !uiCatalog) return <main className="fatal"><span className="spinner" /><p>Ładowanie podglądu…</p></main>;

  const progress = loadState.kind === 'loading' ? loadState.progress : null;
  const fraction = progress ? Math.min(1, progress.loaded / Math.max(1, progress.total)) : 0;
  const viewerReady = Boolean(selected && gltf && loadState.kind === 'ready' && loadState.modelId === selected.id && loadedModelIdRef.current === selected.id);
  const immersive = nativeFullscreen || fallbackImmersive;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div className="brand-block">
          <p className="eyebrow">PUBLICZNY PODGLĄD 3D</p>
          <h1>Jeden model. Jeden widok.</h1>
        </div>
        <div className="selector-bar" aria-label="Wybór modelu">
          <label>
            <span>Model</span>
            <select
              data-testid="family-select"
              value={selection?.familyId ?? ''}
              onChange={(event) => {
                const familyId = event.target.value;
                const model = modelForSelection(uiCatalog, familyId, familyId === 'rollercoaster' ? lastRollerLevel.current : null);
                if (model) chooseModel(model);
              }}
            >
              {!selection && <option value="">Wybierz model</option>}
              {uiCatalog.families.map((family) => <option value={family.id} key={family.id}>{family.label}</option>)}
            </select>
          </label>
          <label>
            <span>Poziom</span>
            <select
              data-testid="level-select"
              value={selection?.familyId === 'rollercoaster' ? selection.level ?? '1' : 'single'}
              disabled={selection?.familyId !== 'rollercoaster'}
              onChange={(event) => {
                lastRollerLevel.current = event.target.value;
                const model = modelForSelection(uiCatalog, 'rollercoaster', event.target.value);
                if (model) chooseModel(model);
              }}
            >
              {selection?.familyId === 'rollercoaster' ? (
                <><option value="1">1</option><option value="2">2</option><option value="3">3</option></>
              ) : <option value="single">Model pojedynczy</option>}
            </select>
          </label>
          <button className="share-button" data-testid="copy-link" onClick={copyLink} aria-label="Skopiuj link do wybranego modelu">
            <span aria-hidden="true">↗</span> {copyStatus || 'Kopiuj link'}
          </button>
          <span className="sr-only" aria-live="polite">{copyStatus}</span>
        </div>
      </header>

      {missingId && (
        <section className="not-found" role="alert" data-testid="model-not-found">
          <strong>Nie znaleziono modelu (404).</strong>
          <span>Identyfikator „{missingId}” nie występuje w publicznym katalogu. Wybierz model powyżej.</span>
        </section>
      )}

      <section className="review-card" data-testid="review-card">
        {selected ? (
          <>
            <div className="model-strip">
              <div><p className="eyebrow">WYBRANY MODEL</p><h2>{selected.name}</h2></div>
              <span>{formatBytes(selected.transport.compressedBytes)} do pobrania</span>
            </div>

            <div
              ref={immersiveFrame}
              className={`immersive-frame ${fallbackImmersive ? 'is-fallback-immersive' : ''}`}
              role={fallbackImmersive ? 'dialog' : undefined}
              aria-modal={fallbackImmersive ? 'true' : undefined}
              aria-label={fallbackImmersive ? 'Pełnoekranowy widok modelu 3D' : undefined}
            >
              {immersive && <button className="immersive-exit" data-testid="immersive-exit" onClick={leaveImmersive}>Zamknij pełny widok</button>}
              <div className="viewer-shell" data-load-state={loadState.kind}>
                {viewerReady ? (
                  <React.Suspense fallback={<div className="load-panel" role="status"><span className="spinner" /><strong>Uruchamianie widoku 3D…</strong></div>}>
                    <Viewer
                      key={selected.id}
                      gltf={gltf!}
                      scale={selected.modelScale}
                      command={cameraCommand}
                      interactionMode={interactionMode}
                      onContextLost={handleContextLost}
                      setProbe={(probe) => { viewerProbe.current = probe; }}
                    />
                  </React.Suspense>
                ) : (
                  <img className="preview-image" src={new URL(selected.thumbnail, manifestUrl).href} alt={`Podgląd modelu ${selected.name}`} />
                )}
                {!viewerReady && <span className="preview-badge">Podgląd statyczny</span>}

                {loadState.kind === 'idle' && (
                  <div className="start-panel">
                    <strong>Pełny model: {formatBytes(selected.transport.compressedBytes)}</strong>
                    <span>Pobieranie rozpocznie się dopiero po potwierdzeniu.</span>
                    <button className="primary" data-testid="start-3d" onClick={startLoad}>Uruchom 3D</button>
                  </div>
                )}

                {loadState.kind === 'loading' && progress && (
                  <div className="load-panel" role="status" data-testid="loading-panel">
                    <span className="spinner" />
                    <strong>{progress.detail}</strong>
                    <div className="progress-track"><span style={{ width: `${fraction * 100}%` }} /></div>
                    <span>{Math.round(fraction * 100)}% · {formatBytes(progress.loaded)} / {formatBytes(progress.total)}</span>
                    <button data-testid="cancel-load" onClick={cancelLoad}>Anuluj</button>
                  </div>
                )}

                {loadState.kind === 'canceled' && (
                  <div className="message-panel" role="status" data-testid="canceled-panel"><strong>Ładowanie anulowane.</strong><span>Częściowo wczytany model nie pozostaje na widoku.</span><button className="primary" onClick={startLoad}>Spróbuj ponownie</button></div>
                )}

                {loadState.kind === 'error' && (
                  <div className="message-panel error" role="alert" data-testid="error-panel"><strong>{loadState.contextLost ? 'Utracono kontekst 3D.' : 'Nie udało się wczytać modelu.'}</strong><span>{loadState.message}</span><button className="primary" data-testid="retry-load" onClick={startLoad}>Spróbuj ponownie</button></div>
                )}
              </div>

              {viewerReady && (
                <div className="viewer-controls" aria-label="Sterowanie widokiem 3D">
                  <div className="mode-toggle" role="group" aria-label="Tryb jednego palca lub lewego przycisku myszy">
                    <button data-testid="mode-rotate" aria-pressed={interactionMode === 'rotate'} onClick={() => setInteractionMode('rotate')}>Obrót</button>
                    <button data-testid="mode-pan" aria-pressed={interactionMode === 'pan'} onClick={() => setInteractionMode('pan')}>Przesuwanie</button>
                  </div>
                  <div className="camera-actions">
                    <button className="icon-control" data-testid="zoom-out" onClick={() => applyZoom(1.2)} aria-label="Oddal">−</button>
                    <button className="icon-control" data-testid="zoom-in" onClick={() => applyZoom(1 / 1.2)} aria-label="Przybliż">+</button>
                    <button data-testid="preset-reset" onClick={() => applyPreset('reset')}>Wycentruj</button>
                    <label className="view-select"><span className="sr-only">Ustaw widok</span><select data-testid="view-preset" defaultValue="" onChange={(event) => { if (event.target.value) applyPreset(event.target.value as PresetName); event.target.value = ''; }}><option value="" disabled>Widok</option><option value="front">Przód</option><option value="quarter">3/4</option><option value="side">Bok</option><option value="rear">Tył</option></select></label>
                    <button data-testid="fullscreen" onClick={toggleImmersive}>{immersive ? 'Zamknij widok' : 'Pełny ekran'}</button>
                    <button data-testid="close-3d" onClick={close3D}>Zamknij 3D</button>
                  </div>
                </div>
              )}
            </div>

            <p className="interaction-note"><strong>Telefon:</strong> jeden palec obraca, dwa przesuwają i zmieniają zoom. Włącz „Przesuwanie”, aby przesuwać jednym palcem. <strong>Komputer:</strong> lewy przycisk obraca (lub przesuwa w wybranym trybie), prawy/Shift przesuwa, kółko zmienia zoom.</p>

            <details className="model-details">
              <summary>Informacje o modelu i pobieraniu</summary>
              <div>
                <p>{selected.description}</p>
                <p><strong>Pełne dane:</strong> {formatBytes(selected.transport.compressedBytes)} po kompresji, {formatBytes(selected.transport.decodedBytes)} po rozpakowaniu, {selected.triangles.toLocaleString('pl-PL')} trójkątów.</p>
                <p>To ciężki, pełnojakościowy plik. Wynik nie oznacza gotowości telefonu ani gwarantowanej płynności. Kompresja służy tylko do transportu — geometria i tekstury nie zostały zredukowane.</p>
                <p><strong>Status wyglądu:</strong> {selected.appearance}</p>
              </div>
            </details>
          </>
        ) : (
          <div className="empty-view"><strong>Wybierz model</strong><span>Widok 3D nie pobiera danych modelu bez Twojego potwierdzenia.</span></div>
        )}
      </section>

      <footer>Publiczny podgląd udostępnionych modeli · bez logowania, przesyłania plików i automatycznego pobierania 3D.</footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
