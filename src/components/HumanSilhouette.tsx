'use client';

import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { useRef, useMemo } from 'react';
import * as THREE from 'three';

/*
  Human-silhouette particle figure.
  Recolored to Orbit's lavender + teal palette so it reads as "you" inside the
  network dashboard rather than an arbitrary anatomical render.
  Heights: total ~3 world units, head at y≈2.75, feet at y=0.
*/

function generateHumanParticles(count: number): Float32Array {
  const positions = new Float32Array(count * 3);
  let idx = 0;

  function addPoint(x: number, y: number, z: number) {
    if (idx >= count * 3) return;
    positions[idx++] = x + (Math.random() - 0.5) * 0.02;
    positions[idx++] = y + (Math.random() - 0.5) * 0.02;
    positions[idx++] = z + (Math.random() - 0.5) * 0.02;
  }

  function fillSphere(cx: number, cy: number, cz: number, radius: number, n: number) {
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = radius * Math.cbrt(Math.random());
      addPoint(
        cx + r * Math.sin(phi) * Math.cos(theta),
        cy + r * Math.cos(phi),
        cz + r * Math.sin(phi) * Math.sin(theta),
      );
    }
  }

  function fillCylinder(cx: number, yBottom: number, yTop: number, radiusBottom: number, radiusTop: number, n: number) {
    for (let i = 0; i < n; i++) {
      const t = Math.random();
      const y = yBottom + t * (yTop - yBottom);
      const r = radiusBottom + t * (radiusTop - radiusBottom);
      const angle = Math.random() * Math.PI * 2;
      const rr = r * Math.sqrt(Math.random());
      addPoint(cx + rr * Math.cos(angle), y, rr * Math.sin(angle));
    }
  }

  function fillEllipsoid(cx: number, cy: number, cz: number, rx: number, ry: number, rz: number, n: number) {
    for (let i = 0; i < n; i++) {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = Math.cbrt(Math.random());
      addPoint(
        cx + rx * r * Math.sin(phi) * Math.cos(theta),
        cy + ry * r * Math.cos(phi),
        cz + rz * r * Math.sin(phi) * Math.sin(theta),
      );
    }
  }

  const baseY = -1.5;

  fillSphere(0, baseY + 2.75, 0, 0.16, Math.floor(count * 0.08));
  fillCylinder(0, baseY + 2.5, baseY + 2.6, 0.06, 0.07, Math.floor(count * 0.015));
  fillEllipsoid(0, baseY + 2.2, 0, 0.28, 0.18, 0.12, Math.floor(count * 0.12));
  fillEllipsoid(0, baseY + 1.95, 0, 0.24, 0.14, 0.11, Math.floor(count * 0.1));
  fillEllipsoid(0, baseY + 1.65, 0, 0.2, 0.14, 0.1, Math.floor(count * 0.08));
  fillEllipsoid(0, baseY + 1.4, 0, 0.22, 0.1, 0.11, Math.floor(count * 0.06));

  fillSphere(-0.32, baseY + 2.35, 0, 0.06, Math.floor(count * 0.02));
  fillSphere(0.32, baseY + 2.35, 0, 0.06, Math.floor(count * 0.02));

  fillCylinder(-0.35, baseY + 1.85, baseY + 2.3, 0.055, 0.06, Math.floor(count * 0.04));
  fillCylinder(-0.38, baseY + 1.4, baseY + 1.85, 0.04, 0.05, Math.floor(count * 0.035));
  fillEllipsoid(-0.4, baseY + 1.32, 0, 0.04, 0.06, 0.02, Math.floor(count * 0.015));

  fillCylinder(0.35, baseY + 1.85, baseY + 2.3, 0.055, 0.06, Math.floor(count * 0.04));
  fillCylinder(0.38, baseY + 1.4, baseY + 1.85, 0.04, 0.05, Math.floor(count * 0.035));
  fillEllipsoid(0.4, baseY + 1.32, 0, 0.04, 0.06, 0.02, Math.floor(count * 0.015));

  fillCylinder(-0.12, baseY + 0.75, baseY + 1.35, 0.07, 0.09, Math.floor(count * 0.06));
  fillCylinder(-0.13, baseY + 0.15, baseY + 0.75, 0.05, 0.065, Math.floor(count * 0.05));
  fillEllipsoid(-0.13, baseY + 0.08, 0.03, 0.05, 0.03, 0.08, Math.floor(count * 0.015));

  fillCylinder(0.12, baseY + 0.75, baseY + 1.35, 0.07, 0.09, Math.floor(count * 0.06));
  fillCylinder(0.13, baseY + 0.15, baseY + 0.75, 0.05, 0.065, Math.floor(count * 0.05));
  fillEllipsoid(0.13, baseY + 0.08, 0.03, 0.05, 0.03, 0.08, Math.floor(count * 0.015));

  while (idx < count * 3) {
    const region = Math.random();
    if (region < 0.3) {
      const y = baseY + 1.5 + Math.random() * 0.9;
      const angle = Math.random() * Math.PI * 2;
      const r = 0.2 + Math.random() * 0.06;
      addPoint(r * Math.cos(angle), y, r * Math.sin(angle) * 0.5);
    } else if (region < 0.5) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const y = baseY + 0.1 + Math.random() * 1.2;
      const angle = Math.random() * Math.PI * 2;
      const r = 0.06 + Math.random() * 0.03;
      addPoint(side * 0.12 + r * Math.cos(angle), y, r * Math.sin(angle));
    } else if (region < 0.7) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const y = baseY + 1.4 + Math.random() * 0.9;
      const angle = Math.random() * Math.PI * 2;
      const r = 0.04 + Math.random() * 0.02;
      addPoint(side * 0.36 + r * Math.cos(angle), y, r * Math.sin(angle));
    } else {
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      const r = 0.15 + Math.random() * 0.02;
      addPoint(r * Math.sin(phi) * Math.cos(theta), baseY + 2.75 + r * Math.cos(phi), r * Math.sin(phi) * Math.sin(theta));
    }
  }

  return positions;
}

