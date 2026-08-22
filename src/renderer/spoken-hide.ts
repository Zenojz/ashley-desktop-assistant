// Telling "get out of the way" apart from everything that sounds like it.
//
// This one deserves its own file because the cost of getting it wrong is not
// symmetric, and neither error is visible in the code.
//
// Miss a real request and the helmet keeps covering what the user is trying to
// look at, and they say it again. Annoying, recoverable.
//
// Match something that was not a request and the helmet drops behind the window
// in the middle of a sentence — or worse: the nearest tool the model would
// otherwise reach for is `end_conversation`, so anything vague enough to be
// mistaken here is vague enough to have ended the session instead. That is why
// this fires deterministically rather than being left to the model, and why it
// sits first in the fallback list.
//
// The rule is: short, imperative, and not a question. "隐藏" is a command.
// "隐藏文件怎么设置" is a question about hiding files and must not move
// anything.

const PUNCTUATION = /[，。！？!?,.\s]/g;

/** Longer than this and it is a sentence about hiding, not an order to hide. */
const MAX_LENGTH = 10;

/** Anything asking *about* hiding rather than asking *for* it. */
const ENQUIRY = /(怎么|如何|能不能|可不可以|为什么|是不是|文件|文件夹|图标|设置)/u;

const REQUEST = /(隐藏|藏起来|藏一下|藏一藏|让开|让一下|别挡|挡住了|挡到|遮住|遮到|退到后面|退后面)/u;

export function inferSpokenHideRequest(rawText: string): boolean {
  const compact = rawText.replace(PUNCTUATION, '');
  if (!compact || compact.length > MAX_LENGTH) return false;
  if (ENQUIRY.test(compact)) return false;
  return REQUEST.test(compact);
}
