import {
  app,
  BrowserWindow,
  clipboard,
  globalShortcut,
  ipcMain,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  Menu,
  nativeImage,
  screen,
  session,
  shell,
  systemPreferences,
  Tray
} from 'electron';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { DoubaoVoiceTransport } from './doubao-voice-transport';
import { loadEnvironment } from './environment';
import os from 'node:os';
import { describeWeather, type WeatherCoordinates } from './weather';

// Coarse device location for weather. macOS attributes permission to the
// helper .app bundle, which shows its own purpose string.
//
// Cached for ten minutes: the helper takes a few seconds to run and a laptop
// does not move between two weather questions. A failed or denied lookup is
// cached as null for the same period so a denial does not re-prompt every ask —
// the weather tool then falls back to JARVIS_DEFAULT_CITY, exactly the old
// behaviour.
let coarseLocationCache: { at: number; value: WeatherCoordinates | null } | null = null;
let coarseLocationInFlight: Promise<WeatherCoordinates | null> | null = null;
const coarseLocationTtlMs = 10 * 60_000;

function getCoarseLocation(): Promise<WeatherCoordinates | null> {
  if (coarseLocationCache && Date.now() - coarseLocationCache.at < coarseLocationTtlMs) {
    return Promise.resolve(coarseLocationCache.value);
  }
  if (coarseLocationInFlight) return coarseLocationInFlight;

  coarseLocationInFlight = (async (): Promise<WeatherCoordinates | null> => {
    const locationApp = app.isPackaged
      ? path.join(process.resourcesPath, 'app.asar.unpacked/dist/native/JarvisLocation.app')
      : path.join(__dirname, '../native/JarvisLocation.app');
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'jarvis-location-'));
    const outputPath = path.join(temporaryRoot, 'coarse-location.json');
    try {
      await fs.writeFile(outputPath, '', { mode: 0o600 });
      await new Promise<void>((resolve, reject) => {
        execFile('/usr/bin/open', ['-W', '-n', '-g', '-o', outputPath, locationApp],
          { timeout: 35_000, maxBuffer: 8_192 },
          (error) => (error ? reject(error) : resolve()));
      });
      const raw = (await fs.readFile(outputPath, 'utf8')).trim();
      const result = JSON.parse(raw) as { success?: boolean; latitude?: number; longitude?: number; status?: string };
      if (result.success && Number.isFinite(result.latitude) && Number.isFinite(result.longitude)) {
        const value = { latitude: Number(result.latitude), longitude: Number(result.longitude) };
        log(`Coarse location resolved (~1km) for weather.`);
        coarseLocationCache = { at: Date.now(), value };
        return value;
      }
      log(`Coarse location unavailable (${result.status ?? 'unknown'}); weather falls back to the default city.`);
      coarseLocationCache = { at: Date.now(), value: null };
      return null;
    } catch (error) {
      log(`Coarse location failed: ${error instanceof Error ? error.message : String(error)}`);
      coarseLocationCache = { at: Date.now(), value: null };
      return null;
    } finally {
      await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => undefined);
      coarseLocationInFlight = null;
    }
  })();
  return coarseLocationInFlight;
}

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
type AvatarVisibilityMode = 'sleeping' | 'auto' | 'forced-visible' | 'forced-hidden';

const helmetSize = 480;
const hasSingleInstanceLock = app.requestSingleInstanceLock();
let jarvisWindow: BrowserWindow | null = null;
let voiceWindow: BrowserWindow | null = null;
let wakeEnrollmentWindow: BrowserWindow | null = null;
let appIsQuitting = false;
let tray: Tray | null = null;
let currentPersonalWakeMode: 'off' | 'shadow' | 'active' = 'off';
let awaitingAssemblyFrame = false;
let awaitingAssemblySound = false;
let assemblyRecoveryAttempts = 0;
let assemblyShowTimer: ReturnType<typeof setTimeout> | null = null;
let assemblySoundFallbackTimer: ReturnType<typeof setTimeout> | null = null;
let avatarVisibilityMode: AvatarVisibilityMode = 'sleeping';
let actionVisibilityGraceUntil = 0;
let clearDesktopChecks = 0;
let windowMonitorTimer: ReturnType<typeof setInterval> | null = null;
let windowMonitorInFlight = false;
let windowMonitorWarningLogged = false;
type AudioDiagnosticEntry = { at: string; summary: string };
let recentAudioDiagnostics: AudioDiagnosticEntry[] = [];
type VoiceEventEntry = { at: string; message: string };
let recentVoiceEvents: VoiceEventEntry[] = [];

app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

// Writing to stdout throws EIO once the launching terminal is gone, and an
// uncaught EIO in the main process kills the whole app. This happens whenever
// the app outlives the shell that started it, and always for a packaged .app
// launched from Finder. Console output is a convenience; the log file is the
// record. Never let the convenience take the process down.
function writeConsole(line: string) {
  try {
    console.log(line);
  } catch {
    // stdout is gone. Nothing to do and nothing worth reporting.
  }
}

function log(message: string) {
  const line = `[${new Date().toISOString()}] [Jarvis] ${message}`;
  writeConsole(line);
  const logPath = process.env.JARVIS_DEBUG_LOG || path.join(app.getPath('userData'), 'runtime.log');
  void fs.appendFile(logPath, `${line}\n`).catch(() => undefined);
}

const doubaoVoiceTransport = new DoubaoVoiceTransport(log);

async function persistAudioDiagnostic(summary: string) {
  const entry = { at: new Date().toISOString(), summary };
  recentAudioDiagnostics = [...recentAudioDiagnostics, entry].slice(-24);
  try {
    await fs.writeFile(
      path.join(app.getPath('userData'), 'audio-diagnostics.json'),
      JSON.stringify(recentAudioDiagnostics, null, 2),
      'utf8'
    );
  } catch (error) {
    console.warn('[Jarvis] Unable to persist audio diagnostics.', error);
  }
}

async function persistVoiceEvent(message: string) {
  const entry = { at: new Date().toISOString(), message };
  recentVoiceEvents = [...recentVoiceEvents, entry].slice(-80);
  try {
    await fs.writeFile(
      path.join(app.getPath('userData'), 'voice-events.json'),
      JSON.stringify(recentVoiceEvents, null, 2),
      'utf8'
    );
  } catch (error) {
    console.warn('[Jarvis] Unable to persist voice events.', error);
  }
}

function getHelmetAnchor() {
  const display = screen.getPrimaryDisplay();
  const overlayBounds = display.bounds;
  const workArea = display.workArea;
  return {
    x: workArea.x - overlayBounds.x + Math.round((workArea.width - helmetSize) / 2),
    y: workArea.y - overlayBounds.y + Math.round(workArea.height * 0.35 - helmetSize / 2),
    width: helmetSize,
    height: helmetSize
  };
}

function getVisualOverlayBounds() {
  return screen.getPrimaryDisplay().bounds;
}

function isTrustedVisualSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(jarvisWindow && event.sender === jarvisWindow.webContents);
}

function isTrustedVoiceSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(voiceWindow && event.sender === voiceWindow.webContents);
}

function isTrustedWakeEnrollmentSender(event: IpcMainEvent | IpcMainInvokeEvent) {
  return Boolean(wakeEnrollmentWindow && event.sender === wakeEnrollmentWindow.webContents);
}

function personalWakeModelPath() {
  return path.join(app.getPath('userData'), 'personal-wake-model.json');
}

function validatePersonalWakeModel(value: unknown) {
  if (!value || typeof value !== 'object') return false;
  const model = value as {
    version?: unknown;
    dimension?: unknown;
    threshold?: unknown;
    mode?: unknown;
    templates?: unknown;
  };
  const dimension = Number(model.dimension);
  return model.version === 1
    && Number.isInteger(dimension)
    && dimension > 0
    && dimension <= 4_096
    && Number.isFinite(Number(model.threshold))
    && ['off', 'shadow', 'active'].includes(String(model.mode))
    && Array.isArray(model.templates)
    && model.templates.length >= 3
    && model.templates.length <= 64
    && model.templates.every((template) =>
      Array.isArray(template)
      && template.length === dimension
      && template.every((entry) => Number.isFinite(entry))
    );
}

async function readPersonalWakeModel() {
  try {
    const raw = await fs.readFile(personalWakeModelPath(), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!validatePersonalWakeModel(parsed)) throw new Error('文件结构无效');
    return parsed;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'ENOENT') log(`Personal wake model unavailable: ${error instanceof Error ? error.message : String(error)}.`);
    return null;
  }
}

async function writePersonalWakeModel(model: unknown) {
  if (!validatePersonalWakeModel(model)) throw new Error('个人唤醒模型无效，未保存。');
  const serialized = JSON.stringify(model, null, 2);
  if (Buffer.byteLength(serialized, 'utf8') > 4_000_000) throw new Error('个人唤醒模型过大，未保存。');
  const target = personalWakeModelPath();
  const temporary = `${target}.tmp`;
  await fs.writeFile(temporary, serialized, { encoding: 'utf8', mode: 0o600 });
  await fs.rename(temporary, target);
  await fs.chmod(target, 0o600);
}

async function setPersonalWakeMode(mode: 'off' | 'shadow' | 'active') {
  const model = await readPersonalWakeModel();
  if (!model || !validatePersonalWakeModel(model)) {
    log('Personal wake mode was not changed because no enrolled model exists.');
    return;
  }
  const updated = {
    ...(model as Record<string, unknown>),
    mode,
    rescueMode: mode
  };
  await writePersonalWakeModel(updated);
  currentPersonalWakeMode = mode;
  sendToWindow(voiceWindow, 'jarvis:personal-wake-model-updated', updated);
  refreshTrayMenu();
  log(`Personal wake mode changed to ${mode}.`);
}

