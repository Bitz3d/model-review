import React, { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';

export type PresetName = 'front' | 'quarter' | 'side' | 'rear' | 'reset';
export type CameraCommand = { sequence: number; preset: PresetName } | null;

const REVIEW_DISTANCE = 2.4;
const FULL_SCENE_DISTANCE = 3;

function distanceForScale(scale: number): number {
  return scale >= 1 ? FULL_SCENE_DISTANCE : REVIEW_DISTANCE;
}

function presetFor(name: PresetName, distance: number): { position: [number, number, number]; target: [number, number, number] } {
  const diagonal = distance / Math.sqrt(2);
  const presets: Record<PresetName, { position: [number, number, number]; target: [number, number, number] }> = {
    front: { position: [0, 0.15, distance], target: [0, 0.02, 0] },
    quarter: { position: [-diagonal, 0.35, diagonal], target: [0, 0, 0] },
    side: { position: [-distance, 0.35, 0], target: [0, 0, 0] },
    rear: { position: [0, 0.35, -distance], target: [0, 0, 0] },
    reset: { position: [0, 0.35, distance], target: [0, 0, 0] },
  };
  return presets[name];
}

function Scene({
  gltf,
  scale,
  command,
  onContextLost,
  setProbe,
}: {
  gltf: GLTF;
  scale: number;
  command: CameraCommand;
  onContextLost: () => void;
  setProbe: (probe: (() => object) | null) => void;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, gl, invalidate, scene } = useThree();
  const distance = distanceForScale(scale);

  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => {
      event.preventDefault();
      onContextLost();
    };
    canvas.addEventListener('webglcontextlost', lost, false);
    return () => canvas.removeEventListener('webglcontextlost', lost, false);
  }, [gl, onContextLost]);

  useEffect(() => {
    setProbe(() => ({
      triangles: gl.info.render.triangles,
      drawCalls: gl.info.render.calls,
      geometries: gl.info.memory.geometries,
      textures: gl.info.memory.textures,
      contextLost: gl.getContext().isContextLost(),
      camera: {
        position: camera.position.toArray(),
        target: controls.current?.target.toArray() ?? null,
        fov: (camera as any).fov,
      },
      presentation: {
        background: (scene.background as any)?.getHexString?.() ?? null,
        modelScale: gltf.scene.scale.toArray(),
        lights: scene.children
          .filter((object: any) => object.isLight)
          .map((light: any) => ({ type: light.type, intensity: light.intensity, position: light.position.toArray() })),
      },
      canvas: [gl.domElement.width, gl.domElement.height],
    }));
    invalidate();
    return () => setProbe(null);
  }, [camera, gl, gltf.scene, invalidate, scene, setProbe]);

  useEffect(() => {
    if (!command || !controls.current) return;
    const preset = presetFor(command.preset, distance);
    camera.position.fromArray(preset.position);
    controls.current.target.fromArray(preset.target);
    controls.current.update();
    invalidate();
  }, [command?.sequence, camera, distance, invalidate]);

  return (
    <>
      <color attach="background" args={['#f5f1e8']} />
      <ambientLight intensity={0.9} />
      <directionalLight position={[3, 4, 5]} intensity={2.2} />
      <directionalLight position={[-4, -1, -3]} intensity={0.7} />
      <primitive object={gltf.scene} scale={scale} />
      <OrbitControls
        ref={controls}
        makeDefault
        enableDamping={false}
        enablePan={false}
        enableZoom
        enableRotate
        minDistance={1.15}
        maxDistance={6}
      />
    </>
  );
}

export function Viewer({
  gltf,
  scale,
  command,
  onContextLost,
  setProbe,
}: {
  gltf: GLTF;
  scale: number;
  command: CameraCommand;
  onContextLost: () => void;
  setProbe: (probe: (() => object) | null) => void;
}) {
  return (
    <Canvas
      frameloop="demand"
      dpr={1}
      camera={{ position: [0, 0.35, distanceForScale(scale)], fov: 35, near: 0.01, far: 100 }}
      gl={{ antialias: true, preserveDrawingBuffer: true, powerPreference: 'high-performance' }}
      onCreated={({ gl }) => {
        gl.domElement.dataset.testid = 'model-canvas';
        gl.domElement.tabIndex = 0;
      }}
    >
      <Scene gltf={gltf} scale={scale} command={command} onContextLost={onContextLost} setProbe={setProbe} />
    </Canvas>
  );
}
