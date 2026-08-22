// Understanding roughly what was meant, when the map is being driven by voice.
//
// The voice path exists because hands are not always reliable — a gesture
// missed is a gesture the operator has to make again, and the whole point of
// speaking instead is that it should work the first time. So this does not
// match phrases. Enumerating phrases is how the farewell command ended up
// missing "退出" by one character, and a map has far more ways to be addressed
// than a goodbye does.
//
// What it does instead is fill three slots out of whatever was said:
//
//   * an action — move, zoom, turn, lean, stop, straighten
//   * a direction — left, right, up, down, in, out
//   * a size — a nudge, a normal step, a long way
//
// The words for each slot are collected as alternatives, order does not matter,
// and filler between them is ignored. "往左一点" and "帮我把地图稍微往左边挪挪"
// are the same instruction and both arrive here as the same three slots.
//
// Two guards keep it from firing on things that merely sound similar. A
// question about zooming is not an instruction to zoom, and a sentence long
// enough to contain a subordinate clause is a sentence, not a command.

export type SpokenMapIntent =
  | { kind: 'pan'; direction: 'up' | 'down' | 'left' | 'right'; amount: Size }
  | { kind: 'zoom'; direction: 'in' | 'out'; steps: number }
  | { kind: 'turn'; direction: 'left' | 'right'; amount: Size }
  | { kind: 'tilt'; direction: 'up' | 'down'; amount: Size }
  | { kind: 'level'; level: 'globe' | 'continent' | 'province' | 'city' | 'district' | 'building' }
  | { kind: 'freeze' }
  | { kind: 'resume' }
  | { kind: 'reset' };

export type Size = 'small' | 'normal' | 'large';

const PUNCTUATION = /[，。、！？!?,.\s]/g;

/** Beyond this it is a sentence about the map, not an order to the map. */
const MAX_LENGTH = 24;

/** Asking *about* an action rather than *for* it. */
const ENQUIRY = /(怎么|怎样|如何|能不能|可不可以|可以吗|行不行|为什么|是不是|什么意思)/u;

/** "别动" is a brake and is matched before this; everything else negated is refused. */
const NEGATION = /(不要|不用|别再|甭)/u;

/**
 * The map's own front door.
 *
 * This is intentionally separate from camera commands. "打开全息地图" must
 * work while the layer is closed, whereas pan/zoom commands deliberately do
 * nothing until a map is visible. Requiring both an opening verb and the full
 * object name keeps questions about maps, music's "打开", and ordinary app
 * opening requests out of this path.
 */
export function inferSpokenMapOpenRequest(rawText: string): boolean {
  const text = rawText.replace(PUNCTUATION, '').toLowerCase();
  if (!text || text.length > 24) return false;
  if (ENQUIRY.test(text) || NEGATION.test(text)) return false;
  return /全息地图/u.test(text) && /(打开|开启|显示|调出|唤出)/u.test(text);
}

/** The matching back door; naming the map prevents this becoming a Jarvis quit. */
export function inferSpokenMapCloseRequest(rawText: string): boolean {
  const text = rawText.replace(PUNCTUATION, '').toLowerCase();
  if (!text || text.length > 24) return false;
  if (ENQUIRY.test(text) || NEGATION.test(text)) return false;
  return /全息地图/u.test(text) && /(关闭|关掉|收起)/u.test(text);
}

const NUMERALS: Record<string, number> = {
  一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10
};

/** A count written either way, or null when none was given. */
function readCount(text: string): number | null {
  const arabic = text.match(/(\d+)/u);
  if (arabic) {
    const value = Number(arabic[1]);
    return Number.isFinite(value) ? value : null;
  }
  // 十五 / 二十 style numbers are not worth the machinery here: levels are
  // counted in ones and twos, and a size word covers everything else.
  const chinese = text.match(/([一二两三四五六七八九十])\s*(?:级|层|格|下|步)/u);
  if (chinese) return NUMERALS[chinese[1]] ?? null;
  return null;
}

function readSize(text: string): Size {
  if (/(一点点|一丢丢|稍微|略微|轻轻|微调|一小[点些]|小幅)/u.test(text)) return 'small';
  if (/(很多|多一点|大幅|一大截|使劲|用力|远一点|大一点|再多)/u.test(text)) return 'large';
  if (/(一点|一些|一下下)/u.test(text)) return 'small';
  return 'normal';
}

/**
 * A compass direction counts as a screen direction, because the map is drawn
 * north-up unless the operator has turned it — and if they have turned it, they
 * are the one who did so and can say "left" instead.
 */
const UP = /(向上|往上|朝上|上边|上面|上方|北边|往北|向北)/u;
const DOWN = /(向下|往下|朝下|下边|下面|下方|南边|往南|向南)/u;
const LEFT = /(向左|往左|朝左|左边|左侧|左面|左方|西边|往西|向西|左)/u;
const RIGHT = /(向右|往右|朝右|右边|右侧|右面|右方|东边|往东|向东|右)/u;