function sendToWindow(target: BrowserWindow | null, channel: string, ...args: unknown[]) {
  // A renderer can still emit its final IPC event while its paired overlay is
  // being torn down during quit/reload. Optional chaining alone is not enough:
  // Electron leaves the BrowserWindow reference present after webContents has
  // been destroyed, and calling .send() then crashes the main process.
  if (!target || target.isDestroyed() || target.webContents.isDestroyed()) return false;
  target.webContents.send(channel, ...args);
  return true;
}

function sendToVisual(channel: string, ...args: unknown[]) {
  return sendToWindow(jarvisWindow, channel, ...args);
}

function sendToVoiceCore(channel: string, ...args: unknown[]) {
  return sendToWindow(voiceWindow, channel, ...args);
}

function sendState(state: JarvisState) {
  sendToVisual('jarvis:state', state);
}

function sendLevel(level: number) {
  sendToVisual('jarvis:level', Math.min(1, Math.max(0, level)));
}

// Electron keeps the BrowserWindow reference alive after the window is
// destroyed, and every method on it — including read-only ones like
// isVisible() — throws "Object has been destroyed". A null check is therefore
// not enough anywhere a window outlives its renderer, which happens on quit,
// on reload, and whenever a renderer sends one last IPC message on its way out.
function liveWindow(target: BrowserWindow | null) {
  return target && !target.isDestroyed() ? target : null;
}

function showAvatar() {
  const window = liveWindow(jarvisWindow);
  if (!window) return;
  if (!window.isVisible()) window.showInactive();
  sendToVisual('jarvis:visible', true);
}

function hideAvatar() {
  const window = liveWindow(jarvisWindow);
  if (!window) return;
  sendToVisual('jarvis:visible', false);
  if (window.isVisible()) window.hide();
}

function resolveRuntimeResource(...segments: string[]) {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'dist', ...segments);
  }
  return path.join(__dirname, '..', ...segments);
}

function hasVisibleApplicationWindows() {
  const helperPath = resolveRuntimeResource('native', 'window-status');
  return new Promise<boolean>((resolve, reject) => {
    execFile(
      helperPath,
      [String(process.pid)],
      { timeout: 2_000, maxBuffer: 16_384 },
      (error, stdout) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(stdout.trim() === 'occupied');
      }
    );
  });
}

async function updateAvatarVisibility() {
  if (windowMonitorInFlight || avatarVisibilityMode === 'sleeping') return;
  if (avatarVisibilityMode === 'forced-visible') {
    showAvatar();
    return;
  }
  // Hidden on purpose. The visual window must stay absent even when a clear
  // macOS desktop is visible; the independent voice core
  // remains alive and can still hear a later “出来” request.
  if (avatarVisibilityMode === 'forced-hidden') return;
  windowMonitorInFlight = true;
  try {
    const occupied = await hasVisibleApplicationWindows();
    windowMonitorWarningLogged = false;
    if (occupied) {
      clearDesktopChecks = 0;
      hideAvatar();
      return;
    }
    if (Date.now() < actionVisibilityGraceUntil) return;
    clearDesktopChecks += 1;
    if (clearDesktopChecks >= 2) showAvatar();
  } catch (error) {
    if (!windowMonitorWarningLogged) {
      windowMonitorWarningLogged = true;
      console.error('[Jarvis] Unable to read visible application windows.', error);
    }
  } finally {
    windowMonitorInFlight = false;
  }
}

function startWindowMonitor() {
  if (windowMonitorTimer !== null) return;
  windowMonitorTimer = setInterval(() => void updateAvatarVisibility(), 800);
}

function stopWindowMonitor() {
  if (windowMonitorTimer !== null) clearInterval(windowMonitorTimer);
  windowMonitorTimer = null;
  windowMonitorInFlight = false;
  clearDesktopChecks = 0;
}

function showJarvisByVoiceRequest() {
  avatarVisibilityMode = 'forced-visible';
  clearDesktopChecks = 0;
  showAvatar();
}

/**
 * "隐藏" — out of the way, but still here and still listening.
 *
 * Deliberately not the same thing as ending the conversation. The visual
 * BrowserWindow is genuinely hidden so it also disappears over a completely
 * clear desktop. The independent voice window, live
 * provider session and microphone are untouched.
 *
 * The counterpart of `show_jarvis`, which is what brings it back to the front.
 */
function sendJarvisToBackByVoiceRequest() {
  avatarVisibilityMode = 'forced-hidden';
  clearDesktopChecks = 0;
  hideAvatar();
}

function hideJarvisForVisibleAction() {
  avatarVisibilityMode = 'auto';
  actionVisibilityGraceUntil = Date.now() + 1_600;
  clearDesktopChecks = 0;
  hideAvatar();
}

function playAssemblyEffect() {
  if (!jarvisWindow) return;
  if (assemblyShowTimer !== null) clearTimeout(assemblyShowTimer);
  if (assemblySoundFallbackTimer !== null) clearTimeout(assemblySoundFallbackTimer);
  awaitingAssemblyFrame = true;
  awaitingAssemblySound = true;
  assemblyRecoveryAttempts = 0;
  sendToVisual('jarvis:anchor', getHelmetAnchor());
  sendToVisual('jarvis:assemble');
  // The effects renderer confirms only after it has drawn the first frame
  // with the helmet split into pieces. This avoids presenting a stale cached
  // frame of the complete helmet.
  assemblyShowTimer = setTimeout(function recoverAssemblyRenderer() {
    if (!awaitingAssemblyFrame) return;
    assemblyRecoveryAttempts += 1;
    if (assemblyRecoveryAttempts === 1) {
      log('Assembly renderer missed its first-frame deadline; reloading only the visual window.');
      void persistVoiceEvent('Helmet visual watchdog reloaded an unresponsive renderer.');
      jarvisWindow?.webContents.reloadIgnoringCache();
      assemblyShowTimer = setTimeout(recoverAssemblyRenderer, 2_500);
      return;
    }
    log('Assembly renderer failed twice; keeping the desktop clear while voice remains online.');
    void persistVoiceEvent('Helmet visual watchdog gave up after two attempts; desktop remained interactive.');
    awaitingAssemblyFrame = false;
    awaitingAssemblySound = false;
    assemblyShowTimer = null;
    hideAvatar();
  }, 1_500);
}

function presentAssemblyWindow() {
  if (!awaitingAssemblyFrame) return;
  log('Helmet renderer supplied the dispersed first frame.');
  awaitingAssemblyFrame = false;
  assemblyRecoveryAttempts = 0;
  if (assemblyShowTimer !== null) clearTimeout(assemblyShowTimer);
  assemblyShowTimer = null;
  showAvatar();
  assemblySoundFallbackTimer = setTimeout(playPendingAssemblySound, 250);
}

function playAssemblySound() {
  const soundPath = resolveRuntimeResource('assets', 'sounds', 'assembly.wav');
  execFile('afplay', [soundPath], (error) => {
    if (error) console.error(`[${new Date().toISOString()}] [Jarvis] Unable to play assembly sound.`, error);
  });
}

function playPendingAssemblySound() {
  if (!awaitingAssemblySound) return;
  awaitingAssemblySound = false;
  if (assemblySoundFallbackTimer !== null) clearTimeout(assemblySoundFallbackTimer);
  assemblySoundFallbackTimer = null;
  playAssemblySound();
}

function handleWakeDetected() {
  log('Local wake word detected.');
  // A fresh “Hey Jarvis” wake-up always presents the avatar, even when other
  // application windows were already open. Automatic hiding begins only after
  // Jarvis performs a visible computer action such as opening an app or URL.
  avatarVisibilityMode = 'forced-visible';
  actionVisibilityGraceUntil = 0;
  clearDesktopChecks = 0;
  startWindowMonitor();
  playAssemblyEffect();
  sendState('listening');
}

function requireActionText(args: Record<string, unknown>, key: string, maximumLength = 2_000) {
  const value = args[key];
  if (typeof value !== 'string' || !value.trim() || value.length > maximumLength) {
    throw new Error(`操作参数 ${key} 无效。`);
  }
  return value.trim();
}

// Spoken app names are localized; AppleScript wants a bundle id. Only the names
// a user is likely to say out loud need to be here — anything unlisted falls
// through to the raw name, which works for apps whose display name is already
// their real name (Safari, Finder, most third-party apps).
const localizedAppBundleIds: Record<string, string> = {
  地图: 'com.apple.Maps',
  备忘录: 'com.apple.Notes',
  提醒事项: 'com.apple.reminders',
  日历: 'com.apple.iCal',
  邮件: 'com.apple.mail',
  信息: 'com.apple.MobileSMS',
  照片: 'com.apple.Photos',
  音乐: 'com.apple.Music',
  播客: 'com.apple.podcasts',
  图书: 'com.apple.iBooksX',
  股市: 'com.apple.stocks',
  天气: 'com.apple.weather',
  时钟: 'com.apple.clock',
  计算器: 'com.apple.calculator',
  词典: 'com.apple.Dictionary',
  预览: 'com.apple.Preview',
  访达: 'com.apple.finder',
  终端: 'com.apple.Terminal',
  系统设置: 'com.apple.systempreferences',
  文本编辑: 'com.apple.TextEdit',
  快捷指令: 'com.apple.shortcuts',
  语音备忘录: 'com.apple.VoiceMemos',
  通讯录: 'com.apple.AddressBook',
  电话: 'com.apple.mobilephone',
  查找: 'com.apple.findmy',
  家庭: 'com.apple.Home',
  无边记: 'com.apple.freeform',
  Safari浏览器: 'com.apple.Safari',
  微信: 'com.tencent.xinWeChat',
  抖音: 'com.ss.iphone.ugc.Aweme',
  腾讯会议: 'com.tencent.meeting',
  腾讯视频: 'com.tencent.tenvideo',
  爱奇艺: 'com.iqiyi.player',
  酷狗音乐: 'com.kugou.mac.Music',
  酷狗: 'com.kugou.mac.Music',
  // Users say all three of these; only the full name matches the app on disk,
  // so the short forms need their own entries rather than fuzzy matching.
  网易云音乐: 'com.netease.163music',
  网易云: 'com.netease.163music',
  网易音乐: 'com.netease.163music',
  QQ音乐: 'com.tencent.QQMusicMac',
  哔哩哔哩: 'com.bilibili.player.desktop',
  B站: 'com.bilibili.player.desktop'
};

