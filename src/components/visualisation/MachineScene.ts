/**
 * Imperative three.js scene for the live machine view.
 *
 * World = WORK coordinates in millimetres, Z up (as on the machine).
 *   - grid on the work Z=0 plane, work origin axes (W0), machine origin marker (M0 = −WCO)
 *   - tool: cone whose tip sits at the live work position, with a drop line to Z=0
 *   - path: trail of recent tool positions
 *   - program: the loaded G-code toolpath (feeds / rapids), split into done / remaining by line index
 * Renders on demand only (camera change, position change, smoothing in progress).
 */
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import type { Toolpath } from '@/lib/gcode/toolpath';

export type ViewPreset = 'iso' | 'top' | 'front';

export interface ScenePosition {
  work: THREE.Vector3; // mm
  wco: THREE.Vector3; // mm, machine = work + wco
}

const COLORS = {
  background: 0x15171a,
  gridMinor: 0x1f2226,
  gridMajor: 0x2c3036,
  axis: 0x6b727b,
  ink2: 0xa1a7af,
  accent: 0x5ab8ff,
  accentDim: 0x2f6a94,
};

/** Toolpath colours (rgb + alpha): remaining feeds carry the accent; passed lines are greyed out. */
const PROGRAM_COLORS = {
  feed: [0x5a / 255, 0xb8 / 255, 0xff / 255, 1],
  feedDone: [0x5c / 255, 0x62 / 255, 0x6a / 255, 1],
  rapid: [0xa1 / 255, 0xa7 / 255, 0xaf / 255, 0.4],
  rapidDone: [0xa1 / 255, 0xa7 / 255, 0xaf / 255, 0.12],
} as const;

const PROGRAM_VERTEX = /* glsl */ `
  attribute float aLine;
  attribute float aKind;
  uniform float uDone;
  varying float vDone;
  varying float vKind;
  void main() {
    vDone = aLine < uDone ? 1.0 : 0.0;
    vKind = aKind;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const PROGRAM_FRAGMENT = /* glsl */ `
  uniform vec4 uFeed;
  uniform vec4 uFeedDone;
  uniform vec4 uRapid;
  uniform vec4 uRapidDone;
  uniform float uShowRapids;
  varying float vDone;
  varying float vKind;
  void main() {
    vec4 feed = mix(uFeed, uFeedDone, step(0.5, vDone));
    vec4 rapid = mix(uRapid, uRapidDone, step(0.5, vDone));
    vec4 color = mix(rapid, feed, step(0.5, vKind));
    if (vKind < 0.5 && uShowRapids < 0.5) discard;
    gl_FragColor = color;
  }
