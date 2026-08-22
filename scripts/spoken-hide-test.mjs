// 「隐藏」这条指令的判别测试。
//
// 这条比别的指令更值得单独测，因为两种判错的代价完全不对称：
// 漏判，头盔继续挡着，你再说一遍就是了；
// 误判，头盔在你说话说到一半时掉到窗口后面——更糟的是，模型手里最接近
// 「隐藏」的工具是「结束对话」，所以任何模糊到会在这里误判的说法，
// 也模糊到足以直接把会话结束掉。
import { inferSpokenHideRequest } from '../src/renderer/spoken-hide.ts';

let failures = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failures += 1;
  console.log(`${cond ? 'OK  ' : 'FAIL'}  ${name}${detail ? ': ' + detail : ''}`);
};

console.log('--- 这些必须认出来 ---');
for (const text of [
  '隐藏', '隐藏。', '隐藏一下', '藏起来', '藏起来吧', '藏一下',
  '让开', '让一下', '别挡着', '别挡着我', '挡住了', '挡到了',
  '遮住了', '遮到我了', '退到后面', '退后面去'
]) {
  ok(`认出「${text}」`, inferSpokenHideRequest(text) === true);
}

console.log('\n--- 这些绝对不能误判 ---');
for (const text of [
  // 在问「怎么隐藏」，不是在叫头盔让开。
  '隐藏文件怎么设置',
  '怎么隐藏这个图标',
  '文件夹能不能隐藏',
  'Finder 里如何隐藏文件',
  '为什么这个窗口被挡住了看不见',
  // 和退出/休眠必须泾渭分明：这几句该走 end_conversation，不该走隐藏。
  '退下', '拜拜', '再见', '结束', '休眠', '没事了', '先这样',
  // 和彻底退出更不能混。
  '完全退出', '关闭程序',
  // 普通对话。
  '', '今天天气怎么样', '帮我转到上海', '打开观澜',
  '这个功能是不是可以隐藏起来用在别的地方我想问一下具体怎么配置'
]) {
  ok(`不误判「${text || '（空）'}」`, inferSpokenHideRequest(text) === false,
    String(inferSpokenHideRequest(text)));
}

console.log('\n--- 长度这道闸必须真的在起作用 ---');
{
  // 同一个关键词，短的是命令，长的是句子。
  ok('短句认出来', inferSpokenHideRequest('隐藏一下') === true);
  ok('长句不认', inferSpokenHideRequest('我想问一下这个头盔能不能隐藏一下再说') === false);
  ok('标点不影响判断', inferSpokenHideRequest('隐藏，一下。') === true);
}

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
