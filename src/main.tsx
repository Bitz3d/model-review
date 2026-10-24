import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { validateManifest } from './manifest';
import type { CameraCommand, PresetName } from './Viewer';
import type { LoadProgress, ModelsManifest, PublicModel } from './types';
import './styles.css';

const Viewer = React.lazy(() => import('./Viewer').then((module) => ({ default: module.Viewer })));

type LoadState =
  | { kind: 'idle' }
  | { kind: 'loading'; progress: LoadProgress }
  | { kind: 'ready'; decodedBytes: number; decodedSha256: string }
  | { kind: 'canceled' }
  | { kind: 'error'; message: string; contextLost?: boolean };

const EMPTY_PROGRESS: LoadProgress = { phase: 'download', loaded: 0, total: 1, detail: 'Przygotowanie pobierania' };
const PRESETS: Array<[PresetName, string]> = [
  ['front', 'Przód'],
  ['quarter', '3/4'],
  ['side', 'Bok'],
  ['rear', 'Tył'],
  ['reset', 'Reset'],
];

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
  const [cameraCommand, setCameraCommand] = useState<CameraCommand>(null);
  const manifestUrl = useMemo(() => new URL('models.json', document.baseURI), []);
  const controller = useRef<AbortController | null>(null);
  const loadTicket = useRef(0);
  const loadedRef = useRef<GLTF | null>(null);
  const disposerRef = useRef<((gltf: GLTF) => void) | null>(null);
  const viewerProbe = useRef<(() => object) | null>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const diagnostics = useRef({ loadAttempts: 0, cancellations: 0, disposals: 0, contextLosses: 0 });

  const releaseLoaded = useCallback(() => {
    const current = loadedRef.current;
    loadedRef.current = null;
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

  useEffect(() => {
    let active = true;
    fetch(manifestUrl, { cache: 'no-store', credentials: 'same-origin' })
      .then(async (response) => {
        if (!response.ok) throw new Error(`Manifest HTTP ${response.status}.`);
        const data: unknown = await response.json();
        validateManifest(data);
        return data;
      })
      .then((data) => {
        if (!active) return;
        setManifest(data);
        const requested = new URLSearchParams(location.search).get('model');
        if (requested && !data.models.some((model) => model.id === requested)) {
          setMissingId(requested);
          setSelectedId(null);
        } else {
          setMissingId(null);
          setSelectedId(requested || data.activeModel);
        }
      })
      .catch((error) => active && setManifestError(errorMessage(error)));
    return () => { active = false; };
  }, [manifestUrl]);

  useEffect(() => {
    if (!manifest) return;
    const onPopState = () => {
      stopCurrent();
      setLoadState({ kind: 'idle' });
      const requested = new URLSearchParams(location.search).get('model');
      if (requested && !manifest.models.some((model) => model.id === requested)) {
        setMissingId(requested);
        setSelectedId(null);
      } else {
        setMissingId(null);
        setSelectedId(requested || manifest.activeModel);
      }
    };
    addEventListener('popstate', onPopState);
    return () => removeEventListener('popstate', onPopState);
  }, [manifest, stopCurrent]);

  useEffect(() => () => {
    loadTicket.current += 1;
    controller.current?.abort();
    if (loadedRef.current) disposerRef.current?.(loadedRef.current);
    loadedRef.current = null;
  }, []);

  const selected = manifest?.models.find((model) => model.id === selectedId) ?? null;

  const chooseModel = (model: PublicModel) => {
    stopCurrent();
    setLoadState({ kind: 'idle' });
    setMissingId(null);
    setSelectedId(model.id);
    const url = new URL(location.href);
    url.searchParams.set('model', model.id);
    history.pushState({}, '', url);
    scrollTo({ top: 0, behavior: 'smooth' });
  };

  const startLoad = useCallback(async () => {
    if (!selected) return;
    stopCurrent();
    diagnostics.current.loadAttempts += 1;
    const ticket = loadTicket.current;
    const nextController = new AbortController();
    controller.current = nextController;
    setLoadState({ kind: 'loading', progress: EMPTY_PROGRESS });
    try {
      const loader = await import('./modelLoader');
      if (ticket !== loadTicket.current || nextController.signal.aborted) return;
      disposerRef.current = loader.disposeGLTF;
      const loaded = await loader.loadModel(selected, manifestUrl, nextController.signal, (progress) => {
        if (ticket === loadTicket.current) setLoadState({ kind: 'loading', progress });
      });
      if (ticket !== loadTicket.current || nextController.signal.aborted) {
        loader.disposeGLTF(loaded.gltf);
        return;
      }
      controller.current = null;
      loadedRef.current = loaded.gltf;
      setGltf(loaded.gltf);
      setLoadState({ kind: 'ready', decodedBytes: loaded.decodedBytes, decodedSha256: loaded.decodedSha256 });
    } catch (error) {
      if (ticket !== loadTicket.current) return;
      controller.current = null;
      if (nextController.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) setLoadState({ kind: 'canceled' });
      else setLoadState({ kind: 'error', message: errorMessage(error) });
    }
  }, [selected, manifestUrl, stopCurrent]);

  const cancelLoad = () => {
    if (loadState.kind !== 'loading') return;
    diagnostics.current.cancellations += 1;
    controller.current?.abort();
    controller.current = null;
    loadTicket.current += 1;
    setLoadState({ kind: 'canceled' });
  };

  const close3D = () => {
    stopCurrent();
    setLoadState({ kind: 'idle' });
  };

  const handleContextLost = useCallback(() => {
    diagnostics.current.contextLosses += 1;
    stopCurrent();
    setLoadState({ kind: 'error', contextLost: true, message: 'Kontekst WebGL został utracony. Zamknęliśmy model, aby zwolnić zasoby.' });
  }, [stopCurrent]);

  const applyPreset = (preset: PresetName) => setCameraCommand((current) => ({ sequence: (current?.sequence ?? 0) + 1, preset }));

  useEffect(() => {
    (window as any).__modelReviewProbe = () => ({
      manifestLoaded: Boolean(manifest),
      activeModel: manifest?.activeModel ?? null,
      selectedId,
      missingId,
      loadState,
      viewer: viewerProbe.current?.() ?? null,
      diagnostics: { ...diagnostics.current },
    });
    return () => { delete (window as any).__modelReviewProbe; };
  }, [manifest, selectedId, missingId, loadState, gltf]);

  if (manifestError) {
    return <main className="fatal" role="alert"><p className="eyebrow">BŁĄD KATALOGU</p><h1>Nie można otworzyć strony.</h1><p>{manifestError}</p></main>;
  }
  if (!manifest) return <main className="fatal"><span className="spinner" /><p>Ładowanie katalogu…</p></main>;

  const progress = loadState.kind === 'loading' ? loadState.progress : null;
  const fraction = progress ? Math.min(1, progress.loaded / Math.max(1, progress.total)) : 0;

  return (
    <main className="app-shell">
      <header className="topbar">
        <div>
          <p className="eyebrow">PUBLICZNY PRZEGLĄD MODELI 3D</p>
          <h1>Galeria modeli</h1>
          <p className="intro">Wybierz model i uruchom widok 3D dopiero wtedy, gdy chcesz pobrać pełny plik.</p>
        </div>
        <div className="scope-chip">1 widok interaktywny · ładowanie na żądanie</div>
      </header>

      {missingId && (
        <section className="not-found" role="alert" data-testid="model-not-found">
          <strong>Nie znaleziono modelu (404).</strong>
          <span>Identyfikator „{missingId}” nie występuje w publicznym katalogu. Wybierz model poniżej.</span>
        </section>
      )}

      {selected && (
        <section className="review-card" data-testid="review-card">
          <div className="review-heading">
            <div><p className="eyebrow">WYBRANY MODEL</p><h2>{selected.name}</h2><p>{selected.description}</p></div>
            <div className="facts"><span>{selected.triangles.toLocaleString('pl-PL')} trójkątów</span><span>Skala sceny {selected.modelScale}</span></div>
          </div>

          <div className="viewer-shell" ref={viewport} data-load-state={loadState.kind}>
            {gltf && loadState.kind === 'ready' ? (
              <React.Suspense fallback={<div className="load-panel" role="status"><span className="spinner" /><strong>Uruchamianie widoku 3D…</strong></div>}>
                <Viewer gltf={gltf} scale={selected.modelScale} command={cameraCommand} onContextLost={handleContextLost} setProbe={(probe) => { viewerProbe.current = probe; }} />
              </React.Suspense>
            ) : (
              <img className="preview-image" src={new URL(selected.thumbnail, manifestUrl).href} alt={`Podgląd modelu ${selected.name}`} />
            )}
            {!gltf && <span className="preview-badge">Podgląd statyczny · to nie jest model interaktywny</span>}

            {loadState.kind === 'idle' && (
              <div className="start-panel">
                <strong>Pełny model ma około {Math.round(selected.transport.compressedBytes / 1_000_000)} MB po kompresji</strong>
                <span>Po pobraniu przeglądarka rozpakowuje i sprawdza {formatBytes(selected.transport.decodedBytes)} danych. To ciężki model; wynik nie oznacza gotowości telefonu ani gwarantowanej płynności.</span>
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
              <div className="message-panel" role="status" data-testid="canceled-panel"><strong>Ładowanie anulowane.</strong><span>Nie zachowujemy częściowo wczytanego modelu w pamięci GPU.</span><button className="primary" onClick={startLoad}>Spróbuj ponownie</button></div>
            )}

            {loadState.kind === 'error' && (
              <div className="message-panel error" role="alert" data-testid="error-panel"><strong>{loadState.contextLost ? 'Utracono kontekst 3D.' : 'Nie udało się wczytać modelu.'}</strong><span>{loadState.message}</span><button className="primary" data-testid="retry-load" onClick={startLoad}>Spróbuj ponownie</button></div>
            )}
          </div>

          {loadState.kind === 'ready' && (
            <div className="viewer-controls" aria-label="Sterowanie widokiem 3D">
              <div className="preset-buttons">{PRESETS.map(([preset, label]) => <button key={preset} data-testid={`preset-${preset}`} onClick={() => applyPreset(preset)}>{label}</button>)}</div>
              <div className="right-controls">
                <button onClick={() => viewport.current?.requestFullscreen?.()}>Pełny ekran</button>
                <button data-testid="close-3d" onClick={close3D}>Zamknij 3D</button>
              </div>
            </div>
          )}
          <p className="interaction-note">W widoku 3D: przeciągnij, aby obracać; kółko myszy lub gest pinch zmienia zoom. Model nie jest automatycznie dopasowywany do odległych fragmentów.</p>
        </section>
      )}

      <section className="catalog-section" aria-labelledby="catalog-title">
        <div className="catalog-heading"><div><p className="eyebrow">KATALOG</p><h2 id="catalog-title">Dostępne modele</h2></div><p>Karty pobierają tylko miniatury. Pełne dane 3D są pobierane po użyciu przycisku „Uruchom 3D”.</p></div>
        <div className="catalog-grid">
          {manifest.models.map((model) => (
            <article className={`model-card ${model.id === selectedId ? 'is-selected' : ''}`} key={model.id} data-testid={`card-${model.id}`}>
              <img src={new URL(model.thumbnail, manifestUrl).href} alt="" loading="lazy" />
              <div><span className="version">{model.version}</span><h3>{model.name}</h3><p>{model.description}</p><small>{model.triangles.toLocaleString('pl-PL')} trójkątów · {formatBytes(model.transport.compressedBytes)} do pobrania</small><button onClick={() => chooseModel(model)}>{model.id === selectedId ? 'Wybrany model' : 'Wybierz model'}</button></div>
            </article>
          ))}
        </div>
      </section>

      <footer>Publiczny podgląd zatwierdzonego modelu. Kompresja służy wyłącznie do transportu — geometria i tekstury nie zostały zredukowane. Brak logowania, panelu administracyjnego i przesyłania plików.</footer>
    </main>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
