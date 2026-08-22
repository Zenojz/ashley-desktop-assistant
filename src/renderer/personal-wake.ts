export type PersonalWakeMode = 'off' | 'shadow' | 'active';

export type PersonalWakeModel = {
  version: 1;
  createdAt: string;
  keyword: string;
  dimension: number;
  threshold: number;
  mode: PersonalWakeMode;
  scoring?: 'temporal-shift-v1';
  rescueMode?: 'off' | 'shadow' | 'active';
  rescueThreshold?: number;
  templates: number[][];
  enrollment: {
    sampleCount: number;
    minimumLeaveOneOutScore: number;
    medianLeaveOneOutScore: number;
  };
};

function normalize(values: ArrayLike<number>) {
  let sumSquares = 0;
  for (let index = 0; index < values.length; index += 1) {
    const value = Number(values[index]);
    if (!Number.isFinite(value)) throw new Error('唤醒特征包含无效数值。');
    sumSquares += value * value;
  }
  const magnitude = Math.sqrt(sumSquares);
  if (magnitude < 1e-6) throw new Error('没有采集到有效的唤醒特征。');
  return Array.from(values, (value) => Number(value) / magnitude);
}

function temporalShiftCosine(left: number[], right: number[]) {
  const embeddingDimension = 96;
  const rows = left.length / embeddingDimension;
  if (!Number.isInteger(rows) || rows < 8 || right.length !== left.length) {
    throw new Error('个人唤醒特征窗口无效。');
  }

  // Enrollment snapshots are taken after VAD speech-end, while a real wake is
  // evaluated the instant the keyword model fires. Both contain the same
  // phrase, but it appears at different positions in the rolling embedding
  // window. Compare all alignments with at least half the window overlapping;
  // this removes timing offset without changing the underlying voice data.
  let best = -1;
  const maximumShift = Math.floor(rows / 2);
  for (let shift = -maximumShift; shift <= maximumShift; shift += 1) {
    const leftStartRow = Math.max(0, shift);
    const rightStartRow = Math.max(0, -shift);
    const overlapRows = rows - Math.abs(shift);
    let dot = 0;
    let leftEnergy = 0;
    let rightEnergy = 0;
    for (let row = 0; row < overlapRows; row += 1) {
      const leftOffset = (leftStartRow + row) * embeddingDimension;
      const rightOffset = (rightStartRow + row) * embeddingDimension;
      for (let column = 0; column < embeddingDimension; column += 1) {
        const leftValue = left[leftOffset + column];
        const rightValue = right[rightOffset + column];
        dot += leftValue * rightValue;
        leftEnergy += leftValue * leftValue;
        rightEnergy += rightValue * rightValue;
      }
    }
    const denominator = Math.sqrt(leftEnergy * rightEnergy);
    if (denominator > 1e-8) best = Math.max(best, dot / denominator);
  }
  return best;
}

function averageBestThree(scores: number[]) {
  const best = scores.sort((left, right) => right - left).slice(0, 3);
  return best.reduce((sum, score) => sum + score, 0) / best.length;
}

function percentile(sortedValues: number[], fraction: number) {
  const position = Math.max(0, Math.min(sortedValues.length - 1, Math.floor((sortedValues.length - 1) * fraction)));
  return sortedValues[position];
}

export function trainPersonalWakeModel(
  keyword: string,
  samples: ArrayLike<number>[],
  createdAt = new Date().toISOString()
): PersonalWakeModel {
  if (samples.length < 12) throw new Error('至少需要 12 条个人唤醒样本。');
  const templates = samples.map(normalize);
  const dimension = templates[0].length;
  if (dimension === 0 || templates.some((sample) => sample.length !== dimension)) {
    throw new Error('个人唤醒样本维度不一致。');
  }

  // Each sample is scored only against the other utterances. This avoids a
  // deceptively perfect training result caused by comparing a sample with
  // itself, and makes the threshold reflect the user's real pronunciation
  // variation across repetitions.
  const leaveOneOutScores = templates.map((sample, sampleIndex) => averageBestThree(
    templates
      .filter((_candidate, candidateIndex) => candidateIndex !== sampleIndex)
      .map((candidate) => temporalShiftCosine(sample, candidate))
  ));
  const sortedScores = [...leaveOneOutScores].sort((left, right) => left - right);
  const lowerReliableScore = percentile(sortedScores, 0.1);
  // Keep a small tolerance below the lower in-enrolment score for a different
  // room or speaking distance. The first deployment is shadow-only, so this
  // threshold is measured before it is ever allowed to reject a summon.
  const threshold = Math.max(0.45, Math.min(0.985, lowerReliableScore - 0.035));

  return {
    version: 1,
    createdAt,
    keyword,
    dimension,
    threshold,
    mode: 'shadow',
    scoring: 'temporal-shift-v1',
    rescueMode: 'shadow',
    rescueThreshold: Math.min(0.98, threshold + 0.02),
    templates,
    enrollment: {
      sampleCount: templates.length,
      minimumLeaveOneOutScore: sortedScores[0],
      medianLeaveOneOutScore: percentile(sortedScores, 0.5)
    }
  };
}

export function scorePersonalWake(model: PersonalWakeModel, sample: ArrayLike<number>) {
  if (model.version !== 1 || sample.length !== model.dimension || model.templates.length < 3) {
    throw new Error('个人唤醒模型与当前声学特征不兼容。');
  }
  const normalized = normalize(sample);
  return averageBestThree(model.templates.map((template) => temporalShiftCosine(normalized, template)));
}

export function isPersonalWakeModel(value: unknown): value is PersonalWakeModel {
  if (!value || typeof value !== 'object') return false;
  const model = value as Partial<PersonalWakeModel>;
  return model.version === 1
    && typeof model.createdAt === 'string'
    && typeof model.keyword === 'string'
    && Number.isInteger(model.dimension)
    && Number(model.dimension) > 0
    && Number.isFinite(model.threshold)
    && ['off', 'shadow', 'active'].includes(String(model.mode))
    && Array.isArray(model.templates)
    && model.templates.length >= 3
    && model.templates.every((template) =>
      Array.isArray(template)
      && template.length === model.dimension
      && template.every(Number.isFinite)
    );
}