function HumanFigure({ particleCount = 2200 }: { particleCount?: number }) {
  const groupRef = useRef<THREE.Group>(null);
  const pointsRef = useRef<THREE.Points>(null);
  const { pointer } = useThree();
  const count = particleCount;

  const basePositions = useMemo(() => generateHumanParticles(count), []);
  const currentPositions = useMemo(() => new Float32Array(basePositions), [basePositions]);

  // Orbit palette: lavender (head/upper), teal (torso), light cyan (mid), accent lavender (legs)
  const colors = useMemo(() => {
    const c = new Float32Array(count * 3);
    const lavender = new THREE.Color('#a78bfa');
    const teal = new THREE.Color('#22d3ee');
    const cyan = new THREE.Color('#06b6d4');
    const accent = new THREE.Color('#7c5cff');

    for (let i = 0; i < count; i++) {
      const y = basePositions[i * 3 + 1];
      let color: THREE.Color;
      if (y > 1.0) color = lavender;
      else if (y > 0.2) color = teal;
      else if (y > -0.5) color = cyan;
      else color = accent;
      const variation = 0.85 + Math.random() * 0.3;
      c[i * 3] = color.r * variation;
      c[i * 3 + 1] = color.g * variation;
      c[i * 3 + 2] = color.b * variation;
    }
    return c;
  }, [basePositions]);

  // Reusable Vector3 — avoid allocating per frame
  const mouseWorld = useMemo(() => new THREE.Vector3(), []);

  useFrame(({ clock }) => {
    if (!pointsRef.current || !groupRef.current) return;
    const elapsed = clock.getElapsedTime();
    const pos = pointsRef.current.geometry.attributes.position as THREE.BufferAttribute;
    mouseWorld.set(pointer.x * 2, pointer.y * 2, 0);

    for (let i = 0; i < count; i++) {
      const bx = basePositions[i * 3];
      const by = basePositions[i * 3 + 1];
      const bz = basePositions[i * 3 + 2];

      const breathe = Math.sin(elapsed * 0.8) * 0.008;
      const breatheY = by > -0.2 && by < 1.0 ? breathe : 0;
      const breatheX = by > 0 && by < 0.8 ? breathe * (bx > 0 ? 1 : -1) : 0;

      const float = Math.sin(elapsed * 0.3 + i * 0.01) * 0.003;

      const dx = bx - mouseWorld.x;
      const dy = by - mouseWorld.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      let pushX = 0, pushY = 0;
      if (dist < 0.4) {
        const force = (0.4 - dist) / 0.4 * 0.15;
        pushX = (dx / dist) * force;
        pushY = (dy / dist) * force;
      }

      const streamSpeed = 0.003;
      const streamPhase = Math.sin(elapsed * 0.5 + by * 3) * streamSpeed;

      pos.array[i * 3] = bx + breatheX + pushX;
      pos.array[i * 3 + 1] = by + breatheY + float + pushY + streamPhase;
      pos.array[i * 3 + 2] = bz;
    }
    pos.needsUpdate = true;

    groupRef.current.rotation.y = Math.sin(elapsed * 0.15) * 0.2;
  });

  return (
    <group ref={groupRef}>
      <points ref={pointsRef}>
        <bufferGeometry>
          <bufferAttribute attach="attributes-position" args={[currentPositions, 3]} />
          <bufferAttribute attach="attributes-color" args={[colors, 3]} />
        </bufferGeometry>
        <pointsMaterial size={0.012} vertexColors transparent opacity={0.85} sizeAttenuation />
      </points>
      <pointLight color="#7c5cff" intensity={0.8} distance={2} position={[0, 0.5, 0.2]} />
      <pointLight color="#22d3ee" intensity={0.3} distance={3} position={[0, 1.2, 0]} />
    </group>
  );
}