function openApplication(applicationName: string) {
  return new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/open', ['-a', applicationName], (error) => {
      if (error) reject(new Error(`无法打开应用“${applicationName}”。`));
      else resolve();
    });
  });
}

type MusicApplication = 'kugou' | 'netease';
type MusicControlAction = 'play_pause' | 'next' | 'previous';

let lastMusicApplication: MusicApplication | null = null;
const musicRequestsInFlight = new Map<string, Promise<string>>();

const musicApplicationDetails: Record<MusicApplication, {
  bundleId: string;
  displayName: string;
  installedPaths: string[];
}> = {
  kugou: {
    bundleId: 'com.kugou.mac.Music',
    displayName: '酷狗音乐',
    installedPaths: ['/Applications/酷狗音乐.app', path.join(os.homedir(), 'Applications/酷狗音乐.app')]
  },
  netease: {
    bundleId: 'com.netease.163music',
    displayName: '网易云音乐',
    installedPaths: ['/Applications/NeteaseMusic.app', path.join(os.homedir(), 'Applications/NeteaseMusic.app')]
  }
};

function isMusicApplicationInstalled(applicationName: MusicApplication) {
  return musicApplicationDetails[applicationName].installedPaths.some((candidate) => existsSync(candidate));
}

function resolveMusicApplication(requested: unknown): MusicApplication {
  if (requested === 'kugou' || requested === 'netease') {
    if (!isMusicApplicationInstalled(requested)) {
      throw new Error(`没有检测到${musicApplicationDetails[requested].displayName}，请先安装后再试。`);
    }
    return requested;
  }
  if (lastMusicApplication && isMusicApplicationInstalled(lastMusicApplication)) return lastMusicApplication;
  if (isMusicApplicationInstalled('kugou')) return 'kugou';
  if (isMusicApplicationInstalled('netease')) return 'netease';
  throw new Error('没有检测到酷狗音乐或网易云音乐。');
}

function runAppleScript(script: string, args: string[], timeout = 12_000) {
  return new Promise<string>((resolve, reject) => {
    execFile(
      '/usr/bin/osascript',
      ['-e', script, ...args],
      { timeout, maxBuffer: 16_384, encoding: 'utf8' },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || stdout || error.message).trim();
          reject(new Error(detail || '音乐软件控制失败。'));
        } else {
          resolve(String(stdout).trim());
        }
      }
    );
  });
}

function openApplicationByBundleId(bundleId: string) {
  return new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/open', ['-b', bundleId], { timeout: 10_000 }, (error) => {
      if (error) reject(new Error('无法打开音乐软件。'));
      else resolve();
    });
  });
}

function snapshotClipboard() {
  return clipboard.availableFormats().map((format) => ({ format, data: clipboard.readBuffer(format) }));
}

function restoreClipboard(snapshot: Array<{ format: string; data: Buffer }>) {
  clipboard.clear();
  for (const item of snapshot) clipboard.writeBuffer(item.format, item.data);
}

async function playMusic(
  applicationName: MusicApplication,
  song: string,
  artist: string
) {
  if (process.platform !== 'darwin') throw new Error('音乐播放控制目前仅支持 macOS。');
  if (!systemPreferences.isTrustedAccessibilityClient(true)) {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    throw new Error('需要允许 Jarvis 控制电脑。我已打开“辅助功能”设置；启用 Jarvis 后，请再说一次播放歌曲。');
  }

  const details = musicApplicationDetails[applicationName];
  const query = artist ? `${song} ${artist}` : song;
  await openApplicationByBundleId(details.bundleId);
  if (applicationName === 'kugou') {
    const clipboardSnapshot = snapshotClipboard();
    clipboard.writeText(query);
    try {
      const script = [
        'on run',
        '  tell application "System Events"',
        '    tell process "酷狗音乐"',
        '      set frontmost to true',
        '      delay 0.45',
        '      set {windowX, windowY} to position of front window',
        '      set {windowWidth, windowHeight} to size of front window',
        '      if windowWidth < 900 or windowHeight < 600 then error "酷狗音乐窗口太小，请把窗口恢复到普通大小后再试。"',
        '      -- The left search pane is stable relative to the window even',
        '      -- when Kugou opens its optional artist panel on the right.',
        '      click at {windowX + 300, windowY + 64}',
        '      delay 0.12',
        '      keystroke "a" using command down',
        '      keystroke "v" using command down',
        '      key code 36',
        '      -- The first Return opens Kugou\'s search page; the second one',
        '      -- submits the query. A single Return only opens the app/search.',
        '      delay 0.55',
        '      key code 36',
        '      delay 1.8',
        '      -- An exact song-and-artist query puts the playable title first.',
        '      -- Click the title, not the adjacent add/MV buttons.',
        '      click at {windowX + 178, windowY + 318}',
        '      delay 0.8',
        '      return "played"',
        '    end tell',
        '  end tell',
        'end run'
      ].join('\n');
      await runAppleScript(script, [], 8_000);
    } catch (error) {
      log(`Kugou play failed for ${JSON.stringify(query)}: ${error instanceof Error ? error.message : String(error)}`);
      throw new Error(`酷狗没有切换到《${song}》，所以我没有报告播放成功。`);
    } finally {
      restoreClipboard(clipboardSnapshot);
    }
  } else {
    // NetEase Music deliberately exposes only its menu bar to macOS
    // accessibility. Search is therefore driven through the stable top-bar
    // and result-section offsets relative to its current window. The query is
    // pasted through the system clipboard so Chinese song names are reliable;
    // every clipboard format is restored immediately after the script exits.
    const clipboardSnapshot = snapshotClipboard();
    clipboard.writeText(query);
    try {
      const script = [
        'on run',
        '  tell application "System Events"',
        '    tell process "网易云音乐"',
        '      set frontmost to true',
        '      delay 0.55',
        '      set {windowX, windowY} to position of front window',
        '      set {windowWidth, windowHeight} to size of front window',
        '      if windowWidth < 700 or windowHeight < 500 then error "网易云音乐窗口太小，请把窗口恢复到普通大小后再试。"',
        '      click at {windowX + 405, windowY + 50}',
        '      delay 0.1',
        '      keystroke "a" using command down',
        '      keystroke "v" using command down',
        '      key code 36',
        '      delay 1.9',
        '      click at {windowX + 336, windowY + 336}',
        '      return "played"',
        '    end tell',
        '  end tell',
        'end run'
      ].join('\n');
      await runAppleScript(script, [], 12_000);
    } finally {
      restoreClipboard(clipboardSnapshot);
    }
  }
  lastMusicApplication = applicationName;
  return `已用${details.displayName}播放《${song}》${artist ? `，${artist}` : ''}。`;
}

async function controlMusic(applicationName: MusicApplication, action: MusicControlAction) {
  if (process.platform !== 'darwin') throw new Error('音乐播放控制目前仅支持 macOS。');
  if (!systemPreferences.isTrustedAccessibilityClient(true)) {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    throw new Error('需要允许 Jarvis 控制电脑。我已打开“辅助功能”设置；启用 Jarvis 后，请再试一次。');
  }

  const details = musicApplicationDetails[applicationName];
  await openApplicationByBundleId(details.bundleId);
  const menuName = applicationName === 'kugou' ? '播放控制' : '控制';
  const itemNames = action === 'next'
    ? [applicationName === 'kugou' ? '下一曲' : '下一个']
    : action === 'previous'
      ? [applicationName === 'kugou' ? '上一曲' : '上一个']
      : applicationName === 'kugou'
        ? ['播放/暂停']
        : ['暂停', '播放'];
  const script = [
    'on run argv',
    '  set processName to item 1 of argv',
    '  set menuName to item 2 of argv',
    '  set firstItemName to item 3 of argv',
    '  set secondItemName to item 4 of argv',
    '  tell application "System Events"',
    '    tell process processName',
    '      set frontmost to true',
    '      delay 0.25',
    '      set controlMenu to menu 1 of menu bar item menuName of menu bar 1',
    '      click menu bar item menuName of menu bar 1',
    '      delay 0.12',
    '      if exists menu item firstItemName of controlMenu then',
    '        click menu item firstItemName of controlMenu',
    '      else if secondItemName is not "" and exists menu item secondItemName of controlMenu then',
    '        click menu item secondItemName of controlMenu',
    '      else',
    '        key code 53',
    '        error "没有找到对应的播放控制。"',
    '      end if',
    '    end tell',
    '  end tell',
    'end run'
  ].join('\n');
  await runAppleScript(script, [details.displayName, menuName, itemNames[0], itemNames[1] ?? '']);
  lastMusicApplication = applicationName;
  return action === 'next'
    ? '已切换到下一首。'
    : action === 'previous'
      ? '已切换到上一首。'
      : '已切换播放或暂停。';
}

