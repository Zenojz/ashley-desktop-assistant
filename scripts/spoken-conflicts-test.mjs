// The deterministic visual-hide fallback must never steal an established
// command. This test keeps the boundary explicit without depending on any
// removed feature modules.
import { inferSpokenHideRequest } from '../src/renderer/spoken-hide.ts';

let failures = 0;
const ok = (name, condition) => {
  if (!condition) failures += 1;
  console.log(`${condition ? 'OK  ' : 'FAIL'}  ${name}`);
};

const HIDE_COMMANDS = [
  '隐藏', '隐藏一下', '藏起来', '藏一下', '让开', '让一下',
  '别挡着', '别挡着我', '挡住了', '挡到了', '遮住了', '遮到我了',
  '退到后面', '退后面去'
];

const OTHER_COMMANDS = [
  '退下', '退下吧', '拜拜', '再见', '没事了', '好了', '先这样', '不用了',
  '结束', '休眠', '待机', '就这样', '走吧', '睡吧',
  '完全退出', '彻底退出', '退出程序', '关闭程序', '关闭 Jarvis',
  '出来', '现身', '回来',
  '打开观澜', '关闭观澜', '播放周杰伦的稻香', '暂停', '下一首',
  '今天天气怎么样', '现在几点', '切换到第二个桌面',
  '在地图中搜索上海', '怎么去外滩', '导航到机场'
];

console.log('--- 隐藏口令必须识别 ---');
for (const text of HIDE_COMMANDS) {
  ok(`识别「${text}」`, inferSpokenHideRequest(text));
}

console.log('\n--- 其他现有口令不能被隐藏规则抢走 ---');
for (const text of OTHER_COMMANDS) {
  ok(`不误判「${text}」`, !inferSpokenHideRequest(text));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