const ZOOM_IN = /(放大|拉近|推近|凑近|靠近|近一点|近点|大一点|大点|下钻|钻下去|深入|细一点|看细|再近)/u;
const ZOOM_OUT = /(缩小|拉远|退远|拉高|升高|上升|远一点|远点|小一点|小点|看全|全局|大局|广一点|再远)/u;

const TURN_WORDS = /(视角|角度|方位|朝向|方向|转视角|旋转)/u;
const TILT_UP = /(抬头|抬起|抬高视角|平视|放平|压平)/u;
const TILT_DOWN = /(低头|压低|俯视|往下压|垂直看|正上方看)/u;

/**
 * The brake.
 *
 * A bare 停 is not enough on its own and this is not hypothetical: the first
 * version matched it anywhere in the utterance, which quietly stole 暂停 —
 * already the established way to pause music. So the bare form has to be the
 * whole instruction, and anything longer has to say which kind of stop it is.
 */
const FREEZE = /(停一下|停一停|停下来|停下|停住|先停|别动|不要动|不许动|别转|不要转|定住|站住|锁住|冻住)/u;
const FREEZE_ALONE = /^停+$/u;
const RESUME = /(继续|可以动了|解除|放开|松开|恢复转动)/u;
const RESET = /(回正|复位|摆正|正过来|转回来|回到正北|朝北|归位)/u;

/**
 * Naming a scale outright, rather than stepping towards one.
 *
 * The words are kept deliberately specific. A bare 省 or 楼 appears in far too
 * much ordinary speech to be a reliable signal, and a level jump is a bigger
 * movement than a zoom step — so the cost of a false positive here is higher
 * and the evidence required is correspondingly stronger.
 */
const LEVELS: Array<[RegExp, SpokenMapIntent & { kind: 'level' }]> = [
  [/(全球|整个地球|看地球|地球全景|太空)/u, { kind: 'level', level: 'globe' }],
  [/(整个国家|全国|洲际|大陆板块)/u, { kind: 'level', level: 'continent' }],
  [/(整个省|省份|省级|区域全景)/u, { kind: 'level', level: 'province' }],
  [/(城市|市区)/u, { kind: 'level', level: 'city' }],
  [/(街道|街区|城区细节)/u, { kind: 'level', level: 'district' }],
  [/(整栋楼|这栋楼|建筑|楼房|屋顶)/u, { kind: 'level', level: 'building' }]
];

export function inferSpokenMapIntent(rawText: string): SpokenMapIntent | null {
  const text = rawText.replace(PUNCTUATION, '');
  if (!text || text.length > MAX_LENGTH) return null;
  if (ENQUIRY.test(text)) return null;

  // The brake first, and before the negation guard: "别动" and "不要动" are the
  // most natural ways to say stop, and they are also negations.
  if (FREEZE.test(text) || FREEZE_ALONE.test(text)) return { kind: 'freeze' };
  if (RESUME.test(text)) return { kind: 'resume' };
  if (NEGATION.test(text)) return null;
  if (RESET.test(text)) return { kind: 'reset' };

  const size = readSize(text);

  // Named scales are checked before zoom steps, because most of them contain a
  // zoom word too. "看全球" is a destination; "看全一点" is a step; the first
  // has to win or it would be read as the second, which is how the whole globe
  // came out as a single notch of zoom-out.
  for (const [pattern, intent] of LEVELS) {
    if (pattern.test(text)) return intent;
  }

  if (ZOOM_IN.test(text)) return { kind: 'zoom', direction: 'in', steps: readCount(text) ?? 1 };
  if (ZOOM_OUT.test(text)) return { kind: 'zoom', direction: 'out', steps: readCount(text) ?? 1 };

  if (TILT_UP.test(text)) return { kind: 'tilt', direction: 'up', amount: size };
  if (TILT_DOWN.test(text)) return { kind: 'tilt', direction: 'down', amount: size };

  // Left and right mean two different things depending on what is being turned:
  // the ground, or the operator's heading over it. Only the second is ever said
  // with the word "view" or "angle" in it, so that is the discriminator — and
  // the plain case, which is far more common, stays the simple one.
  const horizontal = LEFT.test(text) ? 'left' : RIGHT.test(text) ? 'right' : null;
  if (horizontal && TURN_WORDS.test(text)) {
    return { kind: 'turn', direction: horizontal, amount: size };
  }

  if (UP.test(text)) return { kind: 'pan', direction: 'up', amount: size };
  if (DOWN.test(text)) return { kind: 'pan', direction: 'down', amount: size };
  if (horizontal) return { kind: 'pan', direction: horizontal, amount: size };

  return null;
}
