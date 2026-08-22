import { spawnSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.join(scriptDirectory, '..');
const soundsDirectory = path.join(projectRoot, 'assets', 'sounds');
const promptsDirectory = path.join(soundsDirectory, 'thinking-prompts');

mkdirSync(promptsDirectory, { recursive: true });

function runFfmpeg(argumentsList) {
  const result = spawnSync(
    'ffmpeg',
    ['-hide_banner', '-loglevel', 'error', '-y', ...argumentsList],
    { stdio: 'inherit' }
  );

  if (result.error?.code === 'ENOENT') {
    throw new Error('ffmpeg was not found. Install it and run this script again.');
  }
  if (result.status !== 0) {
    throw new Error(`ffmpeg failed with exit code ${result.status ?? 'unknown'}.`);
  }
}

runFfmpeg([
  '-f', 'lavfi',
  '-i', 'aevalsrc=(0.24*sin(2*PI*(620*t+520*t*t))+0.12*sin(2*PI*(930*t+300*t*t)))*exp(-6.5*t):s=48000:d=0.48',
  '-af', 'highpass=f=180,lowpass=f=5000,afade=t=out:st=0.36:d=0.12,alimiter=limit=0.8',
  '-c:a', 'pcm_s16le',
  path.join(soundsDirectory, 'wake.wav')
]);

runFfmpeg([
  '-f', 'lavfi',
  '-i', 'aevalsrc=0.12*sin(2*PI*(65*t+92*t*t))*(0.45+0.55*sin(2*PI*3.2*t)*sin(2*PI*3.2*t))+0.07*sin(2*PI*(185*t+240*t*t))+0.035*sin(2*PI*780*t)*exp(-0.9*t):s=48000:d=2.6',
  '-af', 'highpass=f=35,lowpass=f=5200,aecho=0.8:0.5:24|47:0.16|0.08,afade=t=in:st=0:d=0.04,afade=t=out:st=2.38:d=0.22,alimiter=limit=0.78',
  '-t', '2.6',
  '-c:a', 'pcm_s16le',
  path.join(soundsDirectory, 'assembly.wav')
]);

const baseFrequencies = [48, 52, 56, 60, 64, 68, 72, 76, 80, 84];
const pulseRates = [1.55, 1.7, 1.85, 2, 2.15, 2.3, 1.65, 1.95, 2.2, 2.45];

for (let index = 0; index < baseFrequencies.length; index += 1) {
  const frequency = baseFrequencies[index];
  const pulseRate = pulseRates[index];
  const fileName = `${String(index + 1).padStart(2, '0')}.mp3`;
  const source = [
    `0.2*sin(2*PI*${frequency}*t)`,
    `*(0.16+0.84*pow(0.5+0.5*sin(2*PI*${pulseRate}*t)\\,4))`,
    `+0.045*sin(2*PI*${(frequency * 2.02).toFixed(2)}*t)`
  ].join('');

  runFfmpeg([
    '-f', 'lavfi',
    '-i', `aevalsrc=${source}:s=48000:d=2.0`,
    '-af', 'highpass=f=25,lowpass=f=280,afade=t=in:st=0:d=0.08,afade=t=out:st=1.75:d=0.25,alimiter=limit=0.75',
    '-c:a', 'libmp3lame',
    '-b:a', '128k',
    path.join(promptsDirectory, fileName)
  ]);
}

console.log(`[Jarvis] generated clean sound assets in ${soundsDirectory}`);
