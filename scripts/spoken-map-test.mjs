// 地图口令：说个大概就得听懂。
//
// 这一条的要求和别的指令不一样——它存在的理由就是「手势不灵的时候顶上」，
// 所以它必须一次就成。下面的说法全部是同一个意思的不同说法，一个都不许漏。
import {
  inferSpokenMapCloseRequest, inferSpokenMapIntent, inferSpokenMapOpenRequest
} from '../src/renderer/spoken-map.ts';

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? ': ' + detail : ''}`);
};
const kindOf = (text) => inferSpokenMapIntent(text)?.kind ?? null;
const of = (text) => inferSpokenMapIntent(text);

console.log('--- 地图开关：独立入口 ---');
for (const text of [
  '打开全息地图', '帮我打开全息地图', '开启全息地图',
  '显示HUD全息地图', '把全息地图调出来'
]) {
  ok(`「${text}」→ 打开地图`, inferSpokenMapOpenRequest(text));
}
for (const text of [
  '关闭全息地图', '帮我关掉全息地图', '收起全息地图'
]) {
  ok(`「${text}」→ 关闭地图`, inferSpokenMapCloseRequest(text));
}
for (const text of [
  '怎么打开全息地图', '能不能打开全息地图', '不要打开全息地图',
  '如何关闭全息地图', '不要关闭全息地图', '打开观澜', '关闭 Jarvis'
]) {
  ok(`「${text}」不是地图开关命令`,
    !inferSpokenMapOpenRequest(text) && !inferSpokenMapCloseRequest(text));
}

console.log('\n--- 放大：同一个意思的十几种说法 ---');
for (const text of [
  '放大', '放大一点', '再放大点', '拉近', '拉近一点', '推近', '凑近一点',
  '靠近一点', '近一点', '大一点', '下钻', '钻下去', '深入一点', '看细一点',
  '帮我放大一点', '地图放大', '把地图拉近一点'
]) {
  const intent = of(text);
  ok(`「${text}」→ 放大`, intent?.kind === 'zoom' && intent.direction === 'in',
    JSON.stringify(intent));
}

console.log('\n--- 缩小 ---');
for (const text of [
  '缩小', '缩小一点', '拉远', '拉远一点', '退远一点', '远一点', '小一点',
  '拉高', '升高一点', '看全一点', '看个大局', '帮我缩小'
]) {
  const intent = of(text);
  ok(`「${text}」→ 缩小`, intent?.kind === 'zoom' && intent.direction === 'out',
    JSON.stringify(intent));
}

console.log('\n--- 上下左右：口语、语序、方位词都要认 ---');
{
  const cases = [
    ['往左', 'left'], ['向左一点', 'left'], ['左边一点', 'left'],
    ['帮我往左边挪一点', 'left'], ['左', 'left'], ['往西', 'left'],
    ['往右', 'right'], ['右边一点', 'right'], ['向东移一点', 'right'],
    ['往上', 'up'], ['向上一点', 'up'], ['往北一点', 'up'],
    ['往下', 'down'], ['向下移动', 'down'], ['往南一点', 'down']
  ];
  for (const [text, direction] of cases) {
    const intent = of(text);
    ok(`「${text}」→ 平移${direction}`,
      intent?.kind === 'pan' && intent.direction === direction, JSON.stringify(intent));
  }
}

console.log('\n--- 幅度：说轻说重都要听出来 ---');
{
  ok('「往左一点点」是小幅', of('往左一点点')?.amount === 'small');
  ok('「稍微往左」是小幅', of('稍微往左')?.amount === 'small');
  ok('「往左」是默认幅度', of('往左')?.amount === 'normal');
  ok('「往左很多」是大幅', of('往左很多')?.amount === 'large');
  ok('「往左一大截」是大幅', of('往左一大截')?.amount === 'large');
  ok('「放大三级」数出三级', of('放大三级')?.steps === 3, JSON.stringify(of('放大三级')));
  ok('「放大2级」数出两级', of('放大2级')?.steps === 2, JSON.stringify(of('放大2级')));
  ok('没说级数就是一级', of('放大')?.steps === 1);
}

console.log('\n--- 转视角 vs 转地球：靠「视角」这类词区分 ---');
{
  ok('「往左转」是转地球（平移）', kindOf('往左转') === 'pan');
  ok('「视角左转」是转视角', of('视角左转')?.kind === 'turn');
  ok('「换个角度往右」是转视角', of('换个角度往右')?.kind === 'turn');
  ok('「把方向往右转一点」是转视角', of('把方向往右转一点')?.kind === 'turn');
}

console.log('\n--- 俯仰、刹车、回正 ---');
{
  ok('抬头', of('抬头一点')?.kind === 'tilt' && of('抬头一点').direction === 'up');
  ok('低头', of('低头一点')?.kind === 'tilt' && of('低头一点').direction === 'down');
  ok('俯视', of('俯视')?.direction === 'down');
  for (const text of ['停', '停一下', '停下', '别动', '不要动', '定住', '站住']) {
    ok(`「${text}」→ 刹车`, kindOf(text) === 'freeze');
  }
  for (const text of ['继续', '可以动了', '解除', '放开']) {
    ok(`「${text}」→ 解除`, kindOf(text) === 'resume');
  }
  for (const text of ['回正', '复位', '摆正', '转回来']) {
    ok(`「${text}」→ 回正`, kindOf(text) === 'reset');
  }
}

console.log('\n--- 直接跳层级 ---');
{
  ok('看全球', of('看全球')?.level === 'globe', JSON.stringify(of('看全球')));
  ok('回到地球全景', of('回到地球全景')?.level === 'globe');
  ok('看这个城市', of('看这个城市')?.level === 'city');
  ok('看街道', of('看街道')?.level === 'district');
}

console.log('\n--- 绝对不能误判 ---');
{
  const rejected = [
    // 在问，不是在命令。
    '怎么放大', '地图能不能放大', '这个怎样缩小', '为什么放大不了',
    // 否定。
    '不要放大', '不用缩小', '别再往左了',
    // 和别的指令撞车：这些该走各自的工具，不该被当成地图口令。
    '隐藏', '出来', '拜拜', '打开观澜', '播放周杰伦的稻香', '今天天气怎么样',
    // 普通聊天。
    '', '嗯', '好的', '这个功能挺好的',
    // 太长的句子是叙述不是命令。
    '我想问一下这个地图往左边移动一点点之后还能不能自动回到原来的位置'
  ];
  for (const text of rejected) {
    ok(`不误判「${text || '（空）'}」`, inferSpokenMapIntent(text) === null,
      JSON.stringify(inferSpokenMapIntent(text)));
  }
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
