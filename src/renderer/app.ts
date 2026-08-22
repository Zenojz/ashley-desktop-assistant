import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/examples/jsm/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { modelConfig } from './model-config';

type JarvisState = 'idle' | 'listening' | 'thinking' | 'speaking';
type JarvisGesture =
  | 'turn'
  | 'nod'
  | 'shake'
  | 'spin'
  | 'spin-clockwise'
  | 'spin-counterclockwise'
  | 'face-front'
  | 'face-back'
  | 'face-left'
  | 'face-right';
type ScreenAnchor = { x: number; y: number; width: number; height: number };
type GestureKeyframe = { at: number; pitch: number; yaw: number };
type GestureAnimation = {
  startedAt: number;
  keyframes: GestureKeyframe[];
  source: 'speech' | 'command';
};

const stageElement = document.querySelector<HTMLElement>('.stage');

if (!stageElement) throw new Error('Jarvis stage is missing');

const stage = stageElement;
const isEffectsLayer = document.body.dataset.mode === 'effects';
const queryParameters = new URLSearchParams(window.location.search);
const isVisualQa = queryParameters.get('qa') === '1';
const qaLighting = queryParameters.get('lighting');
const helmetModelFile = modelConfig.helmetModelFile;
stage.style.opacity = '0';

const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
renderer.setClearColor(isVisualQa ? 0xf2f2f2 : 0x000000, isVisualQa ? 1 : 0);
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1;
stage.append(renderer.domElement);

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 1000);
const pmremGenerator = new THREE.PMREMGenerator(renderer);
const roomEnvironment = new RoomEnvironment();
const mirroredRoomEnvironment = roomEnvironment.clone();
mirroredRoomEnvironment.scale.x = -1;
const symmetricRoomEnvironment = new THREE.Scene();
symmetricRoomEnvironment.add(roomEnvironment, mirroredRoomEnvironment);
scene.environment = qaLighting === 'direct'
  ? null
  : pmremGenerator.fromScene(symmetricRoomEnvironment).texture;
scene.environmentIntensity = qaLighting === 'direct' ? 0 : 0.28;
pmremGenerator.dispose();
roomEnvironment.dispose();

const ambientLight = new THREE.AmbientLight(0xffffff, 0.06);
scene.add(ambientLight);

const directionalLights: THREE.DirectionalLight[] = [];
const emissiveMaterials: THREE.MeshStandardMaterial[] = [];
const emissiveIntensityScales = new Map<THREE.MeshStandardMaterial, number>();
const eyeGlowMeshes: THREE.Mesh[] = [];
const openSourceEyeUniforms = {
  uBoundsMin: { value: new THREE.Vector3() },
  uBoundsSize: { value: new THREE.Vector3(1, 1, 1) },
  uIntensity: { value: 0.6 }
};
const assemblyUniforms = {
  uProgress: { value: 1 },
  uSpread: { value: 0 },
  uCutY: { value: 0 },
  uCutCenterX: { value: 0 },
  uCutHalfWidth: { value: 1 },
  uCutCenterDrop: { value: 0 },
  uCutFlatFraction: { value: 0 },
  uCutSpaceMatrix: { value: new THREE.Matrix4() },
  uFadeHeight: { value: 0 }
};
const particleUniforms = {
  uProgress: assemblyUniforms.uProgress
};
let helmet: THREE.Object3D | null = null;
let helmetPivot: THREE.Group | null = null;
let headBounds: THREE.Box3 | null = null;
let cameraFramingBounds: THREE.Box3 | null = null;
let activeState: JarvisState = 'idle';
let targetLevel = 0;
let currentLevel = 0;
let targetEmissiveIntensity = 0.6;
let currentEmissiveIntensity = 0.6;
let targetBloomStrength = 0.5;
let currentBloomStrength = 0.5;
let targetRotationY = modelConfig.rotationY;
let currentRotationY = modelConfig.rotationY;
let targetRotationX = modelConfig.rotationX;
let currentRotationX = modelConfig.rotationX;
let restingRotationY = modelConfig.rotationY;
let gestureAnimation: GestureAnimation | null = null;
let nextSpeakingMotionAt = 0;
let lastSpeakingYawDirection = Math.random() < 0.5 ? -1 : 1;
// The native window starts hidden. Rendering while invisible used to keep a
// full-screen transparent WebGL surface active forever and could burden the
// desktop compositor after long idle periods.
let isVisible = isVisualQa;
let animationFrame: number | null = null;
let lastRenderAt = 0;
let assemblyStartedAt: number | null = null;
let flashStartedAt: number | null = null;
let assemblyParticles: THREE.Points | null = null;
let effectsAnchor: ScreenAnchor | null = null;
let assemblyRevealPending = false;

function addDirectionalLight(intensity: number) {
  const light = new THREE.DirectionalLight(0xeaf6ff, intensity);
  scene.add(light, light.target);
  directionalLights.push(light);
}

function setLights(distance: number, target: THREE.Vector3) {
  const keyAngle = THREE.MathUtils.degToRad(30);
  if (directionalLights.length === 0) {
    const intensities = qaLighting === 'environment'
      ? [0, 0, 0, 0, 0]
      : [0.72, 0.72, 0.25, 0.35, 0.35];
    for (const intensity of intensities) addDirectionalLight(intensity);
  }

  directionalLights[0].position.set(
    target.x - Math.sin(keyAngle) * distance,
    target.y + Math.cos(keyAngle) * distance,
    target.z + distance
  );
  directionalLights[1].position.set(
    target.x + Math.sin(keyAngle) * distance,
    target.y + Math.cos(keyAngle) * distance,
    target.z + distance
  );
  directionalLights[2].position.set(target.x, target.y + distance, target.z + distance * 0.8);
  directionalLights[3].position.set(target.x - distance, target.y, target.z - distance);
  directionalLights[4].position.set(target.x + distance, target.y, target.z - distance);
  for (const light of directionalLights) light.target.position.copy(target);
}

function isEmissiveMaterial(material: THREE.Material): material is THREE.MeshStandardMaterial {
  return material instanceof THREE.MeshStandardMaterial;
}

function configureOpenSourceBrushedMetal(root: THREE.Object3D) {
  const configuredMaterials = new Set<THREE.MeshStandardMaterial>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (
        !(material instanceof THREE.MeshStandardMaterial)
        || !material.name.startsWith('OpenSourceGunmetal')
        || configuredMaterials.has(material)
      ) {
        continue;
      }
      configuredMaterials.add(material);
      const previousOnBeforeCompile = material.onBeforeCompile;
      const previousProgramCacheKey = material.customProgramCacheKey;
      material.onBeforeCompile = (shader, renderer) => {
        previousOnBeforeCompile(shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <roughnessmap_fragment>',
          `
            #include <roughnessmap_fragment>
            float jarvisBrushFine = sin(vWorldY * 920.0 + vWorldX * 13.0);
            float jarvisBrushCoarse = sin(vWorldY * 215.0 - vWorldX * 7.0);
            roughnessFactor = clamp(
              roughnessFactor + jarvisBrushFine * 0.026 + jarvisBrushCoarse * 0.014,
              0.16,
              0.62
            );
          `
        );
      };
      material.customProgramCacheKey = () => (
        `${previousProgramCacheKey.call(material)}|jarvis-opensource-brushed-v1`
      );
      material.needsUpdate = true;
    }
  });
}

function configureOpenSourceCyberMaterials(root: THREE.Object3D) {
  const configuredMaterials = new Set<THREE.MeshStandardMaterial>();
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (
        !(material instanceof THREE.MeshStandardMaterial)
        || !material.name.startsWith('OpenSourceCyber')
        || configuredMaterials.has(material)
      ) {
        continue;
      }
      configuredMaterials.add(material);
      const previousOnBeforeCompile = material.onBeforeCompile;
      const previousProgramCacheKey = material.customProgramCacheKey;
      material.onBeforeCompile = (shader, renderer) => {
        previousOnBeforeCompile(shader, renderer);
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <roughnessmap_fragment>',
          `
            #include <roughnessmap_fragment>
            float jarvisCyberWave = 0.5 + 0.5 * sin(vWorldY * 37.0 + vWorldX * 15.0);
            float jarvisCyberFine = 0.5 + 0.5 * sin(vWorldY * 121.0 - vWorldX * 31.0);
            roughnessFactor = clamp(
              roughnessFactor + (jarvisCyberWave - 0.5) * 0.12 + (jarvisCyberFine - 0.5) * 0.035,
              0.12,
              0.52
            );
          `
        );
        shader.fragmentShader = shader.fragmentShader.replace(
          '#include <emissivemap_fragment>',
          `
            #include <emissivemap_fragment>
            float jarvisCyberGradient = clamp(
              0.58 + jarvisCyberWave * 0.24 + jarvisCyberFine * 0.12,
              0.48,
              0.94
            );
            totalEmissiveRadiance *= jarvisCyberGradient;
          `
        );
      };
      material.customProgramCacheKey = () => (
        `${previousProgramCacheKey.call(material)}|jarvis-opensource-cyber-v2`
      );
      material.needsUpdate = true;
    }
  });
}

function prepareOpenSourceEyeCarrier(root: THREE.Object3D) {
  if (helmetModelFile !== 'model.glb') return;
  const eyeCarrier = root.getObjectByName('Object_7');
  if (!(eyeCarrier instanceof THREE.Mesh)) return;
  const sourceMaterial = Array.isArray(eyeCarrier.material)
    ? eyeCarrier.material[0]
    : eyeCarrier.material;
  if (!(sourceMaterial instanceof THREE.MeshStandardMaterial)) return;
  const material = sourceMaterial.clone();
  material.name = 'OpenSourceGunmetalEyeCarrier';
  eyeCarrier.material = material;
}

