import { contextBridge, ipcRenderer } from 'electron';

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

type VoiceProviderSelection = {
  requestedName: string;
  selectedName: 'openai' | 'doubao';
  fallbackReason: string | null;
};

type DoubaoTransportState =
  | { type: 'disconnected'; code: number; reason: string }
  | { type: 'failed'; message: string };

function getVoiceProviderSelection(): VoiceProviderSelection {
  const requestedName = process.env.JARVIS_VOICE_PROVIDER?.trim().toLowerCase() || 'openai';
  if (requestedName !== 'doubao') {
    return { requestedName, selectedName: 'openai', fallbackReason: null };
  }
  const missing = [
    !process.env.DOUBAO_APP_ID?.trim() ? 'DOUBAO_APP_ID' : '',
    !process.env.DOUBAO_API_KEY?.trim() ? 'DOUBAO_API_KEY' : ''
  ].filter(Boolean);
  if (missing.length > 0) {
    if (process.env.JARVIS_ALLOW_VOICE_FALLBACK !== '1') {
      return {
        requestedName,
        selectedName: 'doubao',
        fallbackReason: `豆包语音配置缺失 ${missing.join('、')}，已禁止静默切换到 OpenAI。`
      };
    }
    return {
      requestedName,
      selectedName: 'openai',
      fallbackReason: `豆包语音配置缺失 ${missing.join('、')}，已按显式配置回退到 OpenAI。`
    };
  }
  return { requestedName, selectedName: 'doubao', fallbackReason: null };
}

contextBridge.exposeInMainWorld('jarvis', {
  onState(callback: (state: string) => void) {
    ipcRenderer.on('jarvis:state', (_event, payload: string) => callback(payload));
  },
  onLevel(callback: (level: number) => void) {
    ipcRenderer.on('jarvis:level', (_event, payload: number) => callback(payload));
  },
  onVisible(callback: (visible: boolean) => void) {
    ipcRenderer.on('jarvis:visible', (_event, payload: boolean) => callback(payload));
  },
  onAssemble(callback: () => void) {
    ipcRenderer.on('jarvis:assemble', () => callback());
  },
  onAssemblyPresented(callback: () => void) {
    ipcRenderer.on('jarvis:assembly-presented-notification', () => callback());
  },
  onAnchor(callback: (anchor: { x: number; y: number; width: number; height: number }) => void) {
    ipcRenderer.on('jarvis:anchor', (_event, payload) => callback(payload));
  },
  onGesture(callback: (gesture: JarvisGesture) => void) {
    ipcRenderer.on('jarvis:gesture', (_event, payload: JarvisGesture) => callback(payload));
  },
  onWakeEnrollmentUpdate(callback: (update: unknown) => void) {
    const listener = (_event: Electron.IpcRendererEvent, update: unknown) => callback(update);
    ipcRenderer.on('jarvis:wake-enrollment-update', listener);
    return () => ipcRenderer.removeListener('jarvis:wake-enrollment-update', listener);
  },
  onWakeEnrollmentCommand(callback: (command: 'start' | 'capture' | 'cancel') => void) {
    const listener = (_event: Electron.IpcRendererEvent, command: 'start' | 'capture' | 'cancel') => callback(command);
    ipcRenderer.on('jarvis:wake-enrollment-command', listener);
    return () => ipcRenderer.removeListener('jarvis:wake-enrollment-command', listener);
  },
  wakeEnrollmentCommand(command: 'start' | 'capture' | 'cancel') {
    ipcRenderer.send('jarvis:wake-enrollment-command', command);
  },
  reportWakeEnrollmentUpdate(update: unknown) {
    ipcRenderer.send('jarvis:wake-enrollment-update', update);
  },
  getPersonalWakeModel() {
    return ipcRenderer.invoke('jarvis:personal-wake-model-get');
  },
  savePersonalWakeModel(model: unknown) {
    return ipcRenderer.invoke('jarvis:personal-wake-model-save', model) as Promise<void>;
  },
  onPersonalWakeModelUpdated(callback: (model: unknown) => void) {
    const listener = (_event: Electron.IpcRendererEvent, model: unknown) => callback(model);
    ipcRenderer.on('jarvis:personal-wake-model-updated', listener);
    return () => ipcRenderer.removeListener('jarvis:personal-wake-model-updated', listener);
  },
  wakeDetected() {
    ipcRenderer.send('jarvis:wake-detected');
  },
  assemblyReady() {
    ipcRenderer.send('jarvis:assembly-ready');
  },
  assemblyPresented() {
    ipcRenderer.send('jarvis:assembly-presented');
  },
  conversationEnded() {
    ipcRenderer.send('jarvis:conversation-ended');
  },
  reportState(state: 'idle' | 'listening' | 'thinking' | 'speaking') {
    ipcRenderer.send('jarvis:state-report', state);
  },
  reportLevel(level: number) {
    ipcRenderer.send('jarvis:level-report', level);
  },
  reportGesture(gesture: JarvisGesture) {
    ipcRenderer.send('jarvis:gesture-report', gesture);
  },
  reportAudioDiagnostic(summary: string) {
    ipcRenderer.send('jarvis:audio-diagnostic', summary);
  },
  reportVoiceEvent(message: string) {
    ipcRenderer.send('jarvis:voice-event', message);
  },
  connectRealtime(sdp: string) {
    return ipcRenderer.invoke('jarvis:realtime-connect', sdp) as Promise<string>;
  },
  getVoiceProviderName() {
    return getVoiceProviderSelection().selectedName;
  },
  getVoiceProviderSelection,
  connectDoubaoVoice() {
    return ipcRenderer.invoke('jarvis:doubao-connect') as Promise<{ durationMs: number }>;
  },
  sendDoubaoVoice(payload: string) {
    ipcRenderer.send('jarvis:doubao-send', payload);
  },
  closeDoubaoVoice() {
    ipcRenderer.send('jarvis:doubao-close');
  },
  onDoubaoVoiceMessage(callback: (payload: string) => void) {
    const listener = (_event: Electron.IpcRendererEvent, payload: string) => callback(payload);
    ipcRenderer.on('jarvis:doubao-message', listener);
    return () => ipcRenderer.removeListener('jarvis:doubao-message', listener);
  },
  onDoubaoVoiceState(callback: (state: DoubaoTransportState) => void) {
    const listener = (_event: Electron.IpcRendererEvent, state: DoubaoTransportState) => callback(state);
    ipcRenderer.on('jarvis:doubao-state', listener);
    return () => ipcRenderer.removeListener('jarvis:doubao-state', listener);
  },
  getVoiceSessionConfig() {
    return ipcRenderer.invoke('jarvis:voice-session-config');
  },
  executeAction(name: string, args: unknown) {
    return ipcRenderer.invoke('jarvis:execute-action', name, args) as Promise<string>;
  },
  quitApp() {
    ipcRenderer.send('jarvis:quit');
  }
});