async function switchMacDesktop(destination: 'first' | 'second' | 'next' | 'previous') {
  if (process.platform !== 'darwin') throw new Error('切换桌面仅支持 macOS。');

  // This opens the native Accessibility permission prompt when Jarvis has not
  // yet been trusted. We intentionally check before sending any key event.
  if (!systemPreferences.isTrustedAccessibilityClient(true)) {
    await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
    throw new Error('需要允许 Jarvis 控制电脑。我已打开“辅助功能”设置；启用 Jarvis 后，请再说一次切换桌面。');
  }

  // "First" and "second" are absolute, so they cannot be expressed as one
  // keystroke: walk all the way to the leftmost Space first, then step right
  // once for the second. Twelve steps covers any plausible number of Spaces.
  const script = destination === 'second' || destination === 'first'
    ? [
        'tell application "System Events"',
        '  repeat 12 times',
        '    key code 123 using control down',
        '    delay 0.06',
        '  end repeat',
        ...(destination === 'second' ? ['  key code 124 using control down'] : []),
        'end tell'
      ].join('\n')
    : [
        'tell application "System Events"',
        `  key code ${destination === 'previous' ? '123' : '124'} using control down`,
        'end tell'
      ].join('\n');

  await new Promise<void>((resolve, reject) => {
    execFile('/usr/bin/osascript', ['-e', script], { timeout: 5_000 }, (error) => {
      if (error) {
        reject(new Error('Jarvis 还需要获得“自动化”权限来控制 System Events。请在系统设置的“隐私与安全性 → 自动化”中允许 Jarvis，然后重试。'));
      } else {
        resolve();
      }
    });
  });

  return destination === 'second'
    ? '已切换到第二个桌面。'
    : destination === 'previous'
      ? '已切换到上一个桌面。'
      : '已切换到下一个桌面。';
}

const guanlanProjectRoot = process.env.GUANLAN_PROJECT_ROOT?.trim()
  || path.join(os.homedir(), 'Documents', '股票');
const guanlanDatabasePath = process.env.GUANLAN_DATABASE_PATH?.trim()
  || path.join(guanlanProjectRoot, 'data', 'guanlan.db');

async function queryGuanlan(question: string) {
  if (!existsSync(guanlanProjectRoot)) {
    throw new Error(`没有找到观澜项目：${guanlanProjectRoot}`);
  }
  if (!existsSync(guanlanDatabasePath)) {
    throw new Error(`没有找到观澜数据库：${guanlanDatabasePath}`);
  }

  const virtualEnvironmentPython = path.join(guanlanProjectRoot, '.venv', 'bin', 'python');
  const python = existsSync(virtualEnvironmentPython) ? virtualEnvironmentPython : '/usr/bin/python3';
  const sourceRoot = path.join(guanlanProjectRoot, 'src');
  const result = await new Promise<string>((resolve, reject) => {
    execFile(
      python,
      ['-m', 'stock_app.voice_query', '--question', question, '--database', guanlanDatabasePath],
      {
        cwd: guanlanProjectRoot,
        env: {
          ...process.env,
          PYTHONPATH: process.env.PYTHONPATH
            ? `${sourceRoot}${path.delimiter}${process.env.PYTHONPATH}`
            : sourceRoot
        },
        timeout: 15_000,
        maxBuffer: 256_000
      },
      (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message).trim().slice(0, 500);
          reject(new Error(`观澜查询失败：${detail}`));
          return;
        }
        resolve(String(stdout).trim());
      }
    );
  });

  let payload: unknown;
  try {
    payload = JSON.parse(result);
  } catch {
    throw new Error('观澜返回了无法解析的数据。');
  }
  if (!payload || typeof payload !== 'object' || (payload as { ok?: unknown }).ok !== true) {
    throw new Error('观澜没有返回有效的查询结果。');
  }
  log(`Guanlan read-only query completed: ${JSON.stringify(question.slice(0, 80))}`);
  return JSON.stringify(payload);
}

async function executeComputerAction(name: string, rawArgs: unknown) {
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {};
  switch (name) {
    case 'get_current_time': {
      const now = new Date();
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const formatted = new Intl.DateTimeFormat('zh-CN', {
        dateStyle: 'full',
        timeStyle: 'medium',
        timeZone
      }).format(now);
      return `当前 Mac 系统时间：${formatted}；时区：${timeZone}。`;
    }
    case 'show_jarvis': {
      showJarvisByVoiceRequest();
      return 'Ashley 已现身。';
    }
    case 'send_jarvis_back': {
      sendJarvisToBackByVoiceRequest();
      return '已隐藏，随时听候。';
    }
    case 'open_url': {
      const url = new URL(requireActionText(args, 'url'));
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('只能打开 HTTP 或 HTTPS 网页。');
      hideJarvisForVisibleAction();
      await shell.openExternal(url.href);
      return `已打开网页：${url.href}`;
    }
    case 'get_weather': {
      // Returns a finished sentence rather than data. The voice model reads it
      // out unchanged, so the phrasing lives here where it can be tuned.
      //
      // No city named → try the device's coarse location first, so "我这里的
      // 天气" answers for where the user actually is. Denied or unavailable
      // location falls back to the configured default city.
      const requestedCity = typeof args.city === 'string' ? args.city.trim() : '';
      const coordinates = requestedCity ? null : await getCoarseLocation();
      // The model has been caught inventing a city argument, which silently
      // overrides both device location and the default. Record which source
      // actually answered, so 北京-out-of-nowhere is attributable in one look.
      log(
        `Weather lookup source: ${requestedCity
          ? `model-supplied city ${JSON.stringify(requestedCity)}`
          : coordinates
            ? `device location ${coordinates.latitude},${coordinates.longitude}`
            : 'default city'}`
      );
      return describeWeather(args.city, args.include_tomorrow === true, coordinates);
    }
    case 'query_guanlan': {
      const question = requireActionText(args, 'question', 500);
      return queryGuanlan(question);
    }
    case 'get_directions': {
      const destination = requireActionText(args, 'destination', 200);
      const origin = typeof args.origin === 'string' ? args.origin.trim() : '';
      // Without an explicit origin, use the device's coarse position so that
      // "怎么去某某" plans from where the user actually is. search_maps only
      // ever dropped a pin on the destination with no route at all.
      const from = origin || (await getCoarseLocation().then(
        (c) => (c ? `${c.latitude},${c.longitude}` : '')
      ));
      const mode = args.mode === 'walking' ? 'w' : args.mode === 'transit' ? 'r' : 'd';
      const url = new URL('https://maps.apple.com/');
      if (from) url.searchParams.set('saddr', from);
      url.searchParams.set('daddr', destination);
      url.searchParams.set('dirflg', mode);
      hideJarvisForVisibleAction();
      await shell.openExternal(url.href);
      return from
        ? `已规划到${destination}的路线。`
        : `已打开到${destination}的路线，但没能确定你的位置，请在地图里填起点。`;
    }
    case 'search_web': {
      const query = requireActionText(args, 'query', 500);
      hideJarvisForVisibleAction();
      await shell.openExternal(`https://www.google.com/search?q=${encodeURIComponent(query)}`);
      return `已搜索：${query}`;
    }
    case 'search_maps': {
      const query = requireActionText(args, 'query', 500);
      hideJarvisForVisibleAction();
      await shell.openExternal(`https://maps.apple.com/?q=${encodeURIComponent(query)}`);
      return `已在地图中搜索：${query}`;
    }
    case 'open_application': {
      const applicationName = requireActionText(args, 'application', 100);
      hideJarvisForVisibleAction();
      await openApplication(applicationName);
      return `已打开应用：${applicationName}`;
    }
    case 'play_music': {
      const song = requireActionText(args, 'song', 200);
      const artist = typeof args.artist === 'string' ? args.artist.trim().slice(0, 100) : '';
      const applicationName = resolveMusicApplication(args.application);
      const requestKey = `${applicationName}\u0000${song}\u0000${artist}`;
      const existingRequest = musicRequestsInFlight.get(requestKey);
      if (existingRequest) return existingRequest;
      hideJarvisForVisibleAction();
      const request = playMusic(applicationName, song, artist);
      musicRequestsInFlight.set(requestKey, request);
      try {
        return await request;
      } finally {
        // Seeduplex sometimes emits its real tool call only a few milliseconds
        // after the deterministic spoken-command fallback fires. Keep the
        // settled promise briefly so both calls share one app action (and one
        // permission prompt) instead of searching/playing the same song twice.
        setTimeout(() => {
          if (musicRequestsInFlight.get(requestKey) === request) {
            musicRequestsInFlight.delete(requestKey);
          }
        }, 2_000);
      }
    }
    case 'control_music': {
      const action = args.action;
      if (action !== 'play_pause' && action !== 'next' && action !== 'previous') {
        throw new Error('音乐控制指令无效。');
      }
      const applicationName = resolveMusicApplication(args.application);
      hideJarvisForVisibleAction();
      return controlMusic(applicationName, action);
    }
    case 'close_application': {
      const applicationName = requireActionText(args, 'application', 100);
      // `open -a` accepts the localized name a Chinese speaker actually says,
      // but AppleScript's `tell application "地图"` does not — it resolves by
      // the app's real name or bundle id, so every localized Apple app failed
      // to close while opening them worked fine.
      const bundleId = localizedAppBundleIds[applicationName.replace(/\s/g, '')];
      // A graceful AppleScript quit, not a kill: the app gets to save state and
      // ask about unsaved work. The name goes in as an argument, never spliced
      // into the script text, so a spoken name cannot inject script.
      const quitScript = bundleId
        ? ['-e', 'on run argv', '-e', 'tell application id (item 1 of argv) to quit', '-e', 'end run', bundleId]
        : ['-e', 'on run argv', '-e', 'tell application (item 1 of argv) to quit', '-e', 'end run', applicationName];
      await new Promise<void>((resolve, reject) => {
        execFile(
          '/usr/bin/osascript',
          quitScript,
          { timeout: 10_000, maxBuffer: 4_096 },
          (error) => (error ? reject(new Error(`无法关闭“${applicationName}”，它可能没有在运行。`)) : resolve())
        );
      });
      return `已关闭：${applicationName}`;
    }
    case 'switch_desktop': {
      const destination =
        args.destination === 'next' || args.destination === 'previous' || args.destination === 'first'
          ? args.destination
          : 'second';
      hideJarvisForVisibleAction();
      return switchMacDesktop(destination);
    }
    case 'write_text_file': {
      const folder = args.folder;
      if (folder !== 'desktop' && folder !== 'documents') throw new Error('文件只能新建在桌面或文稿目录。');
      const requestedName = requireActionText(args, 'file_name', 128);
      if (requestedName !== path.basename(requestedName) || /[\\/:\0]/.test(requestedName) || requestedName.includes('..')) {
        throw new Error('文件名无效。');
      }
      const fileName = path.extname(requestedName) ? requestedName : `${requestedName}.txt`;
      const content = requireActionText(args, 'content', 100_000);
      const destination = path.join(app.getPath(folder), fileName);
      try {
        await fs.writeFile(destination, content, { encoding: 'utf8', flag: 'wx' });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new Error(`文件“${fileName}”已存在，因此没有覆盖。`);
        }
        throw error;
      }
      return `已在${folder === 'desktop' ? '桌面' : '文稿'}中新建文件“${fileName}”。`;
    }
    default:
      throw new Error(`不支持的电脑操作：${name}`);
  }
}

