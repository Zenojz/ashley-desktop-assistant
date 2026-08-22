// 两套口令不能互相抢。
//
// 「隐藏」和地图口令是两条独立的确定性规则，而规则是按顺序取第一个命中的。
// 顺序一改，或者任何一方加了个新词，就可能出现「说隐藏结果地图动了」这种
// 谁都想不到的串台——它不会报错，只会做错事。这个文件把两边的全部说法交叉
// 喂给对方，确保没有一个词同时命中两边。
import { inferSpokenHideRequest } from '../src/renderer/spoken-hide.ts';
import {
  inferSpokenMapCloseRequest, inferSpokenMapIntent, inferSpokenMapOpenRequest
} from '../src/renderer/spoken-map.ts';

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? ': ' + detail : ''}`);
};

const HIDE = [
  '隐藏', '隐藏一下', '藏起来', '藏一下', '让开', '让一下',
  '别挡着', '别挡着我', '挡住了', '挡到了', '遮住了', '遮到我了',
  '退到后面', '退后面去'
];

const MAP = [
  '放大', '放大一点', '拉近', '缩小', '拉远', '往左', '往右', '往上', '往下',
  '左边一点', '视角左转', '抬头', '低头', '停', '别动', '继续', '回正',
  '看全球', '看这个城市', '看街道', '打开全息地图', '关闭全息地图'
];

// 结束对话 / 退出程序：这两条现有指令一个字都不能被新规则抢走。
const EXISTING = [
  '退下', '退下吧', '拜拜', '再见', '没事了', '好了', '先这样', '不用了',
  '结束', '休眠', '待机', '就这样', '走吧', '睡吧',
  '完全退出', '彻底退出', '退出程序', '关闭程序', '关闭 Jarvis',
  '出来', '现身', '回来',
  '打开观澜', '关闭观澜', '播放周杰伦的稻香', '暂停', '下一首',
  '今天天气怎么样', '现在几点', '切换到第二个桌面'
];

console.log('--- 隐藏的说法，一个都不许被地图口令抢走 ---');
for (const text of HIDE) {
  const intent = inferSpokenMapIntent(text);
  ok(`「${text}」不被当成地图口令`, intent === null, JSON.stringify(intent));
}

console.log('\n--- 地图的说法，一个都不许被隐藏抢走 ---');
for (const text of MAP) {
  ok(`「${text}」不被当成隐藏`, inferSpokenHideRequest(text) === false);
}

console.log('\n--- 现有指令，两边都不许碰 ---');
for (const text of EXISTING) {
  const intent = inferSpokenMapIntent(text);
  ok(`「${text}」不被地图口令抢走`, intent === null, JSON.stringify(intent));
  ok(`「${text}」不被隐藏抢走`, inferSpokenHideRequest(text) === false);
  ok(`「${text}」不被地图开关抢走`,
    !inferSpokenMapOpenRequest(text) && !inferSpokenMapCloseRequest(text));
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
