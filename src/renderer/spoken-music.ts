export type SpokenMusicRequest = {
  song: string;
  artist: string;
  application: 'kugou' | 'netease' | 'auto';
};

const stripTitleQuotes = (value: string) =>
  value.replace(/^[《「“"']+|[》」”"']+$/g, '').trim();

export function inferSpokenMusicRequest(rawText: string): SpokenMusicRequest | null {
  const compact = rawText.replace(/[，。！？!?,]/g, '').trim();
  const application = /网易云/.test(compact)
    ? 'netease'
    : /酷狗/.test(compact)
      ? 'kugou'
      : 'auto';
  if (/暂停|继续播放|恢复播放|上一首|下一首/.test(compact)) return null;

  // ASR can merge a correction with the previous phrase. The final playback
  // verb identifies the request that should actually run.
  const playbackVerb = /(?:播放|放一首|放首|放)/g;
  let requestStart = -1;
  for (let match = playbackVerb.exec(compact); match; match = playbackVerb.exec(compact)) {
    requestStart = match.index + match[0].length;
  }
  if (requestStart < 0) return null;
  const request = compact.slice(requestStart)
    .replace(/^(?:一下|一首|首|歌曲)/, '')
    .replace(/(?:这首歌|这首|给我听|听一下|听听)$/g, '')
    .trim();
  if (!request || /^(?:歌|歌曲|音乐)$/.test(request)) return null;

  let artist = '';
  let song = request;
  const possessive = request.match(/^(.{1,20})的(.{1,40})$/);
  if (possessive) {
    artist = stripTitleQuotes(possessive[1]);
    song = stripTitleQuotes(possessive[2]);
  } else {
    song = stripTitleQuotes(song);
  }
  return song ? { song, artist, application } : null;
}