// Written for Seeduplex rather than adapted from the OpenAI text.
//
// Three deliberate differences, each from observed failures:
//
//   Short lines, not prose. The OpenAI version is one long paragraph carrying
//   twenty tools' worth of conditions. Doubao loses the middle of it.
//
//   Positive triggers, not prohibitions. "绝不能" and "不得" appear constantly
//   in the OpenAI text and Doubao largely ignores them, so the rules here say
//   what to do rather than what not to do.
//
//   The exit rule comes first and is stated twice. Failing to exit is the one
//   error the user cannot recover from by talking, since the way out is the
//   thing that broke.
const doubaoInstructions = [
  '你是 Ashley，运行在用户 Mac 上的语音管家；内部工程名仍为 Jarvis。声音成熟、低沉、克制。',
  '',
  '最重要的规则：调用工具时，先调用，再说话。工具调用本身就是回应。',
  '',
  '绝对不要把工具名念出来。get_weather、end_conversation、show_jarvis 这些是内部代号，',
  '不是给人听的话。不要说「正在调用」「我来调用某某工具」「使用天气接口」这类旁白。',
  '调用工具的那一轮可以完全不说话，直接调用即可。等工具返回结果，再用一句自然的中文说出来。',
  '',
  '【立即调用工具的说法】',
  '用户说「退下」「退下吧」「拜拜」「再见」「没事了」「好了」「先这样」「不用了」「结束」「休眠」：调用 end_conversation。不要先说再见，调用就是告别。',
  '用户单独说「Ashley」「艾希莉」「艾什莉」「阿什利」「Jarvis」「贾维斯」，或说「出来」「现身」「回来」：调用 show_jarvis。',
  '用户说「隐藏」「藏起来」「让开」「别挡着」「遮住了」「退到后面」：调用 send_jarvis_back。这会真正隐藏头盔视觉窗口，但语音和对话继续在线；不是休眠、不是结束对话、更不是退出程序。',
  '用户说「完全退出」「关闭程序」「退出程序」：调用 quit_jarvis。',
  '用户问时间、几点、今天几号、星期几：调用 get_current_time。',
  '用户问天气、气温、冷不冷、要不要带伞：调用 get_weather，然后原样念出它返回的那句话。',
  '不说城市名时也调用 get_weather，不要传 city，它会用默认城市。',
  '「我这里」「我所在的位置」「当前位置」的天气，同样直接调用 get_weather，不要传 city。',
  '只要用户表达的大意是在问观澜中的持仓、股票、市场、候选股、预警、交易日志、账户、AI 会审或数据状态，就调用 query_guanlan；不要求固定句式、完整术语或一字不差。',
  '上一轮正在谈观澜时，用户自然追问「那持仓呢」「有没有风险」「候选有哪些」这类省略说法，也继续调用 query_guanlan。把用户实际说出的意思放进 question，只根据工具返回的数据回答。',
  '',
  '【不许编理由】',
  '不要说「我没有权限」「我获取不到」「我无法访问」这类话，除非你真的调用了工具并且它返回了错误。',
  '不确定能不能做的事，先调用工具试，让工具的返回结果来回答，不要自己先下结论。',
  '用户说打开某个软件：调用 open_application。',
  '用户说用酷狗或网易云播放某首歌：调用 play_music，先执行再简短确认，不要只口头答应。',
  '用户说播放暂停、上一首或下一首：调用 control_music；没点名软件时沿用上次播放的软件。',
  '用户说关闭某个软件，例如「关掉抖音」「把微信关了」：调用 close_application。',
  '只有用户明确要关闭 Jarvis 自己（「完全退出」「关闭 Jarvis」）才用 quit_jarvis，关闭其他应用一律用 close_application。',
  '用户说切换桌面、第一个桌面、第二个桌面、上一个下一个桌面：调用 switch_desktop，不要先解释。',
  '用户说搜索、查一下、打开某个网页：调用 search_web 或 open_url。',
  '用户说怎么去某地、到某地怎么走、导航到某地、离某地多远：调用 get_directions，不要传 origin，会自动用当前位置。',
  '用户只是想看某个地方在哪、不要路线：调用 search_maps。',
  '用户说打开、启动、显示观澜，或把观澜切到最前面：调用 open_application，application 填「观澜」。这是应用窗口操作，不要调用 query_guanlan。',
  '用户说关闭、退出观澜：调用 close_application，application 填「观澜」。这是关闭观澜应用，不是关闭 Jarvis，不要调用 quit_jarvis 或 query_guanlan。',
  '用户说点头、摇头：调用 perform_head_gesture。',
  '用户说转个圈、转一圈、旋转、转起来：调用 rotate_helmet，方向用 spin。你的头盔可以转，不要说自己不能转。',
  '',
  '【判断退出时要谨慎】',
  '只有用户明确表达结束的意思才调用 end_conversation。',
  '用户打断你、纠正你、换个话题、说「等一下」「不是」「我是说」，这些都不是结束，继续对话。',
  '',
  '【说话方式】',
  '这一节决定你像不像一个管家，比音色更重要。',
  '',
  '直接给结论，不铺垫。问什么答什么，答完就停。',
  '一般问题一到两句话。用户说「详细讲讲」「展开说」时才展开。',
  '',
  '不要说这些开场：',
  '「好的，没问题」「当然可以」「这是一个好问题」「让我来帮你看看」',
  '「我明白了」「收到」「明白您的意思」',
  '直接说答案本身。',
  '',
  '不要说这些结尾：',
  '「希望对你有帮助」「还有什么需要我帮忙的吗」「随时叫我」',
  '「你觉得怎么样」「需要我再详细说说吗」',
  '说完就停，不追问。',
  '',
  '少用语气词：呢、呀、哦、啦、嘛、哈、~。',
  '少用感叹号。陈述句为主。',
  '不夸用户，不评价用户的问题好不好。',
  '不说「正在思考」「稍等」「让我想想」这类拖延语。',
  '',
  '称呼用「你」。需要时可以用「先生」，但不要每句都带。',
  '做完一件事，用最短的话陈述结果：例如「已打开」「已经在放了」「二十三度，多云」。',
  '做不到的事直接说做不到，一句话，不解释也不道歉。'
].join('\n');

