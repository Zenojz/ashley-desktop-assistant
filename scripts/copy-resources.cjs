const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const projectRoot = path.join(__dirname, '..');
const distRoot = path.join(projectRoot, 'dist');

const nativeDestination = path.join(distRoot, 'native');
fs.rmSync(nativeDestination, { recursive: true, force: true });
if (process.platform === 'darwin') {
  fs.mkdirSync(nativeDestination, { recursive: true });
  execFileSync('/usr/bin/swiftc', [
    '-O',
    path.join(projectRoot, 'src', 'native', 'window-status.swift'),
    '-o',
    path.join(nativeDestination, 'window-status')
  ]);

  // macOS grants location permission per app bundle, so the coarse location
  // helper must be a real .app with its own
  // Info.plist rather than a bare binary.
  const locationAppRoot = path.join(nativeDestination, 'JarvisLocation.app', 'Contents');
  const locationExecutableRoot = path.join(locationAppRoot, 'MacOS');
  fs.mkdirSync(locationExecutableRoot, { recursive: true });
  execFileSync('/usr/bin/swiftc', [
    '-O',
    path.join(projectRoot, 'src', 'native', 'location.swift'),
    '-framework',
    'CoreLocation',
    '-o',
    path.join(locationExecutableRoot, 'JarvisLocation')
  ]);
  fs.copyFileSync(
    path.join(projectRoot, 'src', 'native', 'location-helper-info.plist'),
    path.join(locationAppRoot, 'Info.plist')
  );
}

for (const directory of ['renderer', 'assets']) {
  const source = path.join(projectRoot, directory === 'renderer' ? 'src' : '', directory);
  const destination = path.join(distRoot, directory);

  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, {
    recursive: true,
    filter: (entry) => {
      if (directory === 'renderer') return !entry.endsWith('.ts');
      return path.basename(entry) !== 'model.original.glb';
    }
  });
}

fs.cpSync(
  path.join(projectRoot, 'node_modules', 'three', 'examples', 'jsm', 'libs', 'draco'),
  path.join(distRoot, 'renderer', 'draco'),
  { recursive: true }
);

const wakePackageRoot = path.dirname(require.resolve('openwakeword-wasm-browser/package.json'));
const wakeDestination = path.join(distRoot, 'assets', 'wake-word');
const wakeModelDestination = path.join(wakeDestination, 'models');
fs.mkdirSync(wakeModelDestination, { recursive: true });
for (const file of [
  'melspectrogram.onnx',
  'embedding_model.onnx',
  'silero_vad.onnx',
  'hey_jarvis_v0.1.onnx'
]) {
  fs.copyFileSync(path.join(wakePackageRoot, 'models', file), path.join(wakeModelDestination, file));
}

const ortEntry = require.resolve('onnxruntime-web', { paths: [wakePackageRoot] });
const ortDestination = path.join(wakeDestination, 'ort');
fs.mkdirSync(ortDestination, { recursive: true });
for (const file of [
  'ort-wasm-simd-threaded.jsep.mjs',
  'ort-wasm-simd-threaded.jsep.wasm',
  'ort-wasm-simd-threaded.wasm'
]) {
  fs.copyFileSync(path.join(path.dirname(ortEntry), file), path.join(ortDestination, file));
}
