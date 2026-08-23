import { inferSpokenMusicRequest } from '../src/renderer/spoken-music.ts';

let failures = 0;
const expectRequest = (text, expected) => {
  const actual = inferSpokenMusicRequest(text);
  const matches = JSON.stringify(actual) === JSON.stringify(expected);
  if (!matches) failures += 1;
  console.log(`${matches ? 'OK  ' : 'FAIL'}  ${text}: ${JSON.stringify(actual)}`);
};

expectRequest('给我放一首青花瓷。', {
  song: '青花瓷', artist: '', application: 'auto'
});
expectRequest('用酷狗播放周杰伦的《稻香》。', {
  song: '稻香', artist: '周杰伦', application: 'kugou'
});
expectRequest('用网易云播放“晴天”', {
  song: '晴天', artist: '', application: 'netease'
});
expectRequest('播放周杰伦。用酷狗播放周杰伦的青花瓷', {
  song: '青花瓷', artist: '周杰伦', application: 'kugou'
});
expectRequest('暂停', null);
expectRequest('下一首', null);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