function getRealtimeSessionConfig() {
  return {
    type: 'realtime',
    model: 'gpt-realtime-2.1-mini',
    // Everyday replies use Realtime's native streaming audio so that speech
    // begins while the answer is still being generated.
    output_modalities: ['audio'],
    // This is a safety net against a runaway answer, not a length policy.
    //
    // It used to be 160, which is roughly 8-10 seconds of speech. Any question
    // that deserved a real answer hit the cap and the reply stopped mid-word,
    // with clean network stats and no error — indistinguishable from a bug
    // until response.done started reporting
    // `status=incomplete reason=max_output_tokens`.
    //
    // Brevity belongs in the instructions, where the model can end a sentence
    // properly. Keep this high enough that reaching it is always abnormal.
    //
    // Measured: 160 truncated after roughly one sentence; 1200 got within a few
    // characters of finishing an explicit "give me at least eight points"
    // answer. 4000 leaves real headroom for that worst case while still
    // bounding a runaway response to a couple of minutes of speech.
    max_output_tokens: 4_000,
    parallel_tool_calls: false,
    reasoning: { effort: 'low' },
    audio: {
      input: {
        turn_detection: {
          // Simple voice commands should close quickly and deterministically.
          // Semantic VAD can wait for more meaning even after the user has
          // already finished a short command.
          type: 'server_vad',
          threshold: 0.52,
          prefix_padding_ms: 300,
          silence_duration_ms: 360,
          create_response: true,
          // The renderer owns interruption. Letting both the server and the
          // renderer cancel audio can clip the final syllable or start a
          // second response when speaker echo is mistaken for user speech.
          interrupt_response: false
        }
      },
      output: {
        // Latency comes from streaming, not a faster speaking rate.
        voice: 'cedar',
        speed: 1
      }
    },
    tools: [
      {
        type: 'function',
        name: 'get_current_time',
        description: '读取这台 Mac 当前准确的本地日期、星期、时间和时区。用户问现在几点、当前时间、今天日期或星期几时必须立即调用；这是本地只读操作，不需要额外系统权限。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'get_weather',
        description:
          '查询实时天气并口头回答。用户问天气、气温、冷不冷、热不热、要不要加衣服、要不要带伞、明天天气如何时必须调用这个工具，绝不能改用 search_web 打开浏览器让用户自己看。返回的是一句可以直接念出来的话，收到后原样念给用户，不要改写或补充。',
        parameters: {
          type: 'object',
          properties: {
            city: {
              type: 'string',
              description:
                '只有当用户在这句话里亲口说出了城市名才填，例如用户说「上海天气」就填上海。用户没有说出任何城市名时必须留空，绝对不能自己猜一个城市填进来——留空会自动使用用户的真实位置。'
            },
            include_tomorrow: {
              type: 'boolean',
              description: '用户问到明天或未来天气时为 true，只问当前天气时为 false。'
            }
          },
          required: [],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'query_guanlan',
        description:
          '只读查询本机观澜股票分析系统。只要用户表达的大意是在询问观澜的持仓、某只股票、市场温度、候选股、预警、交易日志、模拟或实盘账户、换手成本、双 AI 会审、时点意见或数据健康状态，就调用；无需固定口令、标准术语或一字不差。上一轮正在谈观澜时，省略“观澜”名称的自然追问也调用。用户要求打开、启动、显示、关闭观澜或把观澜切到最前面时不要调用本工具，必须调用对应的应用操作工具。结果只用于播报，不会执行交易。',
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: '按用户实际表达记录其关于观澜的查询意图；保留已经说出的股票名称、代码、日期、账户类型和比较条件，不要求用户补齐未说出的术语。'
            }
          },
          required: ['question'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'end_conversation',
        description: '当用户说普通“退出”、结束对话、先这样、没事了、退下、退下吧、拜拜、再见、不用了、休眠或待机时，必须立即直接调用。调用前不得说话或生成任何语音。结束当前语音会话，但 Jarvis 继续在后台监听下一次唤醒。用户说“完全退出”“退出程序”“关闭程序”或明确要求关闭 Jarvis 应用时，绝不能调用此工具，必须调用 quit_jarvis。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'quit_jarvis',
        description: '当用户明确说“完全退出”“彻底退出”“完全退出 Jarvis”“退出 Jarvis 程序”“退出程序”“关闭 Jarvis”“关闭 Jarvis 程序”“关闭程序”或同等明确表述时，必须立即直接调用。单独说“完全退出”已经足够明确。调用后应用进程会立即关闭，不能说话、解释或确认。普通“退出”才使用 end_conversation。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'perform_head_gesture',
        description:
          '当用户明确命令 Jarvis 点头、点点头、摇头或摇摇头时立即调用。nod 表示自然点头，shake 表示自然摇头。用户只是在询问“你会不会点头/摇头”时不要擅自动作，但要如实回答支持这些动作。',
        parameters: {
          type: 'object',
          properties: {
            gesture: {
              type: 'string',
              enum: ['nod', 'shake'],
              description: 'nod 为点头；shake 为摇头。'
            }
          },
          required: ['gesture'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'rotate_helmet',
        description:
          '仅当用户明确要求头盔转动、顺时针或逆时针转一圈、展示正面、背面、左侧或右侧时调用。禁止自行调用，禁止在组装完成后自动旋转。',
        parameters: {
          type: 'object',
          properties: {
            view: {
              type: 'string',
              enum: ['spin', 'front', 'back', 'left', 'right'],
              description: 'spin 为完整转一圈并回到当前朝向；其余值分别展示正面、背面、左侧和右侧。'
            },
            direction: {
              type: 'string',
              enum: ['clockwise', 'counterclockwise', 'random'],
              description: '仅在 view 为 spin 时使用。用户指定顺时针或逆时针时必须照做；没有指定时使用 random。'
            }
          },
          required: ['view'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'show_jarvis',
        description:
          '在已经唤醒的会话中，用户单独说“Ashley”“艾希莉”“艾什莉”“阿什利”“Jarvis”“贾维斯”，或明确要求你现身、出来、显示头盔时，必须立即调用。Ashley 是当前形象的名字；此指令不是休眠指令，不能只用语音口头回应。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'send_jarvis_back',
        description:
          '用户说“隐藏”“藏起来”“让开”“别挡着”“退到后面”“遮住了”时立即调用。头盔视觉窗口会完全隐藏，但语音和对话继续在线；不是休眠也不是退出。要恢复时用 show_jarvis。',
        parameters: { type: 'object', properties: {}, additionalProperties: false }
      },
      {
        type: 'function',
        name: 'switch_desktop',
        description: '切换 macOS 桌面（Spaces）。用户要求切换到第一个桌面、第二个桌面、上一个桌面或下一个桌面，或只说“切换桌面”时直接调用。它会先检查 Jarvis 的辅助功能与自动化授权。',
        parameters: {
          type: 'object',
          properties: {
            destination: {
              type: 'string',
              enum: ['first', 'second', 'next', 'previous'],
              description: 'first 表示第一个桌面；second 表示第二个桌面；next 和 previous 分别表示相邻桌面。只说“切换桌面”时用 next。'
            }
          },
          required: ['destination'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'open_url',
        description: '打开用户明确指定的 HTTP 或 HTTPS 网页。',
        parameters: {
          type: 'object',
          properties: { url: { type: 'string', description: '要打开的完整网页地址。' } },
          required: ['url'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'search_web',
        description: '使用默认浏览器搜索用户指定的内容。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '搜索关键词。' } },
          required: ['query'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'search_maps',
        description: '使用 Apple 地图搜索地点、地址、商家或路线目的地。',
        parameters: {
          type: 'object',
          properties: { query: { type: 'string', description: '地点或地址。' } },
          required: ['query'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'open_application',
        description: '打开用户明确点名的 macOS 应用，或把已经运行的应用切到最前面。用户说打开、启动、显示观澜或把观澜切到最前面时，application 填“观澜”。',
        parameters: {
          type: 'object',
          properties: { application: { type: 'string', description: '应用名称，例如 Safari、备忘录或微信。' } },
          required: ['application'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'play_music',
        description:
          '在酷狗音乐或网易云音乐中搜索并立即播放用户指定的歌曲。用户说「用酷狗放一首晴天」「网易云播放周杰伦的晴天」「放首歌听」时调用；必须实际调用，不能只口头答应。',
        parameters: {
          type: 'object',
          properties: {
            song: { type: 'string', description: '歌曲名称。' },
            artist: { type: 'string', description: '歌手名称；用户没有说时留空。' },
            application: {
              type: 'string',
              enum: ['auto', 'kugou', 'netease'],
              description: '用户点名酷狗时用 kugou，点名网易云时用 netease；没点名时用 auto。'
            }
          },
          required: ['song', 'application'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'control_music',
        description:
          '控制酷狗音乐或网易云音乐的播放状态。用户说暂停、继续播放、上一首或下一首时调用。没点名软件时使用 auto，自动沿用上次播放的软件。',
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['play_pause', 'next', 'previous'],
              description: '播放或暂停用 play_pause，下一首用 next，上一首用 previous。'
            },
            application: {
              type: 'string',
              enum: ['auto', 'kugou', 'netease'],
              description: '用户点名酷狗时用 kugou，点名网易云时用 netease；没点名时用 auto。'
            }
          },
          required: ['action', 'application'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'get_directions',
        description:
          '规划从用户当前位置到某地的路线并在地图中打开。用户说「怎么去某某」「到某某怎么走」「导航到某某」「从这里到某某多远」时调用。只是想看某个地方在哪、不需要路线时才用 search_maps。',
        parameters: {
          type: 'object',
          properties: {
            destination: { type: 'string', description: '目的地名称或地址。' },
            origin: {
              type: 'string',
              description: '起点。用户亲口说了起点才填；没说就留空，会自动使用用户的当前位置。'
            },
            mode: {
              type: 'string',
              enum: ['driving', 'walking', 'transit'],
              description: '出行方式，默认驾车。'
            }
          },
          required: ['destination'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'close_application',
        description:
          '关闭用户明确点名的某个 macOS 应用，例如「关掉抖音」「把微信关了」「关闭观澜」。只用于关闭其他应用；关闭观澜时 application 填“观澜”，用户要求关闭 Jarvis 自己时才改用 quit_jarvis。',
        parameters: {
          type: 'object',
          properties: { application: { type: 'string', description: '要关闭的应用名称，例如 抖音、微信、Safari。' } },
          required: ['application'],
          additionalProperties: false
        }
      },
      {
        type: 'function',
        name: 'write_text_file',
        description: '在桌面或文稿目录新建文本文件。不能覆盖已有文件。',
        parameters: {
          type: 'object',
          properties: {
            folder: { type: 'string', enum: ['desktop', 'documents'], description: '保存目录。' },
            file_name: { type: 'string', description: '文件名；未写扩展名时自动使用 .txt。' },
            content: { type: 'string', description: '写入文件的文本内容。' }
          },
          required: ['folder', 'file_name', 'content'],
          additionalProperties: false
        }
      }
    ],
    tool_choice: 'auto',
    truncation: {
      type: 'retention_ratio',
      retention_ratio: 0.8,
      token_limits: { post_instructions: 8000 }
    },
    instructions:
      '你是运行在用户 Mac 上的 Ashley 语音入口；内部工程名仍为 Jarvis。声音表达成熟、低沉、克制、清晰，语速自然，中文咬字清楚，不模仿任何真人或影视角色。一般回答控制在两三句话，用户明确要求展开时再详细说明，并始终说完整句子。不要说“正在思考”“稍等”之类拖延语。天气问题必须调用 get_weather 并原样朗读结果；观澜相关问题调用 query_guanlan，只依据返回数据回答并说明数据时间、缺失或过期状态，不提供自动买卖指令。时间问题调用 get_current_time；酷狗或网易云播放调用 play_music，播放控制调用 control_music；桌面切换调用 switch_desktop。无法由内置工具可靠完成的操作直接简洁说明。用户单独说“Ashley”“艾希莉”“艾什莉”“阿什利”“Jarvis”“贾维斯”或要求现身时调用 show_jarvis。明确要求完全退出程序时调用 quit_jarvis；普通告别、休眠或待机调用 end_conversation，调用前不要说话。用户明确命令点头、摇头或转动时调用对应头部动作工具。'
  };
}

function getVoiceProviderSessionConfig() {
  // Tools and voice are single-sourced across providers. Instructions are not.
  //
  // The OpenAI wording is a single dense block that has been tuned over many
  // sessions and behaves reliably there. Seeduplex does not follow it the same
  // way: in one recorded session it called end_conversation when the user had
  // not asked to leave, and in the next it called nothing at all while the user
  // repeatedly said 拜拜 and Jarvis. Same prompt, same model, thirty seconds
  // apart.
  //
  // So the Doubao build gets its own phrasing rather than a rewrite that would
  // put the working OpenAI path at risk.
  const realtime = getRealtimeSessionConfig();
  const provider = process.env.JARVIS_VOICE_PROVIDER?.trim().toLowerCase();
  return {
    tools: realtime.tools,
    instructions: provider === 'doubao' ? doubaoInstructions : realtime.instructions,
    // The Doubao session was being handed "cedar" — an OpenAI voice name that
    // Volcengine does not recognise, so it silently fell back to a default and
    // the configured doubaoVoice was never used. Each provider gets a voice id
    // from its own catalogue, and the Doubao one is an environment variable so
    // that auditioning a different timbre is a restart rather than a rebuild.
    // Seeduplex has its own voice catalogue, separate from Volcengine's regular
    // TTS voices — an id from the wrong list is silently ignored.
    // 成熟总裁 was chosen by ear. Override with DOUBAO_VOICE to audition others.
    voice: provider === 'doubao'
      ? (process.env.DOUBAO_VOICE?.trim() || 'saturn_zh_male_chengshuzongcai_tob')
      : realtime.audio.output.voice,
    language: 'zh-CN',
    inputAudio: {
      format: 'pcm_s16le',
      sampleRate: 16_000,
      channels: 1
    },
    outputAudio: {
      format: 'pcm_s16le',
      sampleRate: 24_000,
      channels: 1
    }
  };
}

async function createRealtimeCall(sdp: string) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY 未配置。');
  if (!sdp.startsWith('v=0') || sdp.length > 200_000) throw new Error('Realtime SDP 无效。');

  const form = new FormData();
  form.set('sdp', sdp);
  form.set('session', JSON.stringify(getRealtimeSessionConfig()));
  const safetyIdentifier = createHash('sha256').update(app.getPath('userData')).digest('hex');
  const response = await fetch('https://api.openai.com/v1/realtime/calls', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'OpenAI-Safety-Identifier': safetyIdentifier
    },
    body: form
  });
  const answer = await response.text();
  if (!response.ok) throw new Error(`Realtime API ${response.status}: ${answer}`);
  log('Realtime Mini WebRTC session connected.');
  return answer;
}

function registerIpcHandlers() {
  ipcMain.on('jarvis:wake-enrollment-command', (event, command: unknown) => {
    if (!isTrustedWakeEnrollmentSender(event) || !['start', 'capture', 'cancel'].includes(String(command))) return;
    sendToWindow(voiceWindow, 'jarvis:wake-enrollment-command', command);
  });
  ipcMain.on('jarvis:wake-enrollment-update', (event, update: unknown) => {
    if (!isTrustedVoiceSender(event)) return;
    sendToWindow(wakeEnrollmentWindow, 'jarvis:wake-enrollment-update', update);
  });
  ipcMain.handle('jarvis:personal-wake-model-get', async (event) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的个人唤醒模型请求。');
    return readPersonalWakeModel();
  });
  ipcMain.handle('jarvis:personal-wake-model-save', async (event, model: unknown) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的个人唤醒模型写入请求。');
    await writePersonalWakeModel(model);
    currentPersonalWakeMode = (model as { mode: 'off' | 'shadow' | 'active' }).mode;
    refreshTrayMenu();
    log(`Personal wake model saved locally in ${currentPersonalWakeMode} mode.`);
  });
  ipcMain.on('jarvis:wake-detected', (event) => {
    if (isTrustedVoiceSender(event)) handleWakeDetected();
  });
  ipcMain.on('jarvis:assembly-ready', (event) => {
    if (!isTrustedVisualSender(event) || !awaitingAssemblyFrame) return;
    presentAssemblyWindow();
  });
  ipcMain.on('jarvis:assembly-presented', (event) => {
    if (!isTrustedVisualSender(event)) return;
    playPendingAssemblySound();
    sendToVoiceCore('jarvis:assembly-presented-notification');
  });
  ipcMain.on('jarvis:conversation-ended', (event) => {
    if (!isTrustedVoiceSender(event)) return;
    awaitingAssemblyFrame = false;
    awaitingAssemblySound = false;
    assemblyRecoveryAttempts = 0;
    if (assemblyShowTimer !== null) clearTimeout(assemblyShowTimer);
    if (assemblySoundFallbackTimer !== null) clearTimeout(assemblySoundFallbackTimer);
    assemblyShowTimer = null;
    assemblySoundFallbackTimer = null;
    sendLevel(0);
    sendState('idle');
    avatarVisibilityMode = 'sleeping';
    stopWindowMonitor();
    hideAvatar();
  });
  ipcMain.on('jarvis:state-report', (event, state: JarvisState) => {
    if (!isTrustedVoiceSender(event)) return;
    if (['idle', 'listening', 'thinking', 'speaking'].includes(state)) sendState(state);
  });
  ipcMain.on('jarvis:level-report', (event, level: number) => {
    if (isTrustedVoiceSender(event) && Number.isFinite(level)) sendLevel(level);
  });
  ipcMain.on('jarvis:gesture-report', (event, gesture: JarvisGesture) => {
    if (!isTrustedVoiceSender(event)) return;
    if (
      [
        'turn',
        'nod',
        'shake',
        'spin',
        'spin-clockwise',
        'spin-counterclockwise',
        'face-front',
        'face-back',
        'face-left',
        'face-right'
      ].includes(gesture)
    ) {
      sendToVisual('jarvis:gesture', gesture);
    }
  });
  ipcMain.on('jarvis:audio-diagnostic', (event, summary: unknown) => {
    if (!isTrustedVoiceSender(event) || typeof summary !== 'string' || summary.length > 1_000) return;
    void persistAudioDiagnostic(summary);
  });
  ipcMain.on('jarvis:voice-event', (event, message: unknown) => {
    if (!isTrustedVoiceSender(event) || typeof message !== 'string' || message.length > 1_000) return;
    void persistVoiceEvent(message);
  });
  ipcMain.handle('jarvis:voice-session-config', (event) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的语音会话配置请求。');
    return getVoiceProviderSessionConfig();
  });
  ipcMain.handle('jarvis:doubao-connect', async (event) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的豆包语音连接请求。');
    return doubaoVoiceTransport.connect(event.sender);
  });
  ipcMain.on('jarvis:doubao-send', (event, payload: unknown) => {
    if (!isTrustedVoiceSender(event) || typeof payload !== 'string') return;
    if (!doubaoVoiceTransport.send(payload)) {
      log('Dropped a Doubao voice event because its WebSocket was not open or the event was too large.');
    }
  });
  ipcMain.on('jarvis:doubao-close', (event) => {
    if (isTrustedVoiceSender(event)) doubaoVoiceTransport.close();
  });
  ipcMain.handle('jarvis:realtime-connect', async (event, sdp: string) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的 Realtime 请求。');
    return createRealtimeCall(sdp);
  });
  ipcMain.handle('jarvis:execute-action', async (event, name: string, args: unknown) => {
    if (!isTrustedVoiceSender(event)) throw new Error('不受信任的电脑操作请求。');
    log(`Executing voice action: ${name}.`);
    return executeComputerAction(name, args);
  });
  ipcMain.on('jarvis:quit', (event) => {
    if (!isTrustedVoiceSender(event)) return;
    log('Quitting by explicit voice request.');
    app.quit();
  });
}

function createJarvisWindow() {
  jarvisWindow = new BrowserWindow({
    ...getVisualOverlayBounds(),
    transparent: true,
    backgroundColor: '#00000000',
    frame: false,
    hasShadow: false,
    alwaysOnTop: true,
    focusable: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hiddenInMissionControl: true,
    skipTaskbar: true,
    show: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });

  // The visual renderer needs a full-screen transparent surface so assembly
  // fragments can travel beyond the 480px helmet anchor. It remains a pure
  // click-through overlay: it cannot receive focus or intercept desktop input,
  // and the independent voice core stays alive if this renderer is reloaded.
  jarvisWindow.setAlwaysOnTop(true, 'floating');
  jarvisWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  jarvisWindow.setIgnoreMouseEvents(true, { forward: true });
  jarvisWindow.on('show', () => sendToVisual('jarvis:visible', true));
  jarvisWindow.on('hide', () => sendToVisual('jarvis:visible', false));
  jarvisWindow.webContents.on('console-message', (event) => {
    const { message } = event;
    if (message.startsWith('[Jarvis]')) log(message.slice('[Jarvis]'.length).trim());
  });
  jarvisWindow.webContents.on('unresponsive', () => {
    log('Helmet renderer became unresponsive; hiding and reloading only the visual window.');
    hideAvatar();
    jarvisWindow?.webContents.reloadIgnoringCache();
  });
  jarvisWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`Helmet renderer exited (${details.reason}); the independent voice core remains online.`);
    hideAvatar();
  });
  jarvisWindow.webContents.on('did-finish-load', () => {
    sendToVisual('jarvis:anchor', getHelmetAnchor());
    sendState('idle');
    if (awaitingAssemblyFrame) sendToVisual('jarvis:assemble');
    if (process.env.JARVIS_VISUAL_QA === '1') {
      setTimeout(() => playAssemblyEffect(), 750);
      setTimeout(async () => {
        const target = liveWindow(jarvisWindow);
        if (!target || target.webContents.isDestroyed()) return;
        const image = await target.webContents.capturePage();
        await fs.writeFile(
          process.env.JARVIS_QA_CAPTURE_PATH || '/private/tmp/jarvis-visual-qa.png',
          image.toPNG()
        );
        log('Visual QA capture written.');
        setTimeout(() => app.quit(), 100);
      }, Math.min(8_500, Math.max(900, Number(process.env.JARVIS_QA_CAPTURE_MS) || 8_500)));
    }
  });
  jarvisWindow.loadFile(
    path.join(__dirname, '../renderer/effects.html'),
    process.env.JARVIS_VISUAL_QA === '1'
      ? {
          query: {
            qa: '1',
            lighting: process.env.JARVIS_QA_LIGHTING ?? 'symmetric'
          }
        }
      : undefined
  );
}

function createVoiceWindow() {
  voiceWindow = new BrowserWindow({
    width: 1,
    height: 1,
    x: -10_000,
    y: -10_000,
    show: false,
    focusable: false,
    skipTaskbar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  voiceWindow.webContents.on('console-message', (event) => {
    const { message } = event;
    if (message.startsWith('[Jarvis]')) log(`[VoiceCore] ${message.slice('[Jarvis]'.length).trim()}`);
  });
  voiceWindow.webContents.on('render-process-gone', (_event, details) => {
    log(`Voice core exited (${details.reason}); restarting it without touching the desktop.`);
    voiceWindow = null;
    if (!appIsQuitting) createVoiceWindow();
  });
  voiceWindow.on('closed', () => {
    doubaoVoiceTransport.close();
    voiceWindow = null;
  });
  voiceWindow.loadFile(path.join(__dirname, '../renderer/voice.html'));
}

function toggleJarvisWindow() {
  const window = liveWindow(jarvisWindow);
  if (!window) return;
  if (window.isVisible()) window.hide();
  else window.showInactive();
}

function openWakeEnrollmentWindow() {
  const existing = liveWindow(wakeEnrollmentWindow);
  if (existing) {
    existing.show();
    existing.focus();
    return;
  }
  wakeEnrollmentWindow = new BrowserWindow({
    width: 560,
    height: 570,
    title: 'Ashley 专属唤醒录入',
    backgroundColor: '#05090d',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js')
    }
  });
  wakeEnrollmentWindow.on('closed', () => {
    sendToWindow(voiceWindow, 'jarvis:wake-enrollment-command', 'cancel');
    wakeEnrollmentWindow = null;
  });
  wakeEnrollmentWindow.webContents.on('did-finish-load', () => {
    const capturePath = process.env.JARVIS_WAKE_ENROLLMENT_CAPTURE_PATH?.trim();
    if (!capturePath) return;
    setTimeout(async () => {
      const target = liveWindow(wakeEnrollmentWindow);
      if (!target) return;
      const image = await target.webContents.capturePage();
      await fs.writeFile(capturePath, image.toPNG());
      log(`Wake enrollment QA capture written to ${capturePath}.`);
    }, 800);
  });
  wakeEnrollmentWindow.loadFile(path.join(__dirname, '../renderer/wake-enrollment.html'));
}

function refreshTrayMenu() {
  if (!tray) return;
  const modeName = currentPersonalWakeMode === 'active'
    ? '已启用'
    : currentPersonalWakeMode === 'shadow'
      ? '观察模式'
      : '原方案';
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '显示/隐藏', click: toggleJarvisWindow },
      { label: '录入 Ashley 唤醒声纹…', click: openWakeEnrollmentWindow },
      {
        label: `专属唤醒：${modeName}`,
        submenu: [
          {
            label: '关闭个人验证（恢复原方案）',
            type: 'radio',
            checked: currentPersonalWakeMode === 'off',
            click: () => void setPersonalWakeMode('off')
          },
          {
            label: '观察模式（不拦截召唤）',
            type: 'radio',
            checked: currentPersonalWakeMode === 'shadow',
            click: () => void setPersonalWakeMode('shadow')
          },
          {
            label: '启用 Ashley 独立召唤',
            type: 'radio',
            checked: currentPersonalWakeMode === 'active',
            click: () => void setPersonalWakeMode('active')
          }
        ]
      },
      { type: 'separator' },
      { label: '退出', click: () => app.quit() }
    ])
  );
}

function createTrayIcon() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '../assets/tray/iconTemplate.png'));
  icon.setTemplateImage(true);
  tray = new Tray(icon);
  tray.setToolTip('Ashley');
  refreshTrayMenu();
}

