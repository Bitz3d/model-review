import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type TransportPart = {
  url: string;
  bytes: number;
  sha256: string;
};

export type PublicModel = {
  id: string;
  name: string;
  description: string;
  thumbnail: string;
  triangles: number;
  modelScale: number;
  transport: {
    encoding: 'gzip-parts';
    parts: TransportPart[];
    compressedBytes: number;
    gzipSha256: string;
    decodedBytes: number;
    decodedSha256: string;
  };
  version: string;
  appearance: string;
};

export type ModelsManifest = {
  schemaVersion: 1;
  activeModel: string;
  models: PublicModel[];
};

export type LoadProgress = {
  phase: 'download' | 'compressed-check' | 'decompress' | 'decoded-check' | 'parse';
  loaded: number;
  total: number;
  part?: number;
  partCount?: number;
  detail: string;
};

export type LoadedModel = {
  gltf: GLTF;
  decodedBytes: number;
  decodedSha256: string;
};