function BackgroundParticles() {
  const ref = useRef<THREE.Points>(null);
  const positions = useMemo(() => {
    const a = new Float32Array(200 * 3);
    for (let i = 0; i < 200; i++) {
      a[i * 3] = (Math.random() - 0.5) * 15;
      a[i * 3 + 1] = (Math.random() - 0.5) * 15;
      a[i * 3 + 2] = (Math.random() - 0.5) * 15;
    }
    return a;
  }, []);
  useFrame(({ clock }) => { if (ref.current) ref.current.rotation.y = clock.getElapsedTime() * 0.005; });
  return (
    <points ref={ref}>
      <bufferGeometry><bufferAttribute attach="attributes-position" args={[positions, 3]} /></bufferGeometry>
      <pointsMaterial color="#7c5cff" size={0.008} transparent opacity={0.12} sizeAttenuation />
    </points>
  );
}

interface SilhouetteProps {
  particleCount?: number;
  showAmbient?: boolean;
  /** When false, Canvas freezes — RAF loop pauses, no GPU/CPU work. Used to
   *  stop the render loop when home is not the active view (HomeView stays
   *  mounted for instant tab-switch but Three.js shouldn't burn frames in
   *  the background). */
  active?: boolean;
}

export default function HumanSilhouette({ particleCount, showAmbient = true, active = true }: SilhouetteProps = {}) {
  return (
    <div className="w-full h-full">
      <Canvas
        camera={{ position: [0, 0.3, 3], fov: 45 }}
        dpr={[1, 2]}
        frameloop={active ? 'always' : 'never'}
      >
        <ambientLight intensity={0.02} />
        <HumanFigure particleCount={particleCount} />
        {showAmbient && <BackgroundParticles />}
      </Canvas>
    </div>
  );
}