`;

/** Segments of one kind (0 rapid, 1 feed) with their line index attribute; null if there are none. */
function buildProgramGeometry(toolpath: Toolpath, kind: 0 | 1): THREE.BufferGeometry | null {
  let count = 0;
  for (let i = 0; i < toolpath.segmentCount; i++) if (toolpath.kinds[i] === kind) count++;
  if (count === 0) return null;
  const positions = new Float32Array(count * 6);
  const lineAttr = new Float32Array(count * 2);
  const kindAttr = new Float32Array(count * 2).fill(kind);
  let j = 0;
  for (let i = 0; i < toolpath.segmentCount; i++) {
    if (toolpath.kinds[i] !== kind) continue;
    positions.set(toolpath.positions.subarray(i * 6, i * 6 + 6), j * 6);
    lineAttr[j * 2] = lineAttr[j * 2 + 1] = toolpath.lines[i];
    j++;
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aLine', new THREE.BufferAttribute(lineAttr, 1));
  geometry.setAttribute('aKind', new THREE.BufferAttribute(kindAttr, 1));
  geometry.computeBoundingSphere();
  return geometry;
}

const GRID_SIZE = 600; // mm, centred on the work origin
const GRID_MINOR = 10;
const GRID_MAJOR = 50;
const MAX_TRAIL_POINTS = 20000;
const TRAIL_MIN_STEP = 0.02; // mm
const SMOOTHING_MS = 90; // time constant for following 4 Hz status updates

function makeLabel(text: string, className: string): CSS2DObject {
  const el = document.createElement('span');
  el.textContent = text;
  el.className = className;
  return new CSS2DObject(el);
}

function makeGrid(): THREE.LineSegments {
  const positions: number[] = [];
  const colors: number[] = [];
  const minor = new THREE.Color(COLORS.gridMinor);
  const major = new THREE.Color(COLORS.gridMajor);
  const half = GRID_SIZE / 2;
  for (let v = -half; v <= half; v += GRID_MINOR) {
    const c = v % GRID_MAJOR === 0 ? major : minor;
    positions.push(-half, v, 0, half, v, 0, v, -half, 0, v, half, 0);
    for (let i = 0; i < 4; i++) colors.push(c.r, c.g, c.b);
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ vertexColors: true }));
}

function makeAxes(length: number, color: number): THREE.LineSegments {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    'position',
    new THREE.Float32BufferAttribute([0, 0, 0, length, 0, 0, 0, 0, 0, 0, length, 0, 0, 0, 0, 0, 0, length], 3),
  );
  return new THREE.LineSegments(geometry, new THREE.LineBasicMaterial({ color }));
}

function makeTool(): THREE.Group {
  const group = new THREE.Group();
  const material = new THREE.MeshStandardMaterial({ color: COLORS.accent, roughness: 0.45, metalness: 0.1 });
  const tipHeight = 14;
  const cone = new THREE.ConeGeometry(4, tipHeight, 32);
  cone.rotateX(-Math.PI / 2); // apex towards −Z
  cone.translate(0, 0, tipHeight / 2); // apex at the origin
  group.add(new THREE.Mesh(cone, material));
  const shank = new THREE.CylinderGeometry(4, 4, 26, 32);
  shank.rotateX(Math.PI / 2);
  shank.translate(0, 0, tipHeight + 13);
  group.add(new THREE.Mesh(shank, new THREE.MeshStandardMaterial({ color: 0x3a4048, roughness: 0.6 })));
  return group;
}

export class MachineScene {
  private renderer: THREE.WebGLRenderer;
  private labelRenderer: CSS2DRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.PerspectiveCamera;
  private controls: OrbitControls;
  private resizeObserver: ResizeObserver;

  private tool = makeTool();
  private dropLine: THREE.Line;
  private footprint: THREE.Mesh;
  private machineOrigin = new THREE.Group();
  private trailGeometry = new THREE.BufferGeometry();
  private trailPositions = new Float32Array(MAX_TRAIL_POINTS * 3);
  private trailCount = 0;
  private lastTrailPoint: THREE.Vector3 | null = null;

  private program = new THREE.Group();
  private programBounds: THREE.Box3 | null = null;
  private programUniforms = {
    uDone: { value: -1 },
    uShowRapids: { value: 1 },
    uFeed: { value: new THREE.Vector4(...PROGRAM_COLORS.feed) },
    uFeedDone: { value: new THREE.Vector4(...PROGRAM_COLORS.feedDone) },
    uRapid: { value: new THREE.Vector4(...PROGRAM_COLORS.rapid) },
    uRapidDone: { value: new THREE.Vector4(...PROGRAM_COLORS.rapidDone) },
  };

  private target: THREE.Vector3 | null = null;
  private displayed: THREE.Vector3 | null = null;
  private follow = false;
  private reducedMotion = false;
  private frame = 0;
  private lastFrameTime = 0;
  private disposed = false;
  private programVisible = true;

  constructor(private container: HTMLElement) {
    const { clientWidth: w, clientHeight: h } = container;

    this.renderer = new THREE.WebGLRenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setSize(w, h);
    this.renderer.setClearColor(COLORS.background);
    this.renderer.domElement.style.display = 'block';
    container.appendChild(this.renderer.domElement);

    this.labelRenderer = new CSS2DRenderer();
    this.labelRenderer.setSize(w, h);
    Object.assign(this.labelRenderer.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' });
    container.appendChild(this.labelRenderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, w / Math.max(h, 1), 1, 20000);
    this.camera.up.set(0, 0, 1);

    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = false;
    this.controls.screenSpacePanning = true;
    this.controls.addEventListener('change', () => this.requestRender());

    // Lights
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x20242a, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.4);
    sun.position.set(200, -300, 500);
    this.scene.add(sun);

    // Grid + work origin
    this.scene.add(makeGrid());
    this.scene.add(makeAxes(60, COLORS.ink2));
    const labelCls = 'kq-label';
    for (const [text, pos] of [
      ['X', [68, 0, 0]],
      ['Y', [0, 68, 0]],
      ['Z', [0, 0, 68]],
    ] as const) {
      const label = makeLabel(text, labelCls);
      label.position.set(pos[0], pos[1], pos[2]);
      this.scene.add(label);
    }
    const w0 = makeLabel('W0', `${labelCls} kq-label--muted`);
    w0.position.set(-6, -6, 0);
    this.scene.add(w0);

    // Machine origin marker (positioned at −WCO when known)
    this.machineOrigin.add(makeAxes(20, COLORS.axis));
    const m0 = makeLabel('M0', `${labelCls} kq-label--muted`);
    m0.position.set(-6, -6, 0);
    this.machineOrigin.add(m0);
    this.machineOrigin.visible = false;
    this.scene.add(this.machineOrigin);

    // Trail
    this.trailGeometry.setAttribute('position', new THREE.BufferAttribute(this.trailPositions, 3));
    this.trailGeometry.setDrawRange(0, 0);
    const trail = new THREE.Line(
      this.trailGeometry,
      new THREE.LineBasicMaterial({ color: COLORS.accentDim }),
    );
    trail.frustumCulled = false;
    this.scene.add(trail);

    // Tool + drop line + footprint on Z=0
    this.tool.visible = false;
    this.scene.add(this.tool);
    const dropGeometry = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(), new THREE.Vector3()]);
    this.dropLine = new THREE.Line(
      dropGeometry,
      new THREE.LineDashedMaterial({ color: COLORS.accent, dashSize: 3, gapSize: 3, transparent: true, opacity: 0.6 }),
    );
    this.dropLine.visible = false;
    this.scene.add(this.dropLine);
    this.footprint = new THREE.Mesh(
      new THREE.RingGeometry(3, 4.2, 40),
      new THREE.MeshBasicMaterial({ color: COLORS.accent, transparent: true, opacity: 0.7, side: THREE.DoubleSide }),
    );
    this.footprint.visible = false;
    this.scene.add(this.footprint);

    this.setView('iso');

    this.resizeObserver = new ResizeObserver(() => this.resize());
    this.resizeObserver.observe(container);
  }

  setReducedMotion(value: boolean): void {
    this.reducedMotion = value;
  }

  setFollow(value: boolean): void {
    this.follow = value;
    if (value && this.displayed) {
      this.moveTargetTo(this.displayed);
    }
  }

  /** Update from controller state; null hides the tool (not connected / no status yet). */
  setPosition(position: ScenePosition | null): void {
    if (!position) {
      this.target = null;
      this.displayed = null;
      this.tool.visible = this.dropLine.visible = this.footprint.visible = false;
      this.machineOrigin.visible = false;
      this.requestRender();
      return;
    }

    this.machineOrigin.position.copy(position.wco).multiplyScalar(-1);
    this.machineOrigin.visible = true;

    const first = this.target === null;
    this.target = position.work.clone();
    if (first || !this.displayed || this.reducedMotion) {
      this.displayed = position.work.clone();
      this.applyDisplayed();
      if (first) this.fit();
    }
    this.requestRender();
  }

  clearTrail(): void {
    this.trailCount = 0;
    this.lastTrailPoint = null;
    this.trailGeometry.setDrawRange(0, 0);
    this.requestRender();
  }

  /** Show a parsed program (work coordinates, mm); null removes it. Frames the program when shown. */
  setToolpath(toolpath: Toolpath | null): void {
    this.scene.remove(this.program);
    for (const child of [...this.program.children] as THREE.LineSegments[]) {
      this.program.remove(child);
      child.geometry.dispose();
      (child.material as THREE.Material).dispose();
    }
    this.programBounds = null;

    if (toolpath && toolpath.segmentCount > 0) {
      // Feeds are opaque and depth-tested, so an upper (passed, grey) layer hides the deeper passes
      // below it; rapids are translucent and drawn after them without writing depth.
      for (const kind of [1, 0] as const) {
        const geometry = buildProgramGeometry(toolpath, kind);
        if (!geometry) continue;
        const material = new THREE.ShaderMaterial({
          vertexShader: PROGRAM_VERTEX,
          fragmentShader: PROGRAM_FRAGMENT,
          uniforms: this.programUniforms,
          transparent: kind === 0,
          depthWrite: kind === 1,
        });
        const lines = new THREE.LineSegments(geometry, material);
        lines.renderOrder = kind === 1 ? 1 : 2;
        this.program.add(lines);
      }
      this.program.visible = this.programVisible;
      this.scene.add(this.program);
      const b = toolpath.bounds;
      if (b) this.programBounds = new THREE.Box3(new THREE.Vector3(...b.min), new THREE.Vector3(...b.max));
      this.fit();
    }
    this.requestRender();
  }

  /** Lines acknowledged so far (`sender.received`); null while no job runs (whole program shown as remaining). */
  setProgramProgress(done: number | null): void {
    const value = done ?? -1;
    if (this.programUniforms.uDone.value === value) return;
    this.programUniforms.uDone.value = value;
    this.requestRender();
  }

  setProgramVisible(visible: boolean): void {
    this.program.visible = visible;
    this.programVisible = visible;
    this.requestRender();
  }

  setShowRapids(show: boolean): void {
    this.programUniforms.uShowRapids.value = show ? 1 : 0;
    this.requestRender();
  }

  setView(preset: ViewPreset): void {
    const focus = this.controls.target.clone();
    const distance = Math.max(this.camera.position.distanceTo(focus), 400);
    const dir =
      preset === 'top'
        ? new THREE.Vector3(0, -0.0001, 1)
        : preset === 'front'
          ? new THREE.Vector3(0, -1, 0.0001)
          : new THREE.Vector3(1, -1.25, 0.9);
    this.camera.position.copy(focus).add(dir.normalize().multiplyScalar(distance));
    this.camera.lookAt(focus);
    this.controls.update();
    this.requestRender();
  }

  /** Frame the work origin, the tool, the recorded path and the loaded program. */
  fit(): void {
    const box = new THREE.Box3().setFromPoints([new THREE.Vector3(0, 0, 0)]);
    if (this.displayed) box.expandByPoint(this.displayed);
    if (this.programBounds && this.programVisible) box.union(this.programBounds);
    for (let i = 0; i < this.trailCount; i++) {
      box.expandByPoint(
        new THREE.Vector3(this.trailPositions[i * 3], this.trailPositions[i * 3 + 1], this.trailPositions[i * 3 + 2]),
      );
    }
    const center = box.getCenter(new THREE.Vector3());
    const size = Math.max(box.getSize(new THREE.Vector3()).length(), 60);
    const distance = size / (2 * Math.tan((this.camera.fov * Math.PI) / 360)) * 1.1;
    const dir = this.camera.position.clone().sub(this.controls.target).normalize();
    this.controls.target.copy(center);
    this.camera.position.copy(center).add(dir.multiplyScalar(distance));
    this.controls.update();
    this.requestRender();
  }

  dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.frame);
    this.resizeObserver.disconnect();
    this.controls.dispose();
    this.scene.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const material = mesh.material as THREE.Material | THREE.Material[] | undefined;
      if (Array.isArray(material)) material.forEach((m) => m.dispose());
      else material?.dispose?.();
    });
    this.renderer.dispose();
    this.renderer.domElement.remove();
    this.labelRenderer.domElement.remove();
  }

  // --- internals -------------------------------------------------------------

  private moveTargetTo(point: THREE.Vector3): void {
    const offset = this.camera.position.clone().sub(this.controls.target);
    this.controls.target.copy(point);
    this.camera.position.copy(point).add(offset);
    this.controls.update();
  }

  private applyDisplayed(): void {
    if (!this.displayed) return;
    const p = this.displayed;
    this.tool.position.copy(p);
    this.tool.visible = true;

    const dropPositions = this.dropLine.geometry.getAttribute('position') as THREE.BufferAttribute;
    dropPositions.setXYZ(0, p.x, p.y, p.z);
    dropPositions.setXYZ(1, p.x, p.y, 0);
    dropPositions.needsUpdate = true;
    this.dropLine.computeLineDistances();
    this.dropLine.visible = Math.abs(p.z) > 0.5;
    this.footprint.position.set(p.x, p.y, 0.01);
    this.footprint.visible = true;

    if (!this.lastTrailPoint || this.lastTrailPoint.distanceTo(p) >= TRAIL_MIN_STEP) {
      if (this.trailCount >= MAX_TRAIL_POINTS) {
        // Drop the oldest half to keep memory bounded.
        const keep = MAX_TRAIL_POINTS / 2;
        this.trailPositions.copyWithin(0, (this.trailCount - keep) * 3, this.trailCount * 3);
        this.trailCount = keep;
      }
      this.trailPositions.set([p.x, p.y, p.z], this.trailCount * 3);
      this.trailCount++;
      this.lastTrailPoint = p.clone();
      (this.trailGeometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
      this.trailGeometry.setDrawRange(0, this.trailCount);
    }

    if (this.follow) this.moveTargetTo(p);
  }

  private resize(): void {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.requestRender();
  }

  private requestRender(): void {
    if (this.disposed || this.frame) return;
    this.frame = requestAnimationFrame((time) => this.tick(time));
  }

  private tick(time: number): void {
    this.frame = 0;
    const dt = this.lastFrameTime ? Math.min(time - this.lastFrameTime, 100) : 16;
    this.lastFrameTime = time;

    let animating = false;
    if (this.target && this.displayed && !this.displayed.equals(this.target)) {
      const k = this.reducedMotion ? 1 : 1 - Math.exp(-dt / SMOOTHING_MS);
      this.displayed.lerp(this.target, k);
      if (this.displayed.distanceTo(this.target) < 0.001) this.displayed.copy(this.target);
      this.applyDisplayed();
      animating = !this.displayed.equals(this.target);
    }

    this.renderer.render(this.scene, this.camera);
    this.labelRenderer.render(this.scene, this.camera);

    if (animating) this.requestRender();
    else this.lastFrameTime = 0;
  }
}
