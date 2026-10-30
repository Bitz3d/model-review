import React, { useEffect, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls } from '@react-three/drei';
import { Box3, MOUSE, TOUCH, Vector2, Vector3, Vector4 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { distanceLimitsForFit, fitDistanceForAspect, fitScaleForAspect } from './cameraFraming.mjs';

export type PresetName = 'front' | 'quarter' | 'side' | 'rear' | 'reset';
export type InteractionMode = 'rotate' | 'pan';
export type CameraCommand =
  | { sequence: number; action: 'preset'; preset: PresetName }
  | { sequence: number; action: 'zoom'; factor: number }
  | null;

const REVIEW_DISTANCE = 2.4;
const FULL_SCENE_DISTANCE = 3;
const MIN_DISTANCE = 1.15;
const MAX_DISTANCE = 6;

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
  interactionMode,
  onContextLost,
  setProbe,
}: {
  gltf: GLTF;
  scale: number;
  command: CameraCommand;
  interactionMode: InteractionMode;
  onContextLost: () => void;
  setProbe: (probe: (() => object) | null) => void;
}) {
  const controls = useRef<OrbitControlsImpl>(null);
  const { camera, gl, invalidate, scene, size } = useThree();
  const baselineDistance = distanceForScale(scale);
  const isFullScene = scale >= 1;
  const aspect = size.height > 0 ? size.width / size.height : (camera as any).aspect;
  const fitDistance = fitDistanceForAspect(baselineDistance, isFullScene, aspect);
  const fitScale = fitScaleForAspect(isFullScene, aspect);
  const distanceLimits = distanceLimitsForFit(fitDistance, isFullScene, MIN_DISTANCE, MAX_DISTANCE, baselineDistance);
  const previousFitDistance = useRef(baselineDistance);

  useEffect(() => {
    const canvas = gl.domElement;
    const lost = (event: Event) => {
      event.preventDefault();
      onContextLost();
    };
    const focusCanvas = () => canvas.focus({ preventScroll: true });
    canvas.addEventListener('webglcontextlost', lost, false);
    canvas.addEventListener('pointerdown', focusCanvas, false);
    return () => {
      canvas.removeEventListener('webglcontextlost', lost, false);
      canvas.removeEventListener('pointerdown', focusCanvas, false);
    };
  }, [gl, onContextLost]);

  useEffect(() => {
    const current = controls.current;
    if (!current) return;
    current.listenToKeyEvents(gl.domElement);
    return () => current.stopListenToKeyEvents();
  }, [gl]);

  useEffect(() => {
    setProbe(() => {
      const canvas = gl.domElement;
      const canvasRect = canvas.getBoundingClientRect();
      const shellRect = canvas.closest('.viewer-shell')?.getBoundingClientRect();
      const drawingBuffer = gl.getDrawingBufferSize(new Vector2());
      const rendererViewport = gl.getViewport(new Vector4());
      const context = gl.getContext();
      const gpuViewport = Array.from(context.getParameter(context.VIEWPORT) as Int32Array);
      let intendedBounds = null;
      if (isFullScene) {
        // Rollercoaster's source scene is the intended review object. Project its
        // post-scale world AABB for test evidence without changing model content.
        gltf.scene.updateWorldMatrix(true, true);
        camera.updateMatrixWorld();
        const worldBox = new Box3().setFromObject(gltf.scene, true);
        const ndcMinimum = new Vector3(Infinity, Infinity, Infinity);
        const ndcMaximum = new Vector3(-Infinity, -Infinity, -Infinity);
        for (const x of [worldBox.min.x, worldBox.max.x]) {
          for (const y of [worldBox.min.y, worldBox.max.y]) {
            for (const z of [worldBox.min.z, worldBox.max.z]) {
              const projected = new Vector3(x, y, z).project(camera);
              ndcMinimum.min(projected);
              ndcMaximum.max(projected);
            }
          }
        }
        intendedBounds = {
          sourceWorldBox: { minimum: worldBox.min.toArray(), maximum: worldBox.max.toArray() },
          ndc: { minimum: ndcMinimum.toArray(), maximum: ndcMaximum.toArray() },
          canvasPixels: {
            left: ((ndcMinimum.x + 1) / 2) * canvasRect.width,
            right: ((ndcMaximum.x + 1) / 2) * canvasRect.width,
            top: ((1 - ndcMaximum.y) / 2) * canvasRect.height,
            bottom: ((1 - ndcMinimum.y) / 2) * canvasRect.height,
          },
          maximumAbsoluteXY: Math.max(Math.abs(ndcMinimum.x), Math.abs(ndcMaximum.x), Math.abs(ndcMinimum.y), Math.abs(ndcMaximum.y)),
          fullyInsideClip: ndcMinimum.x >= -1 && ndcMaximum.x <= 1 && ndcMinimum.y >= -1 && ndcMaximum.y <= 1 && ndcMinimum.z >= -1 && ndcMaximum.z <= 1,
        };
      }
      return {
        triangles: gl.info.render.triangles,
        drawCalls: gl.info.render.calls,
        geometries: gl.info.memory.geometries,
        textures: gl.info.memory.textures,
        contextLost: context.isContextLost(),
        interactionMode,
        camera: {
          position: camera.position.toArray(),
          target: controls.current?.target.toArray() ?? null,
          distance: controls.current ? camera.position.distanceTo(controls.current.target) : null,
          fov: (camera as any).fov,
          aspect: (camera as any).aspect ?? null,
          baselineDistance,
          fitDistance,
          fitScale,
          minimumDistance: distanceLimits.minimum,
          maximumDistance: distanceLimits.maximum,
        },
        intendedBounds,
        presentation: {
          background: (scene.background as any)?.getHexString?.() ?? null,
          modelScale: gltf.scene.scale.toArray(),
          lights: scene.children
            .filter((object: any) => object.isLight)
            .map((light: any) => ({ type: light.type, intensity: light.intensity, position: light.position.toArray() })),
        },
        dimensions: {
          canvasCss: [canvasRect.width, canvasRect.height],
          viewerShellCss: shellRect ? [shellRect.width, shellRect.height] : null,
          backingBuffer: [canvas.width, canvas.height],
          drawingBuffer: drawingBuffer.toArray(),
          rendererViewport: rendererViewport.toArray(),
          gpuViewport,
          r3fSize: [size.width, size.height],
          dpr: gl.getPixelRatio(),
        },
        renderFrame: gl.info.render.frame,
        canvas: [canvas.width, canvas.height],
      };
    });
    invalidate();
    return () => setProbe(null);
  }, [baselineDistance, camera, distanceLimits.maximum, distanceLimits.minimum, fitDistance, fitScale, gl, gltf.scene, interactionMode, invalidate, isFullScene, scene, setProbe, size.height, size.width]);

  useEffect(() => {
    const current = controls.current;
    if (!current) return;
    const priorFit = previousFitDistance.current;
    if (Math.abs(fitDistance - priorFit) > 0.000001) {
      const offset = camera.position.clone().sub(current.target);
      const relativeZoom = offset.length() / priorFit;
      const nextDistance = Math.min(distanceLimits.maximum, Math.max(distanceLimits.minimum, fitDistance * relativeZoom));
      offset.setLength(nextDistance);
      camera.position.copy(current.target).add(offset);
      current.update();
    }
    previousFitDistance.current = fitDistance;
    // The canvas uses demand rendering, so every ResizeObserver size commit must
    // explicitly produce a frame with the updated camera projection/viewport.
    invalidate();
  }, [camera, distanceLimits.maximum, distanceLimits.minimum, fitDistance, invalidate, size.height, size.width]);

  useEffect(() => {
    if (!command || !controls.current) return;
    if (command.action === 'preset') {
      const preset = presetFor(command.preset, fitDistance);
      camera.position.fromArray(preset.position);
      controls.current.target.fromArray(preset.target);
    } else {
      const target = controls.current.target;
      const offset = camera.position.clone().sub(target);
      const nextDistance = Math.min(distanceLimits.maximum, Math.max(distanceLimits.minimum, offset.length() * command.factor));
      offset.setLength(nextDistance);
      camera.position.copy(target).add(offset);
    }
    controls.current.update();
    invalidate();
  }, [command?.sequence, camera, invalidate]);

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
        enablePan
        enableZoom
        enableRotate
        minDistance={distanceLimits.minimum}
        maxDistance={distanceLimits.maximum}
        mouseButtons={{
          LEFT: interactionMode === 'rotate' ? MOUSE.ROTATE : MOUSE.PAN,
          MIDDLE: MOUSE.DOLLY,
          RIGHT: MOUSE.PAN,
        }}
        touches={{
          ONE: interactionMode === 'rotate' ? TOUCH.ROTATE : TOUCH.PAN,
          TWO: TOUCH.DOLLY_PAN,
        }}
      />
    </>
  );
}

export function Viewer({
  gltf,
  scale,
  command,
  interactionMode,
  onContextLost,
  setProbe,
}: {
  gltf: GLTF;
  scale: number;
  command: CameraCommand;
  interactionMode: InteractionMode;
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
        gl.domElement.setAttribute('aria-label', 'Interaktywny widok modelu 3D');
      }}
    >
      <Scene
        gltf={gltf}
        scale={scale}
        command={command}
        interactionMode={interactionMode}
        onContextLost={onContextLost}
        setProbe={setProbe}
      />
    </Canvas>
  );
}
