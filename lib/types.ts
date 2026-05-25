export type MetricConfig = {
  name: string;
  weight: number;
  description: string;
};

export type InterviewTurnSnapshot = {
  id: string;
  turnSequence: number;
  aiQuestion: string;
  userAnswer: string | null;
  createdAt?: Date;
};

export type ChatMessage = {
  role: 'system' | 'user' | 'assistant';
  content: string;
};

export type JudgeMetricResult = {
  score: number;
  feedback: string;
};

export type ScoreComponent = {
  name: string;
  value: number;
  max: number;
  note: string;
};

export type AnswerQualitySignals = {
  relevance: number;
  specificity: number;
  completeness: number;
  fluency: number;
  transcriptConfidence: number;
  fillerPenalty: number;
  offTopic: boolean;
  notes: string[];
};

export type MetricScoreBreakdown = {
  rawJudgeScore: number;
  qualityCap: number;
  finalScore: number;
  components: ScoreComponent[];
  rationale: string;
  evidence: string[];
};

export type TranscriptTurnAnalysis = {
  turnSequence: number;
  question: string;
  answer: string;
  signals: AnswerQualitySignals;
};

export type TurnScoreBreakdown = {
  turnSequence: number;
  question: string;
  answer: string;
  turnQualityScore: number;
  weightedScore: number;
  weightedPercentage: number;
  metricScores: Record<string, number>;
  notes: string[];
};

export type JudgeOutput = {
  criteria: Record<string, JudgeMetricResult>;
  summary: string;
  strengths?: string[];
  improvements?: string[];
};

export type ScoringMetricsPayload = JudgeOutput & {
  weightedScore: number;
  weightedPercentage: number;
  evaluatedAt: string;
  rawJudgeOutput: string;
  answerQualityCap: number;
  qualitySignals: AnswerQualitySignals;
  metricBreakdowns: Record<string, MetricScoreBreakdown>;
  turnAnalysis: TranscriptTurnAnalysis[];
  perAnswerScores: TurnScoreBreakdown[];
  scoreNarrative: {
    summary: string;
    strengths: string[];
    improvements: string[];
  };
};