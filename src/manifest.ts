import type { ModelsManifest } from './types';

const HEX_256 = /^[a-f0-9]{64}$/;

function assertSafeRelativePath(value: string, prefix: string): void {
  if (typeof value !== 'string' || !value.startsWith(prefix) || value.startsWith('/') || value.includes('\\')) throw new Error(`Niedozwolona ścieżka zasobu: ${value}`);
  const segments = value.split('/');
  if (segments.some((segment) => !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(segment) || segment === '.' || segment === '..')) throw new Error(`Niedozwolona ścieżka zasobu: ${value}`);
}

export function validateManifest(value: unknown): asserts value is ModelsManifest {
  if (!value || typeof value !== 'object') throw new Error('Manifest nie jest obiektem JSON.');
  const manifest = value as any;
  if (manifest.schemaVersion !== 1 || typeof manifest.activeModel !== 'string' || !Array.isArray(manifest.models) || manifest.models.length < 1) {
    throw new Error('Manifest ma nieobsługiwany format.');
  }
  const ids = new Set<string>();
  for (const model of manifest.models) {
    if (!model || typeof model !== 'object' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(model.id) || ids.has(model.id)) throw new Error('Manifest zawiera błędny lub powtórzony identyfikator modelu.');
    ids.add(model.id);
    if (typeof model.name !== 'string' || typeof model.description !== 'string' || !Number.isInteger(model.triangles) || model.triangles <= 0 || typeof model.modelScale !== 'number' || !Number.isFinite(model.modelScale) || model.modelScale <= 0) throw new Error(`Niepełne dane modelu ${model.id}.`);
    assertSafeRelativePath(model.thumbnail, 'previews/');
    const transport = model.transport;
    if (!transport || transport.encoding !== 'gzip-parts' || !Array.isArray(transport.parts) || transport.parts.length < 1) throw new Error(`Nieobsługiwany transport modelu ${model.id}.`);
    if (!Number.isInteger(transport.compressedBytes) || !Number.isInteger(transport.decodedBytes) || !HEX_256.test(transport.gzipSha256) || !HEX_256.test(transport.decodedSha256)) throw new Error(`Błędne sumy kontrolne modelu ${model.id}.`);
    let compressed = 0;
    for (const part of transport.parts) {
      assertSafeRelativePath(part.url, 'models/');
      if (!Number.isInteger(part.bytes) || part.bytes <= 0 || !HEX_256.test(part.sha256)) throw new Error(`Błędny fragment transportu modelu ${model.id}.`);
      compressed += part.bytes;
    }
    if (compressed !== transport.compressedBytes) throw new Error(`Suma rozmiarów fragmentów modelu ${model.id} nie zgadza się z manifestem.`);
  }
  if (!ids.has(manifest.activeModel)) throw new Error('Aktywny model nie istnieje w katalogu.');
}
