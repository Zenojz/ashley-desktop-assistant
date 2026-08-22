const path = require('node:path');
const esbuild = require('esbuild');

const entryPoints = {
  app: path.join(__dirname, '..', 'src', 'renderer', 'app.ts'),
  voice: path.join(__dirname, '..', 'src', 'renderer', 'voice-host.ts'),
  'wake-enrollment': path.join(__dirname, '..', 'src', 'renderer', 'wake-enrollment.ts'),
  'voice-pcm-worklet': path.join(__dirname, '..', 'src', 'renderer', 'voice-pcm-worklet.ts')
};

esbuild.buildSync({
  entryPoints,
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: 'chrome120',
  outdir: path.join(__dirname, '..', 'dist', 'renderer')
});
