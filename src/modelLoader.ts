import * as THREE from 'three';
import { GLTFLoader, type GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { LoadedModel, LoadProgress, PublicModel } from './types';

function abortError(): DOMException {
  return new DOMException('Ładowanie anulowane.', 'AbortError');
}

function checkAbort(signal: AbortSignal): void {
  if (signal.aborted) throw abortError();
}

async function sha256(data: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function readStream(
  stream: ReadableStream<Uint8Array>,
  expected: number,
  signal: AbortSignal,
  onBytes: (loaded: number) => void,
): Promise<Uint8Array> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let loaded = 0;
  const cancel = () => { void reader.cancel(abortError()).catch(() => undefined); };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      checkAbort(signal);
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      chunks.push(value);
      loaded += value.byteLength;
      if (loaded > expected) throw new Error(`Odebrano więcej bajtów niż zadeklarowano (${loaded} > ${expected}).`);
      onBytes(loaded);
    }
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
  checkAbort(signal);
  if (loaded !== expected) throw new Error(`Niepełny plik: odebrano ${loaded} z ${expected} bajtów.`);
  const joined = new Uint8Array(loaded);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return joined;
}

function parseGLB(buffer: ArrayBuffer, signal: AbortSignal): Promise<GLTF> {
  return new Promise((resolve, reject) => {
    const loader = new GLTFLoader();
    loader.parse(
      buffer,
      '',
      (gltf) => {
        if (signal.aborted) {
          disposeGLTF(gltf);
          reject(abortError());
          return;
        }
        resolve(gltf);
      },
      (error) => reject(error instanceof Error ? error : new Error(String(error))),
    );
  });
}

export async function loadModel(
  model: PublicModel,
  manifestUrl: URL,
  signal: AbortSignal,
  onProgress: (progress: LoadProgress) => void,
): Promise<LoadedModel> {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('Ta przeglądarka nie obsługuje bezpiecznej dekompresji gzip (DecompressionStream). Użyj aktualnej wersji Chrome, Edge, Firefox lub Safari.');
  }

  const partBuffers: Uint8Array[] = [];
  let totalDownloaded = 0;
  for (let index = 0; index < model.transport.parts.length; index += 1) {
    checkAbort(signal);
    const part = model.transport.parts[index];
    const url = new URL(part.url, manifestUrl);
    if (url.origin !== manifestUrl.origin) throw new Error('Zasób modelu wskazuje poza tę witrynę.');
    const response = await fetch(url, { signal, cache: 'default', credentials: 'same-origin' });
    if (!response.ok) throw new Error(`Fragment ${index + 1}: HTTP ${response.status}.`);
    if (!response.body) throw new Error(`Fragment ${index + 1}: brak strumienia odpowiedzi.`);
    const before = totalDownloaded;
    const bytes = await readStream(response.body, part.bytes, signal, (partLoaded) => {
      onProgress({
        phase: 'download',
        loaded: before + partLoaded,
        total: model.transport.compressedBytes,
        part: index + 1,
        partCount: model.transport.parts.length,
        detail: `Pobieranie części ${index + 1} z ${model.transport.parts.length}`,
      });
    });
    const partHash = await sha256(bytes);
    checkAbort(signal);
    if (partHash !== part.sha256) throw new Error(`Część ${index + 1} ma nieprawidłową sumę SHA-256.`);
    partBuffers.push(bytes);
    totalDownloaded += bytes.byteLength;
  }

  onProgress({ phase: 'compressed-check', loaded: 0, total: model.transport.compressedBytes, detail: 'Weryfikacja połączonego archiwum gzip' });
  const compressed = new Uint8Array(model.transport.compressedBytes);
  let offset = 0;
  for (const part of partBuffers) {
    compressed.set(part, offset);
    offset += part.byteLength;
  }
  const gzipHash = await sha256(compressed);
  checkAbort(signal);
  if (gzipHash !== model.transport.gzipSha256) throw new Error('Połączone archiwum gzip ma nieprawidłową sumę SHA-256.');

  const decompressedStream = new Blob([compressed], { type: 'application/gzip' })
    .stream()
    .pipeThrough(new DecompressionStream('gzip'));
  const decoded = await readStream(decompressedStream, model.transport.decodedBytes, signal, (loaded) => {
    onProgress({ phase: 'decompress', loaded, total: model.transport.decodedBytes, detail: 'Dekompresja w przeglądarce' });
  });

  onProgress({ phase: 'decoded-check', loaded: decoded.byteLength, total: decoded.byteLength, detail: 'Weryfikacja pełnego pliku GLB' });
  const decodedHash = await sha256(decoded);
  checkAbort(signal);
  if (decodedHash !== model.transport.decodedSha256) throw new Error('Rozpakowany GLB ma nieprawidłową sumę SHA-256.');
  if (decoded.byteLength < 12 || decoded[0] !== 0x67 || decoded[1] !== 0x6c || decoded[2] !== 0x54 || decoded[3] !== 0x46) throw new Error('Rozpakowany plik nie ma nagłówka GLB.');
  const declaredLength = new DataView(decoded.buffer, decoded.byteOffset, decoded.byteLength).getUint32(8, true);
  if (declaredLength !== decoded.byteLength) throw new Error('Długość zadeklarowana w GLB nie zgadza się z plikiem.');

  onProgress({ phase: 'parse', loaded: decoded.byteLength, total: decoded.byteLength, detail: 'Tworzenie sceny 3D' });
  const gltf = await parseGLB(decoded.buffer, signal);
  return { gltf, decodedBytes: decoded.byteLength, decodedSha256: decodedHash };
}

export function disposeGLTF(gltf: GLTF): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();
  const textures = new Set<THREE.Texture>();
  const skeletons = new Set<THREE.Skeleton>();
  const imageSources = new Set<{ close?: () => void }>();
  const scenes = new Set([gltf.scene, ...gltf.scenes]);
  for (const scene of scenes) {
    scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.isSkinnedMesh && (mesh as THREE.SkinnedMesh).skeleton) skeletons.add((mesh as THREE.SkinnedMesh).skeleton);
      if (!mesh.isMesh) return;
      if (mesh.geometry) geometries.add(mesh.geometry);
      const list = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of list) if (material) materials.add(material);
    });
  }
  const findTextures = (value: unknown, seen = new WeakSet<object>()): void => {
    if (value instanceof THREE.Texture) {
      textures.add(value);
      return;
    }
    if (!value || typeof value !== 'object' || seen.has(value as object)) return;
    seen.add(value as object);
    if (Array.isArray(value)) for (const item of value) findTextures(item, seen);
    else for (const item of Object.values(value)) findTextures(item, seen);
  };
  for (const material of materials) {
    for (const value of Object.values(material)) {
      if (value instanceof THREE.Texture) textures.add(value);
    }
    findTextures((material as THREE.ShaderMaterial).uniforms);
  }
  for (const texture of textures) {
    const source = texture.source?.data as { close?: () => void } | undefined;
    if (source) imageSources.add(source);
    texture.dispose();
  }
  for (const source of imageSources) source.close?.();
  for (const skeleton of skeletons) skeleton.dispose();
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  for (const scene of scenes) scene.clear();
}