function configureOpenSourceEyeSurface(root: THREE.Object3D) {
  if (helmetModelFile !== 'model.glb' || !headBounds) return;
  const eyeCarrier = root.getObjectByName('Object_7');
  if (!(eyeCarrier instanceof THREE.Mesh)) return;
  const material = Array.isArray(eyeCarrier.material)
    ? eyeCarrier.material[0]
    : eyeCarrier.material;
  if (!(material instanceof THREE.MeshStandardMaterial)) return;

  const centeredBoundsOrigin = headBounds.getCenter(new THREE.Vector3());
  openSourceEyeUniforms.uBoundsMin.value
    .copy(headBounds.min)
    .sub(centeredBoundsOrigin);
  headBounds.getSize(openSourceEyeUniforms.uBoundsSize.value);
  const previousOnBeforeCompile = material.onBeforeCompile;
  const previousProgramCacheKey = material.customProgramCacheKey;
  material.onBeforeCompile = (shader, renderer) => {
    previousOnBeforeCompile(shader, renderer);
    shader.uniforms.uJarvisEyeBoundsMin = openSourceEyeUniforms.uBoundsMin;
    shader.uniforms.uJarvisEyeBoundsSize = openSourceEyeUniforms.uBoundsSize;
    shader.uniforms.uJarvisEyeIntensity = openSourceEyeUniforms.uIntensity;
    shader.fragmentShader = `
      uniform vec3 uJarvisEyeBoundsMin;
      uniform vec3 uJarvisEyeBoundsSize;
      uniform float uJarvisEyeIntensity;
    ${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <emissivemap_fragment>',
      `
        #include <emissivemap_fragment>
        vec3 jarvisEyePosition = (
          vec3(vWorldX, vWorldY, vWorldZ) - uJarvisEyeBoundsMin
        ) / max(uJarvisEyeBoundsSize, vec3(0.0001));
        float jarvisEyeX = abs((jarvisEyePosition.x - 0.5) * 2.0);
        float jarvisEyeLower = 0.425 + jarvisEyeX * 0.09;
        float jarvisEyeUpper = 0.5 + jarvisEyeX * 0.085;
        float jarvisEyeFeather = max(fwidth(jarvisEyePosition.y) * 2.2, 0.006);
        float jarvisEyeHorizontal =
          smoothstep(0.08, 0.08 + jarvisEyeFeather, jarvisEyeX) *
          (1.0 - smoothstep(0.68 - jarvisEyeFeather, 0.68, jarvisEyeX));
        float jarvisEyeVertical =
          smoothstep(jarvisEyeLower, jarvisEyeLower + jarvisEyeFeather, jarvisEyePosition.y) *
          (1.0 - smoothstep(jarvisEyeUpper - jarvisEyeFeather, jarvisEyeUpper, jarvisEyePosition.y));
        float jarvisEyeMask = jarvisEyeHorizontal * jarvisEyeVertical;
        float jarvisEyeCore = 1.0 - smoothstep(
          0.0,
          0.5,
          abs(jarvisEyePosition.y - (jarvisEyeLower + jarvisEyeUpper) * 0.5)
          / max(jarvisEyeUpper - jarvisEyeLower, 0.001)
        );
        vec3 jarvisEyeColor = mix(
          vec3(0.008, 0.16, 0.17),
          vec3(0.04, 0.86, 0.9),
          jarvisEyeCore
        );
        jarvisEyeColor = mix(
          jarvisEyeColor,
          vec3(0.5, 1.0, 1.0),
          pow(jarvisEyeCore, 3.0) * 0.42
        );
        totalEmissiveRadiance += jarvisEyeColor
          * jarvisEyeMask
          * uJarvisEyeIntensity
          * (1.48 + jarvisEyeCore * 1.08);
      `
    );
  };
  material.customProgramCacheKey = () => (
    `${previousProgramCacheKey.call(material)}|jarvis-opensource-eye-surface-v1`
  );
  material.needsUpdate = true;
}

function collectEmissiveMaterials(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;

    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const triangles = object.geometry.index
      ? object.geometry.index.count / 3
      : object.geometry.attributes.position.count / 3;
    for (const material of materials) {
      const materialName = material.name || '(unnamed)';
      if (materialName === modelConfig.faceplateMaterial && material instanceof THREE.MeshStandardMaterial) {
        material.metalness = modelConfig.faceplateMetalness;
        material.roughness = modelConfig.faceplateRoughness;
        if (material instanceof THREE.MeshPhysicalMaterial) {
          material.clearcoatRoughness = modelConfig.faceplateClearcoatRoughness;
        }
      }
      const supportsEmissive = isEmissiveMaterial(material);
      const intrinsicEmission = supportsEmissive && (Boolean(material.emissiveMap) || material.emissiveIntensity > 0);
      const isBlackWithoutMap = supportsEmissive && material.emissive.getHex() === 0x000000 && !material.emissiveMap;
      const isWhitelisted = modelConfig.emissiveMaterialNames.includes(materialName) && !isBlackWithoutMap;
      const emissiveHex = supportsEmissive ? `0x${material.emissive.getHexString()}` : 'n/a';
      const emissiveIntensity = supportsEmissive ? material.emissiveIntensity : 'n/a';
      const hasEmissiveMap = supportsEmissive && Boolean(material.emissiveMap);

      console.log(
        `[Jarvis] material "${materialName}" mesh="${object.name || '(unnamed)'}" triangles=${triangles} ` +
          `emissive=${emissiveHex} emissiveIntensity=${emissiveIntensity} emissiveMap=${hasEmissiveMap} ` +
          `intrinsicEmission=${intrinsicEmission} blackWithoutMap=${isBlackWithoutMap} whitelisted=${isWhitelisted}`
      );

      if (!isWhitelisted || !supportsEmissive) continue;
      const isPrimaryEmissive = materialName === modelConfig.primaryEmissiveMaterial;
      const isOpenSourcePink = materialName === 'OpenSourceCyberPinkDetails';
      const isOpenSourceCyan = materialName === 'OpenSourceCyberCyanDetails';
      material.emissive.setHex(
        isPrimaryEmissive
          ? modelConfig.eyeCoreColor
          : isOpenSourcePink
              ? 0x6b0527
              : isOpenSourceCyan
                ? 0x007a73
                : modelConfig.emissiveColor
      );
      if (isPrimaryEmissive) {
        material.color.setHex(modelConfig.eyeCoreColor);
        material.metalness = 0;
        material.roughness = 0.2;
        material.toneMapped = false;
        material.needsUpdate = true;
      }
      if (!emissiveMaterials.includes(material)) {
        emissiveMaterials.push(material);
        emissiveIntensityScales.set(
          material,
          isPrimaryEmissive
            ? modelConfig.primaryEmissiveMultiplier
            : isOpenSourcePink
                ? 0.34
                : isOpenSourceCyan
                  ? 0.44
                  : 1
        );
      }
    }
  });
}

function createExpandedEyeGeometry(sourceGeometry: THREE.BufferGeometry, expansion: number) {
  const geometry = sourceGeometry.clone();
  const positions = geometry.getAttribute('position');
  geometry.computeBoundingBox();
  const bounds = geometry.boundingBox;
  if (!bounds) return geometry;

  const centerX = (bounds.min.x + bounds.max.x) / 2;
  const leftBounds = new THREE.Box3();
  const rightBounds = new THREE.Box3();
  const point = new THREE.Vector3();
  const index = geometry.getIndex();
  const usedVertices = index
    ? new Set(Array.from(index.array as ArrayLike<number>))
    : new Set(Array.from({ length: positions.count }, (_, vertex) => vertex));

  for (const vertex of usedVertices) {
    point.fromBufferAttribute(positions, vertex);
    (point.x < centerX ? leftBounds : rightBounds).expandByPoint(point);
  }

  const leftCenter = leftBounds.getCenter(new THREE.Vector3());
  const rightCenter = rightBounds.getCenter(new THREE.Vector3());
  for (const vertex of usedVertices) {
    point.fromBufferAttribute(positions, vertex);
    const eyeCenter = point.x < centerX ? leftCenter : rightCenter;
    point.sub(eyeCenter).multiplyScalar(1 + expansion).add(eyeCenter);
    positions.setXYZ(vertex, point.x, point.y, point.z);
  }

  positions.needsUpdate = true;
  return geometry;
}

function createEyeGlowLayers(root: THREE.Object3D) {
  root.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    const isLegacyEye = materials.some(
      (material) => material.name === modelConfig.primaryEmissiveMaterial
    );
    if (!isLegacyEye) return;
    const glowLayers = [
      { expansion: 0.05, opacity: 0.38 },
      { expansion: 0.12, opacity: 0.18 },
      { expansion: 0.22, opacity: 0.08 }
    ];

    for (const layer of glowLayers) {
      const material = new THREE.MeshBasicMaterial({
        color: modelConfig.eyeGlowColor,
        transparent: true,
        opacity: layer.opacity,
        blending: THREE.AdditiveBlending,
        depthTest: false,
        depthWrite: false,
        toneMapped: false
      });
      const glow = new THREE.Mesh(createExpandedEyeGeometry(object.geometry, layer.expansion), material);
      glow.renderOrder = 10;
      object.add(glow);
      eyeGlowMeshes.push(glow);
    }
  });
}

type ChinCutProfile = {
  baseY: number;
  centerX: number;
  halfWidth: number;
  centerDrop: number;
  flatFraction: number;
};

type PretrimmedHelmetMetadata = {
  scale: [number, number, number];
  cutProfile: ChinCutProfile;
  framingBounds: { min: [number, number, number]; max: [number, number, number] };
  triangles: number;
};

function smoothStep(value: number) {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  return clamped * clamped * (3 - 2 * clamped);
}

function getChinCutY(x: number, profile: ChinCutProfile) {
  const normalizedX = Math.abs(x - profile.centerX) / Math.max(profile.halfWidth, 0.0001);
  const slopeProgress = smoothStep(
    (normalizedX - profile.flatFraction) / Math.max(1 - profile.flatFraction, 0.0001)
  );
  return profile.baseY - profile.centerDrop * (1 - slopeProgress);
}

function getBoundsAboveY(model: THREE.Object3D, minimumY: number) {
  const bounds = new THREE.Box3();
  const vertex = new THREE.Vector3();
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    for (let index = 0; index < positions.count; index += 1) {
      vertex.fromBufferAttribute(positions, index).applyMatrix4(object.matrixWorld);
      if (vertex.y >= minimumY) bounds.expandByPoint(vertex);
    }
  });
  return bounds;
}

function trimGeometryAboveCut(
  geometry: THREE.BufferGeometry,
  matrixWorld: THREE.Matrix4,
  cutProfile: ChinCutProfile
) {
  const source = geometry.toNonIndexed();
  const positions = source.getAttribute('position');
  const retainedVertices: number[] = [];
  const retainedMaterialIndices: number[] = [];
  const vertex = new THREE.Vector3();
  const triangleVertices = [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()];
  const centroid = new THREE.Vector3();
  const framingBounds = new THREE.Box3();

  for (let index = 0; index < positions.count; index += 3) {
    let allBelowCut = true;
    centroid.set(0, 0, 0);
    for (let offset = 0; offset < 3; offset += 1) {
      vertex.fromBufferAttribute(positions, index + offset).applyMatrix4(matrixWorld);
      triangleVertices[offset].copy(vertex);
      centroid.add(vertex);
      if (vertex.y >= getChinCutY(vertex.x, cutProfile)) {
        allBelowCut = false;
        framingBounds.expandByPoint(vertex);
      }
    }
    centroid.multiplyScalar(1 / 3);
    if (allBelowCut) continue;

    retainedVertices.push(index, index + 1, index + 2);
    const group = source.groups.find((item) => index >= item.start && index < item.start + item.count);
    retainedMaterialIndices.push(group?.materialIndex ?? 0);
  }

  const trimmed = new THREE.BufferGeometry();
  for (const [name, attribute] of Object.entries(source.attributes)) {
    const ArrayType = attribute.array.constructor as new (length: number) => typeof attribute.array;
    const values = new ArrayType(retainedVertices.length * attribute.itemSize);
    retainedVertices.forEach((sourceIndex, targetIndex) => {
      const sourceOffset = sourceIndex * attribute.itemSize;
      const targetOffset = targetIndex * attribute.itemSize;
      values.set(attribute.array.subarray(sourceOffset, sourceOffset + attribute.itemSize), targetOffset);
    });
    trimmed.setAttribute(name, new THREE.BufferAttribute(values, attribute.itemSize, attribute.normalized));
  }

  let groupStart = 0;
  let activeMaterialIndex: number | null = null;
  retainedMaterialIndices.forEach((materialIndex, triangleIndex) => {
    if (activeMaterialIndex === materialIndex) return;
    if (activeMaterialIndex !== null) trimmed.addGroup(groupStart, triangleIndex * 3 - groupStart, activeMaterialIndex);
    groupStart = triangleIndex * 3;
    activeMaterialIndex = materialIndex;
  });
  if (activeMaterialIndex !== null) {
    trimmed.addGroup(groupStart, retainedMaterialIndices.length * 3 - groupStart, activeMaterialIndex);
  }

  source.dispose();
  return { geometry: trimmed, before: positions.count / 3, after: retainedVertices.length / 3, framingBounds };
}

function trimModelGeometry(model: THREE.Object3D, cutProfile: ChinCutProfile) {
  let trianglesBefore = 0;
  let trianglesAfter = 0;
  const framingBounds = new THREE.Box3();
  const emptyMeshes: THREE.Mesh[] = [];

  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;

    const result = trimGeometryAboveCut(object.geometry, object.matrixWorld, cutProfile);
    trianglesBefore += result.before;
    trianglesAfter += result.after;
    if (!result.framingBounds.isEmpty()) framingBounds.union(result.framingBounds);
    object.geometry.dispose();
    object.geometry = result.geometry;
    if (result.after === 0) emptyMeshes.push(object);
  });

  for (const mesh of emptyMeshes) mesh.parent?.remove(mesh);
  return { trianglesBefore, trianglesAfter, framingBounds };
}

function hash01(seed: number) {
  const value = Math.sin(seed * 12.9898 + 78.233) * 43758.5453;
  return value - Math.floor(value);
}

function unitVectorFromCell(cellId: number, salt: number) {
  const z = hash01(cellId * 3 + salt) * 2 - 1;
  const angle = hash01(cellId * 7 + salt * 11) * Math.PI * 2;
  const radius = Math.sqrt(1 - z * z);
  return new THREE.Vector3(radius * Math.cos(angle), radius * Math.sin(angle), z);
}

function outwardAssemblyDirection(cellId: number) {
  const angle = hash01(cellId * 47 + 29) * Math.PI * 2;
  const depth = (hash01(cellId * 53 + 31) - 0.5) * 0.3;
  return new THREE.Vector3(Math.cos(angle), Math.sin(angle), depth).normalize();
}

function assemblyArcDirection(pieceId: number, offsetDirection: THREE.Vector3) {
  const depth = (hash01(pieceId * 59 + 17) - 0.5) * 0.6;
  return new THREE.Vector3(-offsetDirection.y, offsetDirection.x, depth).normalize();
}

type MeshPieceData = {
  mesh: THREE.Mesh;
  positions: THREE.BufferAttribute;
  centroids: THREE.Vector3[];
};

type AssemblyPieceMetadata = {
  centers: THREE.Vector3[];
  directions: THREE.Vector3[];
  assignments: Uint16Array;
};

function getProjectionPlacement() {
  const { width, height } = stage.getBoundingClientRect();
  const anchor = effectsAnchor ?? {
    x: width / 2 - 240,
    y: height / 2 - 240,
    width: 480,
    height: 480
  };
  return {
    width,
    height,
    scaleX: anchor.width / width,
    scaleY: anchor.height / height,
    offsetX: ((anchor.x + anchor.width / 2) / width) * 2 - 1,
    offsetY: 1 - ((anchor.y + anchor.height / 2) / height) * 2
  };
}

function applyEmbeddedProjection() {
  const placement = getProjectionPlacement();
  const clipTransform = new THREE.Matrix4().set(
    placement.scaleX, 0, 0, placement.offsetX,
    0, placement.scaleY, 0, placement.offsetY,
    0, 0, 1, 0,
    0, 0, 0, 1
  );
  camera.projectionMatrix.premultiply(clipTransform);
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
}

function getWorldViewBounds(center: THREE.Vector3, cameraDistance: number, overscan = 1) {
  const halfHeight = Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * cameraDistance;
  const halfWidth = halfHeight * camera.aspect;
  if (!isEffectsLayer) {
    return {
      left: center.x - halfWidth * overscan,
      right: center.x + halfWidth * overscan,
      bottom: center.y - halfHeight * overscan,
      top: center.y + halfHeight * overscan
    };
  }

  const placement = getProjectionPlacement();
  const rawLeft = center.x + ((-1 - placement.offsetX) / placement.scaleX) * halfWidth;
  const rawRight = center.x + ((1 - placement.offsetX) / placement.scaleX) * halfWidth;
  const rawBottom = center.y + ((-1 - placement.offsetY) / placement.scaleY) * halfHeight;
  const rawTop = center.y + ((1 - placement.offsetY) / placement.scaleY) * halfHeight;
  return {
    left: center.x + (rawLeft - center.x) * overscan,
    right: center.x + (rawRight - center.x) * overscan,
    bottom: center.y + (rawBottom - center.y) * overscan,
    top: center.y + (rawTop - center.y) * overscan
  };
}

function allocatePieceCounts(meshes: MeshPieceData[], targetCount: number) {
  const totalTriangles = meshes.reduce((total, item) => total + item.centroids.length, 0);
  const counts = meshes.map((item) => Math.max(1, Math.floor((item.centroids.length / totalTriangles) * targetCount)));
  let allocated = counts.reduce((total, count) => total + count, 0);
  const byRemainder = meshes
    .map((item, index) => ({ index, remainder: (item.centroids.length / totalTriangles) * targetCount - counts[index] }))
    .sort((left, right) => right.remainder - left.remainder);

  let cursor = 0;
  while (allocated < targetCount) {
    counts[byRemainder[cursor % byRemainder.length].index] += 1;
    allocated += 1;
    cursor += 1;
  }
  while (allocated > targetCount) {
    const candidate = [...meshes.keys()]
      .filter((index) => counts[index] > 1)
      .sort((left, right) => counts[right] - counts[left])[0];
    if (candidate === undefined) break;
    counts[candidate] -= 1;
    allocated -= 1;
  }
  return counts;
}

function createSpatialGroups(centroids: THREE.Vector3[], groupCount: number) {
  const nearestDistances = new Float64Array(centroids.length);
  nearestDistances.fill(Number.POSITIVE_INFINITY);
  const seeds: THREE.Vector3[] = [];

  for (let group = 0; group < groupCount; group += 1) {
    let seedIndex = group === 0
      ? Math.floor(hash01(centroids.length * 17 + 3) * centroids.length)
      : 0;
    if (group > 0) {
      for (let index = 1; index < nearestDistances.length; index += 1) {
        if (nearestDistances[index] > nearestDistances[seedIndex]) seedIndex = index;
      }
    }

    const seed = centroids[seedIndex];
    seeds.push(seed);
    for (let index = 0; index < centroids.length; index += 1) {
      nearestDistances[index] = Math.min(nearestDistances[index], centroids[index].distanceToSquared(seed));
    }
  }

  const assignments = new Uint16Array(centroids.length);
  const centers = Array.from({ length: groupCount }, () => new THREE.Vector3());
  const counts = new Uint32Array(groupCount);
  for (let index = 0; index < centroids.length; index += 1) {
    let closestGroup = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let group = 0; group < seeds.length; group += 1) {
      const distance = centroids[index].distanceToSquared(seeds[group]);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestGroup = group;
      }
    }
    assignments[index] = closestGroup;
    centers[closestGroup].add(centroids[index]);
    counts[closestGroup] += 1;
  }
  centers.forEach((center, group) => center.multiplyScalar(1 / Math.max(counts[group], 1)));
  return { assignments, centers };
}

function addAssemblyAttributes(model: THREE.Object3D) {
  const meshData: MeshPieceData[] = [];
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    if (!positions?.count) return;
    const centroids: THREE.Vector3[] = [];
    const centroid = new THREE.Vector3();
    const vertex = new THREE.Vector3();
    for (let index = 0; index < positions.count; index += 3) {
      centroid.set(0, 0, 0);
      for (let offset = 0; offset < 3; offset += 1) centroid.add(vertex.fromBufferAttribute(positions, index + offset));
      centroids.push(centroid.multiplyScalar(1 / 3).clone());
    }
    meshData.push({ mesh: object, positions, centroids });
  });

  const pieceCounts = allocatePieceCounts(meshData, modelConfig.assemblePieceCount);
  let pieceOffset = 0;
  meshData.forEach(({ mesh, positions, centroids: triangleCentroids }, meshIndex) => {
    const groupCount = pieceCounts[meshIndex];
    const groups = createSpatialGroups(triangleCentroids, groupCount);
    const centroids = new Float32Array(positions.count * 3);
    const offsetDirections = new Float32Array(positions.count * 3);
    const startOffsets = new Float32Array(positions.count * 3);
    const arcDirections = new Float32Array(positions.count * 3);
    const rotationAxes = new Float32Array(positions.count * 3);
    const delays = new Float32Array(positions.count);

    const directions = Array.from({ length: groupCount }, (_, group) => outwardAssemblyDirection(pieceOffset + group));
    for (let triangleIndex = 0; triangleIndex < triangleCentroids.length; triangleIndex += 1) {
      const group = groups.assignments[triangleIndex];
      const pieceId = pieceOffset + group;
      const pieceCenter = groups.centers[group];
      const offsetDirection = directions[group];
      const arcDirection = assemblyArcDirection(pieceId, offsetDirection);
      const rotationAxis = unitVectorFromCell(pieceId, 2);
      const delay = hash01(pieceId * 13 + 3);
      for (let offset = 0; offset < 3; offset += 1) {
        const vertexIndex = triangleIndex * 3 + offset;
        centroids.set([pieceCenter.x, pieceCenter.y, pieceCenter.z], vertexIndex * 3);
        offsetDirections.set(
          [offsetDirection.x, offsetDirection.y, offsetDirection.z],
          vertexIndex * 3
        );
        arcDirections.set([arcDirection.x, arcDirection.y, arcDirection.z], vertexIndex * 3);
        rotationAxes.set(
          [rotationAxis.x, rotationAxis.y, rotationAxis.z],
          vertexIndex * 3
        );
        delays[vertexIndex] = delay;
      }
    }
    mesh.geometry.setAttribute('aCentroid', new THREE.BufferAttribute(centroids, 3));
    mesh.geometry.setAttribute('aOffsetDir', new THREE.BufferAttribute(offsetDirections, 3));
    mesh.geometry.setAttribute('aStartOffset', new THREE.BufferAttribute(startOffsets, 3));
    mesh.geometry.setAttribute('aArcDir', new THREE.BufferAttribute(arcDirections, 3));
    mesh.geometry.setAttribute('aRotAxis', new THREE.BufferAttribute(rotationAxes, 3));
    mesh.geometry.setAttribute('aDelay', new THREE.BufferAttribute(delays, 1));
    mesh.userData.jarvisAssemblyPieces = {
      centers: groups.centers,
      directions,
      assignments: groups.assignments
    } satisfies AssemblyPieceMetadata;
    pieceOffset += groupCount;
  });
  console.log(`[Jarvis] assembly pieces=${pieceOffset}`);
}

function updateAssemblyStartOffsets(model: THREE.Object3D) {
  if (!headBounds) return;

  const baseCenter = (cameraFramingBounds ?? headBounds).getCenter(new THREE.Vector3());
  const cameraDistance = camera.position.z - baseCenter.z;
  const viewBounds = getWorldViewBounds(baseCenter, cameraDistance, modelConfig.particleEdgeOverscan);
  const worldStart = new THREE.Vector3();
  const worldCenter = new THREE.Vector3();
  const worldDirection = new THREE.Vector3();
  const localStart = new THREE.Vector3();
  const localOffset = new THREE.Vector3();

  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const metadata = object.userData.jarvisAssemblyPieces as AssemblyPieceMetadata | undefined;
    const offsets = object.geometry.getAttribute('aStartOffset');
    if (!metadata || !offsets) return;

    const inverseMatrix = object.matrixWorld.clone().invert();
    const offsetsByGroup = metadata.centers.map((center, group) => {
      worldCenter.copy(center).applyMatrix4(object.matrixWorld);
      worldDirection.copy(metadata.directions[group]).transformDirection(object.matrixWorld);
      const edgeDistanceX = worldDirection.x >= 0
        ? (viewBounds.right - worldCenter.x) / worldDirection.x
        : (viewBounds.left - worldCenter.x) / worldDirection.x;
      const edgeDistanceY = worldDirection.y >= 0
        ? (viewBounds.top - worldCenter.y) / worldDirection.y
        : (viewBounds.bottom - worldCenter.y) / worldDirection.y;
      const edgeDistance = Math.min(edgeDistanceX, edgeDistanceY);
      worldStart.copy(worldCenter).addScaledVector(worldDirection, edgeDistance);
      localStart.copy(worldStart).applyMatrix4(inverseMatrix);
      return localOffset.copy(localStart).sub(center).clone();
    });

    for (let triangleIndex = 0; triangleIndex < metadata.assignments.length; triangleIndex += 1) {
      const offset = offsetsByGroup[metadata.assignments[triangleIndex]];
      for (let vertex = 0; vertex < 3; vertex += 1) {
        offsets.setXYZ(triangleIndex * 3 + vertex, offset.x, offset.y, offset.z);
      }
    }
    offsets.needsUpdate = true;
  });
}

function configureAssemblyMaterial(material: THREE.MeshStandardMaterial) {
  if (material.userData.jarvisAssemblyConfigured) return;

  const previousOnBeforeCompile = material.onBeforeCompile;
  const previousProgramCacheKey = material.customProgramCacheKey;
  material.transparent = true;
  material.depthWrite = true;
  material.onBeforeCompile = (shader, renderer) => {
    previousOnBeforeCompile(shader, renderer);
    shader.uniforms.uProgress = assemblyUniforms.uProgress;
    shader.uniforms.uSpread = assemblyUniforms.uSpread;
    shader.uniforms.uCutY = assemblyUniforms.uCutY;
    shader.uniforms.uCutCenterX = assemblyUniforms.uCutCenterX;
    shader.uniforms.uCutHalfWidth = assemblyUniforms.uCutHalfWidth;
    shader.uniforms.uCutCenterDrop = assemblyUniforms.uCutCenterDrop;
    shader.uniforms.uCutFlatFraction = assemblyUniforms.uCutFlatFraction;
    shader.uniforms.uCutSpaceMatrix = assemblyUniforms.uCutSpaceMatrix;
    shader.uniforms.uFadeHeight = assemblyUniforms.uFadeHeight;

    shader.vertexShader = `
      attribute vec3 aCentroid;
      attribute vec3 aOffsetDir;
      attribute vec3 aStartOffset;
      attribute vec3 aArcDir;
      attribute vec3 aRotAxis;
      attribute float aDelay;
      uniform float uProgress;
      uniform float uSpread;
      uniform mat4 uCutSpaceMatrix;
      varying float vWorldX;
      varying float vWorldY;
      varying float vWorldZ;
      vec3 jarvisRotate(vec3 v, vec3 axis, float angle) {
        float c = cos(angle);
        float s = sin(angle);
        return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
      }
      float jarvisAssemblyProgress(float delay) {
        float delayedStart = delay * ${modelConfig.assembleDelay.toFixed(2)};
        float p = clamp((uProgress - delayedStart) / (1.0 - delayedStart), 0.0, 1.0);
        return 1.0 - pow(1.0 - p, 3.0);
      }
    ${shader.vertexShader}`;
    shader.vertexShader = shader.vertexShader.replace(
      '#include <begin_vertex>',
      `
        vec3 local = position - aCentroid;
        float p = jarvisAssemblyProgress(aDelay);
        float k = 1.0 - p;
        float a = k * 6.28318;
        vec3 rotated = jarvisRotate(local, aRotAxis, a);
        vec3 curvedOffset = aArcDir * sin(p * 3.14159) * length(aStartOffset) * 0.26;
        vec3 transformed = aCentroid + rotated + aStartOffset * k + curvedOffset;
        vec4 jarvisWorldPosition = modelMatrix * vec4(transformed, 1.0);
        vec4 jarvisCutPosition = uCutSpaceMatrix * jarvisWorldPosition;
        vWorldX = jarvisCutPosition.x;
        vWorldY = jarvisCutPosition.y;
        vWorldZ = jarvisCutPosition.z;
      `
    );
    shader.vertexShader = shader.vertexShader.replace(
      '#include <beginnormal_vertex>',
      `
        #include <beginnormal_vertex>
        float normalP = jarvisAssemblyProgress(aDelay);
        float normalK = 1.0 - normalP;
        float normalA = normalK * 6.28318;
        objectNormal = jarvisRotate(objectNormal, aRotAxis, normalA);
      `
    );
    shader.fragmentShader = `
      uniform float uProgress;
      uniform float uCutY;
      uniform float uCutCenterX;
      uniform float uCutHalfWidth;
      uniform float uCutCenterDrop;
      uniform float uCutFlatFraction;
      uniform float uFadeHeight;
      varying float vWorldX;
      varying float vWorldY;
      varying float vWorldZ;
      float jarvisChinCutY(float worldX) {
        float normalizedX = abs(worldX - uCutCenterX) / max(uCutHalfWidth, 0.0001);
        float slopeProgress = smoothstep(uCutFlatFraction, 1.0, normalizedX);
        return uCutY - uCutCenterDrop * (1.0 - slopeProgress);
      }
    ${shader.fragmentShader}`;
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <opaque_fragment>',
      `
        #include <opaque_fragment>
        float cutBoundary = jarvisChinCutY(vWorldX);
        float bottomFade = smoothstep(cutBoundary, cutBoundary + uFadeHeight, vWorldY);
        float fadeIn = smoothstep(0.88, 1.0, uProgress);
        float fade = mix(1.0, bottomFade, fadeIn);
        gl_FragColor.a *= fade;
        if (fade <= 0.001) discard;
      `
    );
  };
  material.customProgramCacheKey = () => `${previousProgramCacheKey.call(material)}|jarvis-assembly-v1`;
  material.userData.jarvisAssemblyConfigured = true;
  material.needsUpdate = true;
}

function configureAssemblyMaterials(model: THREE.Object3D) {
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    for (const material of materials) {
      if (isEmissiveMaterial(material)) configureAssemblyMaterial(material);
    }
  });
}

function createAssemblyParticles(model: THREE.Object3D) {
  if (!headBounds) return;
  if (assemblyParticles) {
    scene.remove(assemblyParticles);
    assemblyParticles.geometry.dispose();
    (assemblyParticles.material as THREE.Material).dispose();
    assemblyParticles = null;
  }

  const sources: Array<{ mesh: THREE.Mesh; positions: THREE.BufferAttribute; weight: number }> = [];
  let totalWeight = 0;
  model.updateMatrixWorld(true);
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh)) return;
    const positions = object.geometry.getAttribute('position');
    if (!positions?.count) return;
    totalWeight += positions.count;
    sources.push({ mesh: object, positions, weight: totalWeight });
  });
  if (!sources.length) return;

  const maximumEdge = Math.max(...headBounds.getSize(new THREE.Vector3()).toArray());
  const framing = cameraFramingBounds ?? headBounds;
  const baseCenter = framing.getCenter(new THREE.Vector3());
  const center = headBounds.getCenter(new THREE.Vector3()).add(model.position);
  const cameraDistance = camera.position.z - baseCenter.z;
  const viewBounds = getWorldViewBounds(baseCenter, cameraDistance, modelConfig.particleEdgeOverscan);
  const halfHeight = (viewBounds.top - viewBounds.bottom) / 2;
  const halfWidth = (viewBounds.right - viewBounds.left) / 2;
  const positions = new Float32Array(modelConfig.particleCount * 3);
  const startPositions = new Float32Array(modelConfig.particleCount * 3);
  const curveOffsets = new Float32Array(modelConfig.particleCount * 3);
  const colors = new Float32Array(modelConfig.particleCount * 3);
  const delays = new Float32Array(modelConfig.particleCount);
  const sizes = new Float32Array(modelConfig.particleCount);
  const target = new THREE.Vector3();
  const start = new THREE.Vector3();
  const color = new THREE.Color();

  for (let index = 0; index < modelConfig.particleCount; index += 1) {
    const selection = hash01(index * 19 + 5) * totalWeight;
    const source = sources.find((item) => selection < item.weight) ?? sources[sources.length - 1];
    const vertexIndex = Math.floor(hash01(index * 23 + 7) * source.positions.count);
    target
      .fromBufferAttribute(source.positions, vertexIndex)
      .applyMatrix4(source.mesh.matrixWorld);
    const angle = hash01(index * 29 + 11) * Math.PI * 2;
    const directionX = Math.cos(angle);
    const directionY = Math.sin(angle);
    const edgeDistanceX = directionX >= 0
      ? (viewBounds.right - center.x) / directionX
      : (viewBounds.left - center.x) / directionX;
    const edgeDistanceY = directionY >= 0
      ? (viewBounds.top - center.y) / directionY
      : (viewBounds.bottom - center.y) / directionY;
    const edgeScale = Math.min(edgeDistanceX, edgeDistanceY);
    const depth = (hash01(index * 31 + 13) - 0.5) * maximumEdge * modelConfig.particleSpread;
    start.set(center.x + directionX * edgeScale, center.y + directionY * edgeScale, center.z + depth);
    const curveStrength = 0.2 + hash01(index * 47 + 19) * 0.75;
    curveOffsets.set(
      [
        -directionY * halfWidth * curveStrength,
        directionX * halfHeight * curveStrength,
        (hash01(index * 53 + 29) - 0.5) * maximumEdge * 0.8
      ],
      index * 3
    );

    positions.set([target.x, target.y, target.z], index * 3);
    startPositions.set([start.x, start.y, start.z], index * 3);
    const colorChoice = hash01(index * 43 + 23);
    if (colorChoice < modelConfig.particleWhiteRatio) color.setHex(modelConfig.particleWhiteColor);
    else if (colorChoice < 0.55) color.setHex(modelConfig.particleRedColor);
    else color.setHex(modelConfig.particleYellowColor);
    colors.set([color.r, color.g, color.b], index * 3);
    delays[index] = hash01(index * 37 + 13);
    const sizeVariation = Math.pow(hash01(index * 41 + 17), 2);
    sizes[index] = THREE.MathUtils.lerp(
      modelConfig.particleMinSize,
      modelConfig.particleMaxSize,
      sizeVariation
    );
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geometry.setAttribute('aStart', new THREE.BufferAttribute(startPositions, 3));
  geometry.setAttribute('aCurve', new THREE.BufferAttribute(curveOffsets, 3));
  geometry.setAttribute('aColor', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aDelay', new THREE.BufferAttribute(delays, 1));
  geometry.setAttribute('aSize', new THREE.BufferAttribute(sizes, 1));

  const material = new THREE.ShaderMaterial({
    uniforms: particleUniforms,
    transparent: true,
    depthWrite: false,
    depthTest: false,
    blending: THREE.AdditiveBlending,
    vertexShader: `
      attribute vec3 aStart;
      attribute vec3 aCurve;
      attribute vec3 aColor;
      attribute float aDelay;
      attribute float aSize;
      uniform float uProgress;
      varying float vParticleAlpha;
      varying vec3 vParticleColor;
      void main() {
        float delayedStart = aDelay * ${modelConfig.particleDelay.toFixed(2)};
        float p = clamp((uProgress - delayedStart) / (1.0 - delayedStart), 0.0, 1.0);
        p = 1.0 - pow(1.0 - p, 3.0);
        vec3 transformed = mix(aStart, position, p) + aCurve * sin(p * 3.14159);
        float arrivalFade = 1.0 - smoothstep(0.94, 1.0, p);
        vParticleAlpha = arrivalFade * (0.38 + 0.42 * (1.0 - aDelay));
        vParticleColor = aColor;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(transformed, 1.0);
        gl_PointSize = aSize * (1.45 + (1.0 - p) * 0.35);
      }
    `,
    fragmentShader: `
      varying float vParticleAlpha;
      varying vec3 vParticleColor;
      void main() {
        float distanceFromCenter = length(gl_PointCoord - vec2(0.5)) * 2.0;
        float core = 1.0 - smoothstep(0.0, 0.18, distanceFromCenter);
        float innerGlow = 1.0 - smoothstep(0.06, 0.56, distanceFromCenter);
        float outerGlow = 1.0 - smoothstep(0.20, 1.0, distanceFromCenter);
        float alpha = (core * 0.72 + innerGlow * 0.30 + outerGlow * 0.14) * vParticleAlpha;
        if (alpha <= 0.001) discard;
        vec3 glowColor = vParticleColor * (core * 1.75 + innerGlow * 0.72 + outerGlow * 0.30);
        gl_FragColor = vec4(glowColor, alpha);
      }
    `
  });
  assemblyParticles = new THREE.Points(geometry, material);
  assemblyParticles.renderOrder = 2;
  scene.add(assemblyParticles);
}

function configureFramedHead(model: THREE.Object3D, cutProfile: ChinCutProfile) {
  if (!headBounds || headBounds.isEmpty()) {
    console.error('[Jarvis] Unable to frame model: no helmet geometry is available.');
    headBounds = null;
    return false;
  }

  const headSize = headBounds.getSize(new THREE.Vector3());
  assemblyUniforms.uCutY.value = cutProfile.baseY;
  assemblyUniforms.uCutCenterX.value = cutProfile.centerX;
  assemblyUniforms.uCutHalfWidth.value = cutProfile.halfWidth;
  assemblyUniforms.uCutCenterDrop.value = cutProfile.centerDrop;
  assemblyUniforms.uCutFlatFraction.value = cutProfile.flatFraction;
  assemblyUniforms.uFadeHeight.value = headSize.y * modelConfig.bottomFadeHeight;
  assemblyUniforms.uSpread.value =
    (Math.max(headSize.x, headSize.y, headSize.z) * modelConfig.assembleSpread) / model.scale.x;
  addAssemblyAttributes(model);
  configureAssemblyMaterials(model);
  return true;
}

function isPretrimmedHelmetMetadata(value: unknown): value is PretrimmedHelmetMetadata {
  if (!value || typeof value !== 'object') return false;
  const metadata = value as Partial<PretrimmedHelmetMetadata>;
  return (
    Array.isArray(metadata.scale) && metadata.scale.length === 3 &&
    Boolean(metadata.cutProfile) &&
    Array.isArray(metadata.framingBounds?.min) &&
    Array.isArray(metadata.framingBounds?.max) &&
    Number.isFinite(metadata.triangles)
  );
}

function expandIndexedGeometryForAssembly(model: THREE.Object3D) {
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.geometry.index) return;
    const indexedGeometry = object.geometry;
    object.geometry = indexedGeometry.toNonIndexed();
    indexedGeometry.dispose();
  });
}

function smoothIndexedNormals(geometry: THREE.BufferGeometry, iterations: number, strength: number) {
  const indices = geometry.getIndex();
  const normals = geometry.getAttribute('normal');
  if (!indices || !normals || normals.itemSize !== 3) return;

  const neighbours = Array.from({ length: normals.count }, () => new Set<number>());
  const connect = (left: number, right: number) => {
    if (left === right) return;
    neighbours[left].add(right);
    neighbours[right].add(left);
  };
  for (let offset = 0; offset < indices.count; offset += 3) {
    const a = indices.getX(offset);
    const b = indices.getX(offset + 1);
    const c = indices.getX(offset + 2);
    connect(a, b);
    connect(b, c);
    connect(c, a);
  }

  let source = new Float32Array(normals.count * 3);
  let target = new Float32Array(normals.count * 3);
  for (let index = 0; index < normals.count; index += 1) {
    source[index * 3] = normals.getX(index);
    source[index * 3 + 1] = normals.getY(index);
    source[index * 3 + 2] = normals.getZ(index);
  }

  const clampedStrength = THREE.MathUtils.clamp(strength, 0, 1);
  const minimumNormalDot = Math.cos(THREE.MathUtils.degToRad(24));
  for (let pass = 0; pass < iterations; pass += 1) {
    for (let index = 0; index < normals.count; index += 1) {
      const offset = index * 3;
      const nx = source[offset];
      const ny = source[offset + 1];
      const nz = source[offset + 2];
      let sumX = nx;
      let sumY = ny;
      let sumZ = nz;
      let weight = 1;
      for (const neighbour of neighbours[index]) {
        const neighbourOffset = neighbour * 3;
        const neighbourX = source[neighbourOffset];
        const neighbourY = source[neighbourOffset + 1];
        const neighbourZ = source[neighbourOffset + 2];
        if (nx * neighbourX + ny * neighbourY + nz * neighbourZ < minimumNormalDot) continue;
        sumX += neighbourX;
        sumY += neighbourY;
        sumZ += neighbourZ;
        weight += 1;
      }
      const averageLength = Math.hypot(sumX, sumY, sumZ) || 1;
      const averageX = sumX / averageLength;
      const averageY = sumY / averageLength;
      const averageZ = sumZ / averageLength;
      const blendedX = THREE.MathUtils.lerp(nx, averageX, clampedStrength);
      const blendedY = THREE.MathUtils.lerp(ny, averageY, clampedStrength);
      const blendedZ = THREE.MathUtils.lerp(nz, averageZ, clampedStrength);
      const blendedLength = Math.hypot(blendedX, blendedY, blendedZ) || 1;
      target[offset] = blendedX / blendedLength;
      target[offset + 1] = blendedY / blendedLength;
      target[offset + 2] = blendedZ / blendedLength;
    }
    [source, target] = [target, source];
  }

  for (let index = 0; index < normals.count; index += 1) {
    const offset = index * 3;
    normals.setXYZ(index, source[offset], source[offset + 1], source[offset + 2]);
  }
  normals.needsUpdate = true;
}

function symmetrizeMetalSurfaceNormals(model: THREE.Object3D) {
  model.traverse((object) => {
    if (!(object instanceof THREE.Mesh) || !object.geometry.index) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    if (!materials.some((material) => [modelConfig.faceplateMaterial, 'Mat.1'].includes(material.name))) return;

    const geometry = object.geometry;
    const positions = geometry.getAttribute('position');
    const normals = geometry.getAttribute('normal');
    if (!positions || !normals) return;
    if (materials.some((material) => material.name === modelConfig.faceplateMaterial)) {
      smoothIndexedNormals(
        geometry,
        modelConfig.faceplateNormalSmoothingIterations,
        modelConfig.faceplateNormalSmoothingStrength
      );
    }
    geometry.computeBoundingBox();
    const bounds = geometry.boundingBox;
    if (!bounds) return;

    const centerX = (bounds.min.x + bounds.max.x) / 2;
    const pairingDistance = Math.max(bounds.max.x - bounds.min.x, 0.0001) * 0.007;
    const rightBuckets = new Map<string, number[]>();
    const bucketKey = (x: number, y: number, z: number) =>
      `${Math.floor(x / pairingDistance)},${Math.floor(y / pairingDistance)},${Math.floor(z / pairingDistance)}`;
    const readPosition = (index: number, target: THREE.Vector3) => target.fromBufferAttribute(positions, index);
    const point = new THREE.Vector3();
    for (let index = 0; index < positions.count; index += 1) {
      readPosition(index, point);
      if (point.x <= centerX) continue;
      const key = bucketKey(point.x, point.y, point.z);
      const bucket = rightBuckets.get(key) ?? [];
      bucket.push(index);
      rightBuckets.set(key, bucket);
    }

    const leftPoint = new THREE.Vector3();
    const mirroredPoint = new THREE.Vector3();
    const candidatePoint = new THREE.Vector3();
    const leftNormal = new THREE.Vector3();
    const rightNormal = new THREE.Vector3();
    const averagedNormal = new THREE.Vector3();
    const usedRightVertices = new Set<number>();
    let pairs = 0;
    for (let leftIndex = 0; leftIndex < positions.count; leftIndex += 1) {
      readPosition(leftIndex, leftPoint);
      if (leftPoint.x >= centerX) continue;
      mirroredPoint.set(2 * centerX - leftPoint.x, leftPoint.y, leftPoint.z);
      const baseX = Math.floor(mirroredPoint.x / pairingDistance);
      const baseY = Math.floor(mirroredPoint.y / pairingDistance);
      const baseZ = Math.floor(mirroredPoint.z / pairingDistance);
      let rightIndex = -1;
      let nearestDistanceSquared = pairingDistance * pairingDistance;
      for (let dx = -1; dx <= 1; dx += 1) {
        for (let dy = -1; dy <= 1; dy += 1) {
          for (let dz = -1; dz <= 1; dz += 1) {
            const bucket = rightBuckets.get(`${baseX + dx},${baseY + dy},${baseZ + dz}`) ?? [];
            for (const candidateIndex of bucket) {
              if (usedRightVertices.has(candidateIndex)) continue;
              readPosition(candidateIndex, candidatePoint);
              const distanceSquared = candidatePoint.distanceToSquared(mirroredPoint);
              if (distanceSquared >= nearestDistanceSquared) continue;
              nearestDistanceSquared = distanceSquared;
              rightIndex = candidateIndex;
            }
          }
        }
      }
      if (rightIndex < 0) continue;

      leftNormal.fromBufferAttribute(normals, leftIndex);
      rightNormal.fromBufferAttribute(normals, rightIndex);
      rightNormal.x *= -1;
      averagedNormal.copy(leftNormal).add(rightNormal).normalize();
      normals.setXYZ(leftIndex, averagedNormal.x, averagedNormal.y, averagedNormal.z);
      normals.setXYZ(rightIndex, -averagedNormal.x, averagedNormal.y, averagedNormal.z);
      usedRightVertices.add(rightIndex);
      pairs += 1;
    }
    normals.needsUpdate = true;
    console.log(`[Jarvis] symmetric metal normals material=${materials[0]?.name || '(unnamed)'} pairs=${pairs}`);
  });
}

function frameModel(model: THREE.Object3D) {
  model.rotation.set(modelConfig.rotationX, modelConfig.rotationY, modelConfig.rotationZ);
  const pretrimmed = model.userData.jarvisPretrimmed;
  if (isPretrimmedHelmetMetadata(pretrimmed)) {
    model.scale.fromArray(pretrimmed.scale);
    symmetrizeMetalSurfaceNormals(model);
    // Assembly attributes operate per triangle. Expanding indices duplicates
    // the original position/normal/UV values exactly; no normals are rebuilt.
    expandIndexedGeometryForAssembly(model);
    headBounds = new THREE.Box3(
      new THREE.Vector3().fromArray(pretrimmed.framingBounds.min),
      new THREE.Vector3().fromArray(pretrimmed.framingBounds.max)
    );
    cameraFramingBounds = headBounds.clone();
    if (!configureFramedHead(model, pretrimmed.cutProfile)) return;
    return {
      trianglesBefore: pretrimmed.triangles,
      trianglesAfter: pretrimmed.triangles,
      cutY: pretrimmed.cutProfile.baseY,
      framingBounds: headBounds.clone()
    };
  }

  const bounds = new THREE.Box3().setFromObject(model);
  const size = bounds.getSize(new THREE.Vector3());
  const maximumEdge = Math.max(size.x, size.y, size.z);

  if (!Number.isFinite(maximumEdge) || maximumEdge <= 0) {
    console.error('[Jarvis] Unable to frame model: its bounding box has no size.');
    return;
  }

  model.scale.set(
    1 / maximumEdge,
    modelConfig.heightScale / maximumEdge,
    1 / maximumEdge
  );

  const scaledBounds = new THREE.Box3().setFromObject(model);
  const scaledSize = scaledBounds.getSize(new THREE.Vector3());
  const cutY = scaledBounds.max.y - scaledSize.y * modelConfig.trimTopFraction;
  const upperBounds = getBoundsAboveY(model, cutY);
  const upperCenter = upperBounds.getCenter(new THREE.Vector3());
  const upperSize = upperBounds.getSize(new THREE.Vector3());
  const cutProfile: ChinCutProfile = {
    baseY: cutY,
    centerX: upperCenter.x,
    halfWidth: upperSize.x / 2,
    centerDrop: upperSize.y * modelConfig.chinCenterDrop,
    flatFraction: modelConfig.chinFlatFraction
  };
  const trimResult = trimModelGeometry(model, cutProfile);
  headBounds = trimResult.framingBounds.clone();
  cameraFramingBounds = trimResult.framingBounds.isEmpty()
    ? headBounds.clone()
    : trimResult.framingBounds.clone();

  if (!configureFramedHead(model, cutProfile)) return;

  return { ...trimResult, cutY };
}

function positionCameraForHead() {
  if (!headBounds) return;

  const framing = cameraFramingBounds ?? headBounds;
  const center = framing.getCenter(new THREE.Vector3());
  const size = framing.getSize(new THREE.Vector3());
  const halfFov = THREE.MathUtils.degToRad(camera.fov) / 2;
  const distForHeight = (size.y / 2) / Math.tan(halfFov);
  const framingAspect = isEffectsLayer ? 1 : camera.aspect;
  const distForWidth = (size.x / 2) / Math.tan(halfFov) / framingAspect;
  const baseCameraDistance = Math.max(distForHeight, distForWidth) * modelConfig.focusPadding;
  const cameraDistance = baseCameraDistance;
  camera.aspect = framingAspect;
  camera.updateProjectionMatrix();
  if (isEffectsLayer) applyEmbeddedProjection();
  camera.position.set(center.x, center.y, framing.max.z + cameraDistance);
  camera.lookAt(center);
  setLights(cameraDistance, center);
  return { center, size, cameraDistance };
}

function resizeRenderer() {
  const { width, height } = stage.getBoundingClientRect();
  if (!width || !height) return;

  camera.aspect = isEffectsLayer ? 1 : width / height;
  camera.updateProjectionMatrix();
  renderer.setSize(width, height, false);
  positionCameraForHead();
  if (helmet) updateAssemblyStartOffsets(helmet);
}

function getStateTargets(timestamp: number) {
  targetRotationX = modelConfig.rotationX;
  targetRotationY = restingRotationY;
  if (activeState === 'idle') {
    targetEmissiveIntensity = 0.6;
    targetBloomStrength = 0.5;
    return;
  }

  if (activeState === 'listening') {
    targetEmissiveIntensity = 1.2;
    targetBloomStrength = 0.9;
    return;
  }

  if (activeState === 'thinking') {
    const pulse = (Math.sin((timestamp / 800) * Math.PI * 2) + 1) / 2;
    targetEmissiveIntensity = 0.7 + pulse * 0.6;
    targetBloomStrength = 0.9;
    return;
  }

  targetEmissiveIntensity = 0.8 + currentLevel * 1.2;
  targetBloomStrength = 0.6 + currentLevel * 1.2;
}

function interpolate(current: number, target: number) {
  return current + (target - current) * 0.15;
}

function easeInOutCubic(value: number) {
  return value < 0.5
    ? 4 * value * value * value
    : 1 - Math.pow(-2 * value + 2, 3) / 2;
}

function normalizeYaw(value: number) {
  return Math.atan2(Math.sin(value), Math.cos(value));
}

function nearestYaw(target: number, reference: number) {
  const fullTurn = Math.PI * 2;
  return target + Math.round((reference - target) / fullTurn) * fullTurn;
}

function randomBetween(minimum: number, maximum: number) {
  return minimum + Math.random() * (maximum - minimum);
}

function createSpeakingKeyframes() {
  const basePitch = modelConfig.rotationX;
  const baseYaw = restingRotationY;
  const changeSide = Math.random() < 0.68;
  const direction = changeSide ? -lastSpeakingYawDirection : lastSpeakingYawDirection;
  lastSpeakingYawDirection = direction;

  // Most movements are subtle. Larger turns are reserved for occasional
  // emphasis so the motion feels expressive instead of mechanically random.
  const emphasis = Math.random();
  const primaryYawDegrees = emphasis < 0.72
    ? randomBetween(8, 27)
    : emphasis < 0.94
      ? randomBetween(27, 44)
      : randomBetween(44, 60);
  const primaryPitchDegrees = randomBetween(-13, 13);
  const secondaryDirection = Math.random() < 0.58 ? -direction : direction;
  const secondaryYawDegrees = randomBetween(4, Math.min(24, primaryYawDegrees * 0.58));
  const secondaryPitchDegrees = randomBetween(-8, 8);
  const approachDuration = randomBetween(520, 900);
  const holdDuration = randomBetween(150, 360);
  const followThroughDuration = randomBetween(420, 720);
  const returnDuration = randomBetween(520, 820);
  const primaryYaw = baseYaw + direction * THREE.MathUtils.degToRad(primaryYawDegrees);
  const primaryPitch = basePitch + THREE.MathUtils.degToRad(primaryPitchDegrees);
  const secondaryYaw = baseYaw + secondaryDirection * THREE.MathUtils.degToRad(secondaryYawDegrees);
  const secondaryPitch = basePitch + THREE.MathUtils.degToRad(secondaryPitchDegrees);

  return [
    { at: 0, pitch: currentRotationX, yaw: currentRotationY },
    { at: approachDuration, pitch: primaryPitch, yaw: primaryYaw },
    { at: approachDuration + holdDuration, pitch: primaryPitch, yaw: primaryYaw },
    {
      at: approachDuration + holdDuration + followThroughDuration,
      pitch: secondaryPitch,
      yaw: secondaryYaw
    },
    {
      at: approachDuration + holdDuration + followThroughDuration + returnDuration,
      pitch: basePitch,
      yaw: baseYaw
    }
  ];
}

function startSpeakingMotion(timestamp: number) {
  gestureAnimation = {
    startedAt: timestamp,
    keyframes: createSpeakingKeyframes(),
    source: 'speech'
  };
}

function settleSpeakingMotion() {
  if (gestureAnimation?.source !== 'speech') return;
  gestureAnimation = {
    startedAt: performance.now(),
    keyframes: [
      { at: 0, pitch: currentRotationX, yaw: currentRotationY },
      { at: 520, pitch: modelConfig.rotationX, yaw: restingRotationY }
    ],
    source: 'speech'
  };
}

function createGestureKeyframes(gesture: JarvisGesture) {
  const basePitch = modelConfig.rotationX;
  const baseYaw = restingRotationY;
  if (gesture.startsWith('spin')) {
    const direction = gesture === 'spin-clockwise'
      ? -1
      : gesture === 'spin-counterclockwise'
        ? 1
        : Math.random() < 0.5 ? -1 : 1;
    return [
      { at: 0, pitch: currentRotationX, yaw: currentRotationY },
      { at: 3600, pitch: basePitch, yaw: currentRotationY + direction * Math.PI * 2 }
    ];
  }

  const viewYawByGesture: Partial<Record<JarvisGesture, number>> = {
    'face-front': modelConfig.rotationY,
    'face-back': modelConfig.rotationY + Math.PI,
    'face-left': modelConfig.rotationY - Math.PI / 2,
    'face-right': modelConfig.rotationY + Math.PI / 2
  };
  const viewYaw = viewYawByGesture[gesture];
  if (viewYaw !== undefined) {
    return [
      { at: 0, pitch: currentRotationX, yaw: currentRotationY },
      { at: 1400, pitch: basePitch, yaw: nearestYaw(viewYaw, currentRotationY) }
    ];
  }

  if (gesture === 'turn') {
    return [
      { at: 0, pitch: currentRotationX, yaw: currentRotationY },
      { at: 650, pitch: basePitch, yaw: baseYaw + THREE.MathUtils.degToRad(28) },
      { at: 950, pitch: basePitch, yaw: baseYaw + THREE.MathUtils.degToRad(28) },
      { at: 1850, pitch: basePitch, yaw: baseYaw - THREE.MathUtils.degToRad(26) },
      { at: 2150, pitch: basePitch, yaw: baseYaw - THREE.MathUtils.degToRad(26) },
      { at: 2800, pitch: basePitch, yaw: baseYaw }
    ];
  }

  if (gesture === 'shake') {
    return [
      { at: 0, pitch: currentRotationX, yaw: currentRotationY },
      { at: 180, pitch: basePitch, yaw: baseYaw + THREE.MathUtils.degToRad(9) },
      { at: 390, pitch: basePitch, yaw: baseYaw - THREE.MathUtils.degToRad(10) },
      { at: 600, pitch: basePitch, yaw: baseYaw + THREE.MathUtils.degToRad(8) },
      { at: 830, pitch: basePitch, yaw: baseYaw }
    ];
  }

  return [
    { at: 0, pitch: currentRotationX, yaw: currentRotationY },
    { at: 260, pitch: basePitch + THREE.MathUtils.degToRad(11), yaw: baseYaw },
    { at: 500, pitch: basePitch - THREE.MathUtils.degToRad(3), yaw: baseYaw },
    { at: 710, pitch: basePitch + THREE.MathUtils.degToRad(8), yaw: baseYaw },
    { at: 1020, pitch: basePitch, yaw: baseYaw }
  ];
}

function startGesture(gesture: JarvisGesture) {
  const keyframes = createGestureKeyframes(gesture);
  if (gesture.startsWith('spin') || gesture.startsWith('face-')) {
    restingRotationY = normalizeYaw(keyframes[keyframes.length - 1].yaw);
  }
  gestureAnimation = {
    startedAt: performance.now(),
    keyframes,
    source: 'command'
  };
}

function updateGesture(timestamp: number) {
  if (!gestureAnimation) return false;
  const elapsed = timestamp - gestureAnimation.startedAt;
  const keyframes = gestureAnimation.keyframes;
  const last = keyframes[keyframes.length - 1];
  if (elapsed >= last.at) {
    const source = gestureAnimation.source;
    currentRotationX = last.pitch;
    currentRotationY = normalizeYaw(last.yaw);
    gestureAnimation = null;
    if (source === 'speech' && activeState === 'speaking') {
      nextSpeakingMotionAt = timestamp + randomBetween(180, 520);
    }
    return false;
  }

  const nextIndex = keyframes.findIndex((keyframe) => keyframe.at >= elapsed);
  const next = keyframes[Math.max(nextIndex, 1)];
  const previous = keyframes[Math.max(nextIndex - 1, 0)];
  const progress = easeInOutCubic((elapsed - previous.at) / Math.max(next.at - previous.at, 1));
  currentRotationX = THREE.MathUtils.lerp(previous.pitch, next.pitch, progress);
  currentRotationY = THREE.MathUtils.lerp(previous.yaw, next.yaw, progress);
  return true;
}

function updateCutSpaceMatrix() {
  if (!helmetPivot) {
    assemblyUniforms.uCutSpaceMatrix.value.identity();
    return;
  }
  helmetPivot.updateMatrixWorld(true);
  assemblyUniforms.uCutSpaceMatrix.value.copy(helmetPivot.matrixWorld).invert();
}

function attachHelmetToPivot(model: THREE.Object3D) {
  if (!headBounds) return;
  const center = (cameraFramingBounds ?? headBounds).getCenter(new THREE.Vector3());
  helmetPivot = new THREE.Group();
  helmetPivot.position.copy(center);
  model.position.sub(center);
  helmetPivot.add(model);
  scene.add(helmetPivot);
  assemblyUniforms.uCutY.value -= center.y;
  assemblyUniforms.uCutCenterX.value -= center.x;
  updateCutSpaceMatrix();
}

function beginAssembly() {
  gestureAnimation = null;
  nextSpeakingMotionAt = 0;
  restingRotationY = modelConfig.rotationY;
  currentRotationX = modelConfig.rotationX;
  currentRotationY = modelConfig.rotationY;
  if (helmetPivot) helmetPivot.rotation.set(currentRotationX, currentRotationY, modelConfig.rotationZ);
  if (assemblyParticles) assemblyParticles.visible = true;
  for (const glow of eyeGlowMeshes) glow.visible = false;
  assemblyUniforms.uProgress.value = 0;
  assemblyStartedAt = performance.now();
  flashStartedAt = null;
}

function prepareAssemblyFirstFrame() {
  if (!isEffectsLayer || !helmet || !assemblyRevealPending) return;
  helmet.visible = true;
  beginAssembly();
  updateScene(performance.now());
  renderer.render(scene, camera);
  window.jarvis.assemblyReady();
}

function updateAssembly(timestamp: number) {
  if (assemblyStartedAt !== null) {
    const elapsed = timestamp - assemblyStartedAt;
    const progress = Math.min(elapsed / modelConfig.assembleDuration, 1);
    assemblyUniforms.uProgress.value = progress;
    if (progress === 1) {
      assemblyUniforms.uProgress.value = 1;
      assemblyStartedAt = null;
      flashStartedAt = timestamp;
      currentEmissiveIntensity = modelConfig.assembleFlash;
      for (const glow of eyeGlowMeshes) glow.visible = true;
      if (assemblyParticles) assemblyParticles.visible = false;
    }
  }
}

function updateScene(timestamp: number) {
  currentLevel = interpolate(currentLevel, targetLevel);
  getStateTargets(timestamp);
  updateAssembly(timestamp);

  if (flashStartedAt !== null) {
    const flashProgress = Math.min((timestamp - flashStartedAt) / 250, 1);
    const flashTarget = THREE.MathUtils.lerp(modelConfig.assembleFlash, targetEmissiveIntensity, flashProgress);
    currentEmissiveIntensity = flashTarget;
    if (flashProgress === 1) flashStartedAt = null;
  } else {
    currentEmissiveIntensity = interpolate(currentEmissiveIntensity, targetEmissiveIntensity);
  }
  if (
    activeState === 'speaking' &&
    gestureAnimation === null &&
    timestamp >= nextSpeakingMotionAt
  ) {
    startSpeakingMotion(timestamp);
  }
  const gestureIsActive = updateGesture(timestamp);
  if (!gestureIsActive) {
    currentRotationX = interpolate(currentRotationX, targetRotationX);
    currentRotationY = interpolate(currentRotationY, targetRotationY);
  }

  if (helmetPivot) {
    helmetPivot.rotation.set(currentRotationX, currentRotationY, modelConfig.rotationZ);
    updateCutSpaceMatrix();
  }
  for (const material of emissiveMaterials) {
    material.emissiveIntensity = currentEmissiveIntensity
      * (emissiveIntensityScales.get(material) ?? 1);
  }
  openSourceEyeUniforms.uIntensity.value = currentEmissiveIntensity
    * (0.92 + Math.sin(timestamp * 0.0021) * 0.08);
}

function renderFrame(timestamp: number) {
  animationFrame = null;
  if (!isVisible) return;

  const frameInterval = assemblyStartedAt !== null || flashStartedAt !== null || gestureAnimation !== null
    ? 0
    : activeState === 'idle'
      ? 1000 / 12
      : 1000 / 30;

  if (timestamp - lastRenderAt >= frameInterval) {
    updateScene(timestamp);
    renderer.render(scene, camera);
    lastRenderAt = timestamp;
  }

  startRendering();
}

function startRendering() {
  if (isVisible && animationFrame === null) animationFrame = requestAnimationFrame(renderFrame);
}

function stopRendering() {
  if (animationFrame !== null) cancelAnimationFrame(animationFrame);
  animationFrame = null;
}

function loadModel() {
  const modelUrl = new URL(`../assets/helmet/${helmetModelFile}`, window.location.href).href;
  console.log(`[Jarvis] loading helmet model=${helmetModelFile}`);
  const dracoLoader = new DRACOLoader();
  dracoLoader.setDecoderPath('./draco/');
  const loader = new GLTFLoader();
  loader.setDRACOLoader(dracoLoader);
  loader.load(
    modelUrl,
    (gltf) => {
      helmet = gltf.scene;
      prepareOpenSourceEyeCarrier(helmet);
      const trimResult = frameModel(helmet);
      configureOpenSourceBrushedMetal(helmet);
      configureOpenSourceCyberMaterials(helmet);
      configureOpenSourceEyeSurface(helmet);
      collectEmissiveMaterials(helmet);
      createEyeGlowLayers(helmet);
      attachHelmetToPivot(helmet);
      if (isEffectsLayer) helmet.visible = false;
      resizeRenderer();
      updateAssemblyStartOffsets(helmet);
      createAssemblyParticles(helmet);
      const framing = positionCameraForHead();
      if (framing && trimResult) {
        const { center, size, cameraDistance } = framing;
        console.log(
          `[Jarvis] geometry trim trianglesBefore=${trimResult.trianglesBefore} trianglesAfter=${trimResult.trianglesAfter} ` +
            `cutY=${trimResult.cutY.toFixed(4)} headBounds center=(${center.x.toFixed(4)}, ${center.y.toFixed(4)}, ${center.z.toFixed(4)}) ` +
            `size=(${size.x.toFixed(4)}, ${size.y.toFixed(4)}, ${size.z.toFixed(4)}) cameraDistance=${cameraDistance.toFixed(4)}`
        );
      }
      // A wake request can arrive while the larger high-fidelity model is
      // still loading. Do not acknowledge the first assembly frame until the
      // real model has been dispersed and rendered behind the transparent DOM
      // layer; otherwise macOS can present either a blank or cached full head.
      if (assemblyRevealPending) window.setTimeout(prepareAssemblyFirstFrame, 0);
      dracoLoader.dispose();
    },
    undefined,
    (error) => {
      dracoLoader.dispose();
      console.error(`[Jarvis] Unable to load 3D model: ${modelUrl}`, error);
    }
  );
}

window.addEventListener('resize', resizeRenderer);
window.jarvis.onState((state) => {
  if (['idle', 'listening', 'thinking', 'speaking'].includes(state)) {
    const wasSpeaking = activeState === 'speaking';
    activeState = state as JarvisState;
    if (!wasSpeaking && activeState === 'speaking') {
      nextSpeakingMotionAt = performance.now() + randomBetween(180, 420);
    } else if (wasSpeaking && activeState !== 'speaking') {
      settleSpeakingMotion();
    }
  }
});
window.jarvis.onLevel((level) => {
  targetLevel = Math.min(1, Math.max(0, level));
});
window.jarvis.onVisible((visible) => {
  isVisible = visible;
  if (visible) {
    startRendering();
    if (assemblyRevealPending) {
      // Keep the DOM layer transparent through the native-window show and one
      // freshly rendered assembly frame. Only then reveal the dispersed model.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          if (!isVisible || !assemblyRevealPending) return;
          beginAssembly();
          updateScene(performance.now());
          renderer.render(scene, camera);
          stage.style.opacity = '1';
          assemblyRevealPending = false;
          window.dispatchEvent(new Event('jarvis:assembly-presented'));
          window.jarvis.assemblyPresented();
        });
      });
    }
  } else stopRendering();
});
window.jarvis.onAnchor((anchor) => {
  effectsAnchor = anchor;
  positionCameraForHead();
  if (helmet) {
    updateAssemblyStartOffsets(helmet);
    createAssemblyParticles(helmet);
  }
});
window.jarvis.onGesture((gesture) => startGesture(gesture));
window.jarvis.onAssemble(() => {
  if (!isEffectsLayer) return;
  stage.style.opacity = '0';
  assemblyRevealPending = true;
  if (helmet) helmet.visible = false;
  // Draw the dispersed first frame while the native overlay is still hidden.
  // The main process waits for assemblyReady before presenting the window.
  window.setTimeout(prepareAssemblyFirstFrame, 0);
});

window.addEventListener('jarvis:prepare-hide', () => {
  // Commit a transparent renderer frame before the native window is hidden,
  // so macOS has no complete-helmet surface available to flash on next show.
  assemblyRevealPending = false;
  stage.style.opacity = '0';
  if (helmet) helmet.visible = false;
  if (assemblyParticles) assemblyParticles.visible = false;
  renderer.render(scene, camera);
});

resizeRenderer();
loadModel();
startRendering();
