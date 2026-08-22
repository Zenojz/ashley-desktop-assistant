import type { WebContents } from 'electron';
import WebSocket, { type RawData } from 'ws';

const DOUBAO_DUPLEX_ENDPOINT =
  'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue';
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_EVENT_BYTES = 2_000_000;

export type DoubaoConnectionResult = {
  durationMs: number;
};

type DoubaoTransportState =
  | { type: 'disconnected'; code: number; reason: string }
  | { type: 'failed'; message: string };

export class DoubaoVoiceTransport {
  private socket: WebSocket | null = null;
  private owner: WebContents | null = null;

  constructor(private readonly log: (message: string) => void) {}

  async connect(owner: WebContents): Promise<DoubaoConnectionResult> {
    const appId = process.env.DOUBAO_APP_ID?.trim();
    const apiKey = process.env.DOUBAO_API_KEY?.trim();
    if (!appId || !apiKey) {
      throw new Error('豆包语音配置缺失：DOUBAO_APP_ID 和 DOUBAO_API_KEY 都必须配置。');
    }

    this.close();
    const startedAt = performance.now();

    // Volcengine authenticates with X-Api-Key but authorises per resource, and
    // the resource has to be named explicitly. Omitting X-Api-Resource-Id makes
    // the server fall back to a default for the endpoint — which produced
    // "[resource_id=volc.speech.dialog] requested resource not granted" even
    // after the account had enabled realtime voice, because the enabled product
    // carries a different resource id.
    //
    // The correct value is shown in the Doubao speech console next to the
    // enabled service, so it is configuration rather than something to hardcode
    // and guess at.
    const headers: Record<string, string> = { 'X-Api-Key': apiKey };
    const resourceId = process.env.DOUBAO_RESOURCE_ID?.trim();
    if (resourceId) headers['X-Api-Resource-Id'] = resourceId;
    // Some Volcengine speech products bind the grant to an app rather than the
    // account. Only sent when explicitly configured: an unnecessary app header
    // has been reported to break the handshake on some endpoints.
    const sendAppKey = process.env.DOUBAO_SEND_APP_KEY === '1';
    if (sendAppKey) headers['X-Api-App-Key'] = appId;

    this.log(
      `Doubao handshake headers: X-Api-Key=set, X-Api-Resource-Id=${resourceId || '(not sent)'}, ` +
        `X-Api-App-Key=${sendAppKey ? appId : '(not sent)'}.`
    );

    const socket = new WebSocket(DOUBAO_DUPLEX_ENDPOINT, {
      headers,
      perMessageDeflate: false
    });
    this.socket = socket;
    this.owner = owner;

    return new Promise<DoubaoConnectionResult>((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (settled) return;
        settled = true;
        socket.terminate();
        reject(new Error('豆包全双工语音连接在 10 秒内没有建立。'));
      }, CONNECT_TIMEOUT_MS);

      socket.once('open', () => {
        if (settled || socket !== this.socket) return;
        settled = true;
        clearTimeout(timeout);
        const durationMs = Math.round(performance.now() - startedAt);
        this.log(`Doubao full-duplex WebSocket connected in ${durationMs}ms (app ${appId}).`);
        resolve({ durationMs });
      });
      socket.on('message', (data: RawData) => {
        if (socket !== this.socket || owner.isDestroyed()) return;
        owner.send('jarvis:doubao-message', rawDataToText(data));
      });
      socket.on('close', (code, reason) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`豆包全双工语音连接已关闭（${code}）：${reason.toString() || '无原因'}`));
        }
        if (socket !== this.socket) return;
        this.socket = null;
        this.owner = null;
        this.sendState(owner, {
          type: 'disconnected',
          code,
          reason: reason.toString()
        });
      });
      // A rejected handshake surfaces as a bare "Unexpected server response:
      // 403", which says nothing about the cause. The server's actual HTTP
      // response carries the reason — an error code in the body, and an
      // X-Tt-Logid header that support can trace. Read it before giving up.
      socket.on('unexpected-response', (_request, response) => {
        const headers = response.headers;
        const traceId = headers['x-tt-logid'] ?? headers['x-tt-trace-id'] ?? '(none)';
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => {
          if (chunks.length < 16) chunks.push(chunk);
        });
        response.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8').trim().slice(0, 1_000);
          this.log(
            `Doubao handshake rejected: HTTP ${response.statusCode} ${response.statusMessage ?? ''}. ` +
              `logid=${traceId}. body=${body || '(empty)'}`
          );
        });
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`豆包握手被拒绝：HTTP ${response.statusCode}。详细原因见运行日志。`));
        }
      });
      socket.on('error', (error) => {
        if (!settled) {
          settled = true;
          clearTimeout(timeout);
          reject(new Error(`豆包全双工语音连接失败：${error.message}`));
        }
        if (socket === this.socket) {
          this.sendState(owner, { type: 'failed', message: error.message });
        }
      });
    });
  }

  send(payload: string) {
    if (Buffer.byteLength(payload, 'utf8') > MAX_EVENT_BYTES) return false;
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return false;
    socket.send(payload);
    return true;
  }

  close() {
    const socket = this.socket;
    this.socket = null;
    this.owner = null;
    if (!socket) return;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(1000, 'Jarvis voice session closed');
    }
  }

  private sendState(owner: WebContents, state: DoubaoTransportState) {
    if (!owner.isDestroyed()) owner.send('jarvis:doubao-state', state);
  }
}

function rawDataToText(data: RawData) {
  if (typeof data === 'string') return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString('utf8');
  if (Array.isArray(data)) return Buffer.concat(data).toString('utf8');
  return data.toString('utf8');
}
