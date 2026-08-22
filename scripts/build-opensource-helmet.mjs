import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  dedup,
  getBounds,
  prune,
  simplify,
  textureCompress,
  weld
} from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(scriptDirectory, '..');
const cliArguments = process.argv.slice(2).filter((argument) => argument !== '--');
const inputPath = cliArguments[0];
const outputPath = cliArguments[1]
  ?? path.join(projectRoot, 'assets', 'helmet', 'model.glb');
const targetTriangles = Number(cliArguments[2] ?? 40_000);

if (!inputPath) {
  throw new Error(
    'Usage: node scripts/build-opensource-helmet.mjs <source.glb> [output.glb] [targetTriangles]'
  );
}

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
const document = await io.read(inputPath);
const root = document.getRoot();
const scene = root.listScenes()[0];
if (!scene) throw new Error('The source model does not contain a scene.');

function countTriangles() {
  let total = 0;
  for (const mesh of root.listMeshes()) {
    for (const primitive of mesh.listPrimitives()) {
      const positions = primitive.getAttribute('POSITION');
      if (!positions) continue;
      total += (primitive.getIndices()?.getCount() ?? positions.getCount()) / 3;
    }
  }
  return Math.round(total);
}

const sourceTriangles = countTriangles();
if (!sourceTriangles) throw new Error('The source model contains no triangles.');

const sourceTextures = root.listTextures().length;
const materialRecipes = new Map([
  ['phong1SG', {
    name: 'OpenSourceCyberCyanDetails',
    baseColor: [0.004, 0.16, 0.17, 1],
    metallic: 0.88,
    roughness: 0.26,
    emissive: [0.002, 0.25, 0.27]
  }],
  ['phong2SG', {
    name: 'OpenSourceGunmetalDark',
    baseColor: [0.006, 0.008, 0.014, 1],
    metallic: 0.9,
    roughness: 0.38,
    emissive: [0, 0, 0]
  }],
  ['phong3SG', {
    name: 'OpenSourceGunmetalBrushed',
    baseColor: [0.014, 0.018, 0.028, 1],
    metallic: 0.96,
    roughness: 0.31,
    emissive: [0, 0, 0]
  }],
  ['phong4SG', {
    name: 'OpenSourceGunmetalPanels',
    baseColor: [0.025, 0.03, 0.042, 1],
    metallic: 0.94,
    roughness: 0.35,
    emissive: [0, 0, 0]
  }],
  ['phong5SG', {
    name: 'OpenSourceCyberPinkDetails',
    baseColor: [0.2, 0.004, 0.065, 1],
    metallic: 0.84,
    roughness: 0.27,
    emissive: [0.28, 0.002, 0.075]
  }]
]);

for (const material of root.listMaterials()) {
  const recipe = materialRecipes.get(material.getName());
  if (!recipe) continue;
  material
    .setName(recipe.name)
    .setBaseColorFactor(recipe.baseColor)
    .setMetallicFactor(recipe.metallic)
    .setRoughnessFactor(recipe.roughness)
    .setEmissiveFactor(recipe.emissive);
}

const ratio = Math.min(1, Math.max(0.01, targetTriangles / sourceTriangles));
await document.transform(
  dedup(),
  weld({ tolerance: 0.00001 }),
  simplify({
    simplifier: MeshoptSimplifier,
    ratio,
    error: 0.006,
    lockBorder: false
  })
);

await document.transform(
  prune(),
  textureCompress({
    encoder: sharp,
    targetFormat: 'webp',
    resize: [2048, 2048],
    lossless: false,
    quality: 88,
    effort: 80
  })
);

const outputTriangles = countTriangles();
const bounds = getBounds(scene);
const size = bounds.max.map((value, axis) => value - bounds.min[axis]);
const maximumEdge = Math.max(...size);
const scale = [1 / maximumEdge, 0.92 / maximumEdge, 1 / maximumEdge];
const framingBounds = {
  min: bounds.min.map((value, axis) => value * scale[axis]),
  max: bounds.max.map((value, axis) => value * scale[axis])
};
const framingSize = framingBounds.max.map((value, axis) => value - framingBounds.min[axis]);
const centerX = (framingBounds.min[0] + framingBounds.max[0]) / 2;

scene.setExtras({
  ...scene.getExtras(),
  jarvisPretrimmed: {
    scale,
    cutProfile: {
      baseY: framingBounds.min[1],
      centerX,
      halfWidth: framingSize[0] / 2,
      centerDrop: 0,
      flatFraction: 1
    },
    framingBounds,
    triangles: outputTriangles
  },
  credits: {
    title: 'Sci-Fi Helmet - High Poly - Ngchipv',
    author: 'HiepVu',
    license: 'CC BY 4.0',
    source: 'https://sketchfab.com/3d-models/sci-fi-helmet-high-poly-ngchipv-2f7218f88b94455cb69411e4069dc3b9'
  }
});

await io.write(outputPath, document);

console.log(
  `[Jarvis] open-source helmet written: ${outputPath} `
  + `triangles=${sourceTriangles}->${outputTriangles} `
  + `textures=${sourceTextures}->${root.listTextures().length} `
  + `bounds=${JSON.stringify(bounds)}`
);