// Belt and braces for the same class of failure as writeConsole(): a broken
// stdout/stderr pipe surfaces as an EPIPE/EIO stream error rather than a throw
// at the call site, and an unhandled one still terminates the process. Anything
// that is not a dead-pipe error is left alone so real crashes stay visible.
function isBrokenPipeError(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'EPIPE' || code === 'EIO';
}

process.stdout.on('error', (error) => {
  if (!isBrokenPipeError(error)) throw error;
});
process.stderr.on('error', (error) => {
  if (!isBrokenPipeError(error)) throw error;
});

if (!hasSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const window = liveWindow(jarvisWindow);
    if (window?.isVisible()) window.focus();
  });

  app.whenReady().then(async () => {
    loadEnvironment();
    const configuredVoiceProvider = process.env.JARVIS_VOICE_PROVIDER?.trim().toLowerCase() || 'openai';
    const configuredVoice = process.env.DOUBAO_VOICE?.trim() || '(provider default)';
    const voiceFallback = process.env.JARVIS_ALLOW_VOICE_FALLBACK === '1' ? 'allowed' : 'blocked';
    const doubaoCredentials = process.env.DOUBAO_APP_ID?.trim() && process.env.DOUBAO_API_KEY?.trim()
      ? 'present'
      : 'missing';
    log(
      `Voice configuration loaded: provider=${configuredVoiceProvider}, voice=${configuredVoice}, `
      + `fallback=${voiceFallback}, doubaoCredentials=${doubaoCredentials}.`
    );
    app.dock?.hide();
    registerIpcHandlers();
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(permission === 'media' && (
        webContents === voiceWindow?.webContents || webContents === jarvisWindow?.webContents
      ));
    });
    createJarvisWindow();
    if (process.env.JARVIS_VISUAL_QA !== '1') createVoiceWindow();
    screen.on('display-metrics-changed', () => {
      jarvisWindow?.setBounds(getVisualOverlayBounds());
      sendToVisual('jarvis:anchor', getHelmetAnchor());
    });
    const storedPersonalWakeModel = await readPersonalWakeModel();
    currentPersonalWakeMode = validatePersonalWakeModel(storedPersonalWakeModel)
      ? (storedPersonalWakeModel as { mode: 'off' | 'shadow' | 'active' }).mode
      : 'off';
    createTrayIcon();
    if (process.env.JARVIS_OPEN_WAKE_ENROLLMENT === '1') {
      setTimeout(openWakeEnrollmentWindow, 500);
    }
    globalShortcut.register('CommandOrControl+Shift+J', toggleJarvisWindow);
    if (process.platform === 'darwin') {
      void systemPreferences.askForMediaAccess('microphone').then((granted) => {
        log(`Microphone permission ${granted ? 'granted' : 'denied'}.`);
      });
    }
  });
}

app.on('will-quit', () => {
  appIsQuitting = true;
  doubaoVoiceTransport.close();
  stopWindowMonitor();
  globalShortcut.unregisterAll();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
