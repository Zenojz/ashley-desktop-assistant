import { app } from 'electron';
import fs from 'node:fs';
import path from 'node:path';

function readOwnedSetting(filePath: string, name: string) {
  if (!fs.existsSync(filePath)) return null;
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = fs.readFileSync(filePath, 'utf8').match(
    new RegExp(`^\\s*(?:export\\s+)?${escaped}\\s*=\\s*(.*?)\\s*$`, 'm')
  );
  if (!match) return null;
  const value = match[1].trim();
  if (
    (value.startsWith('"') && value.endsWith('"'))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value.replace(/\s+#.*$/, '').trim();
}

export function loadEnvironment() {
  const projectEnvironment = path.join(app.getAppPath(), '.env');
  const userEnvironment = path.join(app.getPath('userData'), '.env');
  const candidates = [
    projectEnvironment,
    userEnvironment
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) process.loadEnvFile(candidate);
  }

  // Provider identity and voice are app-owned settings, not transient shell
  // overrides. A later launch inherited JARVIS_VOICE_PROVIDER=openai from its
  // parent even though the project's .env still said doubao; process.loadEnvFile
  // intentionally does not overwrite inherited values, so that launch silently
  // changed both the model and the voice. Pin these non-secret selections to
  // the project file while leaving credentials on Node's normal env precedence.
  const ownedEnvironment = fs.existsSync(projectEnvironment)
    ? projectEnvironment
    : userEnvironment;
  for (const name of [
    'JARVIS_VOICE_PROVIDER',
    'DOUBAO_VOICE',
    'JARVIS_ALLOW_VOICE_FALLBACK'
  ]) {
    const value = readOwnedSetting(ownedEnvironment, name);
    if (value) process.env[name] = value;
  }
}
