import type {
  AnswerQualitySignals,
  ChatMessage,
  InterviewTurnSnapshot,
  JudgeOutput,
  MetricConfig,
  MetricScoreBreakdown,
  TranscriptTurnAnalysis,
  TurnScoreBreakdown
} from '@/lib/types';

export function sumMetricWeights(metrics: MetricConfig[]): number {
  return metrics.reduce((total, metric) => total + Number(metric.weight || 0), 0);
}

export function validateMetricWeights(metrics: MetricConfig[]): void {
  const total = sumMetricWeights(metrics);

  if (Math.abs(total - 100) > 0.0001) {
    throw new Error(`Metric weights must total 100. Current total: ${total}`);
  }
}

export function buildOpeningQuestionPrompt(topic: string): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt:
      'You are an experienced mock interviewer. Ask one concise, punchy question only. Do not provide context, explanation, or numbering.',
    userPrompt: `Topic: ${topic}. Ask the first question to start the interview.`
  };
}

export function buildFollowUpQuestionPrompt(topic: string): string {
  return [
    'You are conducting a modular mock interview.',
    'Use the full conversation history to ask exactly one follow-up question.',
    'Keep it short, specific, and context-aware.',
    'Do not repeat prior questions.',
    `Primary topic: ${topic}`
  ].join('\n');
}

export function buildHackathonOpeningPrompt(topic: string, problemStatementText: string | null): { systemPrompt: string; userPrompt: string } {
  return {
    systemPrompt: [
      'You are the AI Mock Interviewer conducting a technical mock evaluation for a virtual hackathon.',
      'Ask exactly one concise, punchy opening question to start the evaluation.',
      'Do not provide preamble, pleasantries, numbering, or explanations.',
      problemStatementText ? `Here is the parsed list of problem statements for this hackathon:\n${problemStatementText.slice(0, 3000)}` : ''
    ].filter(Boolean).join('\n'),
    userPrompt: problemStatementText 
      ? `Ask the candidate which problem statement they selected from the provided list, and what motivated them or their team to choose it over the other options. Do not assume or mention a specific choice yourself.`
      : `The candidate is starting their evaluation on the topic/idea: "${topic}". Ask them to explain the core problem statement they are solving and what motivated them or their team to choose this project.`
  };
}

export function buildHackathonFollowUpPrompt(
  turnSequence: number,
  topic: string,
  commitsData: any,
  problemStatementText: string | null
): string {
  const commitsContext = commitsData ? JSON.stringify(commitsData) : 'No commit history fetched.';
  
  const baseInstructions = [
    'You are the AI Mock Interviewer conducting a technical evaluation for a hackathon.',
    'Use the conversation history to ask exactly one context-aware follow-up question.',
    'Keep it short, highly specific, and technically deep.',
    'Do not provide context, numbering, list formats, or preambles. Ask the question directly.',
    `Primary Topic/Idea: ${topic}`
  ];

  if (problemStatementText) {
    baseInstructions.push(`Hackathon Problem Statements Reference:\n${problemStatementText.slice(0, 2000)}`);
  }

  // Turn-based prompt steering
  switch (turnSequence) {
    case 2:
      baseInstructions.push(
        'OBJECTIVE (Turn 2): Ask the candidate to justify their choice of Tech Stack (frameworks, database, programming language, libraries) for this problem statement. Why is this stack optimal?'
      );
      break;
    case 3:
      baseInstructions.push(
        'OBJECTIVE (Turn 3): Inquire about their system design progress so far and their core architectural approach to solving their selected problem statement.'
      );
      break;
    case 4:
      baseInstructions.push(
        `OBJECTIVE (Turn 4): Specific code and role evaluation.`,
        `Here is the cached GitHub commit history for the candidate:\n${commitsContext}`,
        `Select one specific file they modified (e.g. from the commit summaries) and ask a deep technical question about their changes, code logic, or their specific role in implementing that part.`
      );
      break;
    case 5:
      baseInstructions.push(
        `OBJECTIVE (Turn 5): Second specific code / role evaluation.`,
        `Refer to their cached GitHub commit history:\n${commitsContext}`,
        `Select another commit, a different modified file, or a structural coding choice they made. Ask a follow-up question about their implementation details or logic inside that file.`
      );
      break;
    case 6:
      baseInstructions.push(
        `OBJECTIVE (Turn 6): Wrong-Answer Probing.`,
        `Refer to their cached GitHub commit history:\n${commitsContext}`,
        `Identify a file or component they worked on. Intentionally suggest a SLIGHTLY INCORRECT or WRONG interpretation of what their code or logic in that file does (e.g. 'Looking at Y, it seems you are doing X to solve Z, right?' where X is incorrect).`,
        `See if they have the confidence and deep code ownership to actively and politely correct you. Do not tell them this is a test.`
      );
      break;
    case 7:
      baseInstructions.push(
        'OBJECTIVE (Turn 7): Technical Blocker & Debugging. Ask them about the most challenging technical blocker or bug they faced during this hackathon, and how they went about debugging and solving it.'
      );
      break;
    case 8:
      baseInstructions.push(
        'OBJECTIVE (Turn 8): Wrap-up & Future Scope. Ask them about the future scope of this project, how it can be scaled for real-world production or expanded into a commercial product, and what features they would add next.'
      );
      break;
    default:
      baseInstructions.push(
        'Use the conversation history to ask exactly one concise follow-up technical question relative to their hackathon project.'
      );
  }

  return baseInstructions.join('\n');
}

export function buildJudgeSystemPrompt(criteria: MetricConfig[]): string {
  const rubricLines = criteria
    .map((criterion) => {
      const description = criterion.description ? ` Description: ${criterion.description}` : '';
      return `- ${criterion.name} (weight ${criterion.weight}%):${description}`;
    })
    .join('\n');

  return [
    'You are the Judge LLM for a mock interview platform.',
    'Evaluate the full interview transcript using the rubric below.',
    'Answer quality dominates the score.',
    'If the answer is off-topic, incorrect, unsupported, evasive, or does not address the question, keep scores in the 0 to 3 range.',
    'Do not reward length alone.',
    'Do not inflate scores for polite but irrelevant answers.',
    'Some user answers might begin with waveform statistics, e.g., `[Silence: X.Xs, Pauses: Y, Max Pause: Z.Zs]`. Use these physical hesitation markers to penalize or adjust scores for Communication, Confidence, and Fluency where appropriate.',
    'Return strictly valid JSON and nothing else.',
    'The JSON object must have these keys:',
    '{',
    '  "criteria": { "<metric name>": { "score": number from 0 to 10, "feedback": string } },',
    '  "summary": string,',
    '  "strengths": string[],',
    '  "improvements": string[]',
    '}',
    'Rubric:',
    rubricLines
  ].join('\n');
}

export function formatTranscript(turns: InterviewTurnSnapshot[]): string {
  return turns
    .map((turn) => {
      const answer = turn.userAnswer?.trim() || '[no answer recorded]';
      return `Turn ${turn.turnSequence}\nQuestion: ${turn.aiQuestion}\nAnswer: ${answer}`;
    })
    .join('\n\n');
}

export function turnsToChatMessages(turns: InterviewTurnSnapshot[]): ChatMessage[] {
  const messages: ChatMessage[] = [];

  for (const turn of turns) {
    messages.push({ role: 'assistant', content: turn.aiQuestion });

    if (turn.userAnswer && turn.userAnswer.trim().length > 0) {
      messages.push({ role: 'user', content: turn.userAnswer.trim() });
    }
  }

  return messages;
}

export function stripJsonBlock(input: string): string {
  const trimmed = input.trim();

  if (trimmed.startsWith('```')) {
    const withoutFence = trimmed.replace(/^```(?:json)?/i, '').replace(/```$/i, '').trim();
    return withoutFence;
  }

  return trimmed;
}

export function safeParseJudgeOutput(input: string): JudgeOutput {
  const jsonText = stripJsonBlock(input);
  const parsed = JSON.parse(jsonText) as JudgeOutput;

  if (!parsed || typeof parsed !== 'object' || !parsed.criteria || !parsed.summary) {
    throw new Error('Judge output is missing required keys.');
  }

  return parsed;
}

export function calculateWeightedScore(criteria: MetricConfig[], judgeOutput: JudgeOutput): number {
  const weightedTotal = criteria.reduce((total, criterion) => {
    const metricResult = judgeOutput.criteria[criterion.name];
    const score = metricResult ? Number(metricResult.score) : 0;
    return total + score * Number(criterion.weight || 0);
  }, 0);

  return Number((weightedTotal / 100).toFixed(2));
}

export function buildJudgeMessages(transcript: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content: ['Interview transcript:', transcript].join('\n\n')
    }
  ];
}

export function buildFallbackJudgeOutput(criteria: MetricConfig[], transcript: string, topic = ''): JudgeOutput {
  const qualityReport = analyzeTranscript(transcript, topic);
  const qualityCap = Math.max(0, Math.min(10, Math.round(qualityReport.overallConfidence)));

  const judgedCriteria = criteria.reduce<Record<string, { score: number; feedback: string }>>((accumulator, criterion) => {
    const averageSignals = qualityReport.turns[0]?.signals || {
      relevance: 0,
      specificity: 0,
      completeness: 0,
      fluency: 0,
      transcriptConfidence: 0,
      fillerPenalty: 0,
      offTopic: true,
      notes: ['No answer was available to score.']
    };

    const baseScore = Math.min(10, Math.max(0, qualityCap));

    accumulator[criterion.name] = {
      score: baseScore,
      feedback: [
        `Score derived from relevance ${averageSignals.relevance.toFixed(1)}/10, specificity ${averageSignals.specificity.toFixed(1)}/10, completeness ${averageSignals.completeness.toFixed(1)}/10, and fluency ${averageSignals.fluency.toFixed(1)}/10.`,
        `Answer-quality cap: ${qualityCap.toFixed(1)}/10.`,
        averageSignals.offTopic ? 'The answer looked off-topic or evasive, so the score was capped heavily.' : 'The answer stayed on-topic and supported the rubric.'
      ].join(' ')
    };

    return accumulator;
  }, {});

  return {
    criteria: judgedCriteria,
    summary: qualityReport.overallConfidence > 6 ? 'The transcript shows a solid answer with enough relevance and specificity to support a moderate-to-strong score.' : 'The transcript shows weak answer quality, so the score is capped by low relevance or low evidence quality.',
    strengths: qualityReport.turns
      .filter((turn) => turn.signals.transcriptConfidence >= 6)
      .map((turn) => `Turn ${turn.turnSequence} stayed on topic and added concrete detail.`),
    improvements: buildImprovementNotes(qualityReport.turns)
  };
}

const STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'as',
  'at',
  'be',
  'because',
  'but',
  'by',
  'can',
  'could',
  'did',
  'do',
  'does',
  'for',
  'from',
  'had',
  'has',
  'have',
  'he',
  'her',
  'him',
  'his',
  'how',
  'i',
  'if',
  'in',
  'into',
  'is',
  'it',
  'its',
  'me',
  'might',
  'my',
  'no',
  'not',
  'of',
  'on',
  'or',
  'our',
  'so',
  'such',
  'that',
  'the',
  'their',
  'them',
  'then',
  'there',
  'these',
  'they',
  'this',
  'to',
  'up',
  'was',
  'we',
  'were',
  'what',
  'when',
  'where',
  'which',
  'who',
  'why',
  'will',
  'with',
  'would',
  'you',
  'your'
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .map((word) => word.trim())
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word));
}

function uniqueTokens(tokens: string[]): string[] {
  return [...new Set(tokens)];
}

function overlapScore(left: string[], right: string[]): number {
  if (!left.length || !right.length) {
    return 0;
  }

  const rightSet = new Set(right);
  const matches = left.filter((token) => rightSet.has(token));
  return matches.length / Math.max(1, Math.min(left.length, right.length));
}

function hasOffTopicMarkers(answer: string): boolean {
  return /\b(i\s+don'?t\s+know|not\s+sure|no\s+idea|cannot\s+answer|skip|pass|irrelevant)\b/i.test(answer);
}

function isNonAnswerReply(answer: string): boolean {
  const normalized = answer.trim().toLowerCase();

  if (!normalized) {
    return true;
  }

  if (normalized.length <= 12) {
    return /^(thanks|thank you|ok|okay|yes|no|yep|nope|sure|right|cool|got it|all right|alright|fine|maybe|idk)$/i.test(normalized);
  }

  return /\b(thank you|thanks|got it|okay|ok)\b/i.test(normalized) && normalized.split(/\s+/).length <= 4;
}

function fillerPenalty(answer: string): number {
  const fillerMatches = answer.match(/\b(um+|uh+|like|you know|basically|literally|maybe|sort of|kind of)\b/gi)?.length || 0;
  return Math.min(1, fillerMatches * 0.1);
}

function lengthScore(answer: string): number {
  const words = tokenize(answer).length;

  if (words === 0) {
    return 0;
  }

  if (words < 4) {
    return 0.05;
  }

  if (words < 12) {
    return 0.45;
  }

  if (words <= 45) {
    return 1;
  }

  if (words <= 80) {
    return 0.85;
  }

  return 0.65;
}

function specificityScore(answer: string): number {
  const words = tokenize(answer);
  const uniqueWordCount = uniqueTokens(words).length;
  const hasNumbers = /\b\d+\b/.test(answer);
  const hasExamples = /\b(for example|for instance|because|so that|in order to|specifically|for one)\b/i.test(answer);
  const hasTechnicalTerms = /\b(api|database|latency|cache|schema|query|pipeline|deploy|auth|service|thread|async|react|server|client|prisma|postgres|queue|memory|state|component|optimization|monitoring)\b/i.test(answer);

  let score = 0.35;

  if (uniqueWordCount >= 6) score += 0.15;
  if (uniqueWordCount >= 12) score += 0.15;
  if (hasExamples) score += 0.15;
  if (hasNumbers) score += 0.1;
  if (hasTechnicalTerms) score += 0.15;

  return Math.min(1, score);
}

function relevanceScore(question: string, answer: string, topic = ''): number {
  if (hasOffTopicMarkers(answer)) {
    return 0.1; // hard penalty for evasive answers like "I don't know"
  }

  const questionTokens = uniqueTokens(tokenize(question));
  const answerTokens = uniqueTokens(tokenize(answer));
  const topicTokens = uniqueTokens(tokenize(topic));

  const questionOverlap = overlapScore(questionTokens, answerTokens);
  const topicOverlap = overlapScore(topicTokens, answerTokens);
  const technicalSignal = technicalAnswerSignal(answer);
  
  // Softer overlap calculation. Even a tiny overlap indicates relevance
  const overlapBonus = Math.min(0.4, questionOverlap * 0.7 + topicOverlap * 0.2);
  
  // Base relevance for non-evasive answers that are long enough
  const wordsCount = tokenize(answer).length;
  let baseRelevance = 0.45; // Generous 4.5/10 relevance base for non-evasive answers
  if (wordsCount < 4) {
    baseRelevance = 0.2; // very short answers get lower base
  } else if (wordsCount >= 12) {
    baseRelevance = 0.6; // substantial answers are highly likely to be on-topic
  }

  const technicalBoost = technicalSignal * 0.2;

  return Math.max(0, Math.min(1, baseRelevance + overlapBonus + technicalBoost));
}

export function scoreAnswerQuality(question: string, answer: string, topic = ''): number {
  return Number(analyzeAnswer(question, answer, topic).transcriptConfidence.toFixed(2));
}

export function calculateTranscriptQualityCap(transcript: string, topic = ''): number {
  return Number(analyzeTranscript(transcript, topic).overallConfidence.toFixed(2));
}

export function capJudgeOutputByQuality(judgeOutput: JudgeOutput, qualityCap: number): JudgeOutput {
  const cappedCriteria = Object.fromEntries(
    Object.entries(judgeOutput.criteria || {}).map(([name, result]) => {
      const cappedScore = Math.max(0, Math.min(10, Math.min(Number(result.score || 0), qualityCap)));
      const feedbackPrefix = cappedScore < Number(result.score || 0) ? 'Score capped by answer quality. ' : '';

      return [
        name,
        {
          score: Number(cappedScore.toFixed(2)),
          feedback: `${feedbackPrefix}${result.feedback}`.trim()
        }
      ];
    })
  );

  return {
    ...judgeOutput,
    criteria: cappedCriteria
  };
}

export function getLevenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i);
  let currentRow = new Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    currentRow[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const insert = prevRow[j] + 1;
      const deleteCost = currentRow[j - 1] + 1;
      const substitute = prevRow[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      currentRow[j] = Math.min(insert, deleteCost, substitute);
    }
    prevRow = [...currentRow];
  }

  return prevRow[b.length];
}

export function getTextSimilarity(a: string, b: string): number {
  const normA = a.toLowerCase().replace(/[^a-z0-9]/g, '');
  const normB = b.toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!normA && !normB) return 1.0;
  if (!normA || !normB) return 0.0;

  const distance = getLevenshteinDistance(normA, normB);
  const maxLength = Math.max(normA.length, normB.length);
  return 1.0 - distance / maxLength;
}

export function analyzeAnswer(question: string, answer: string, topic = '', originalAnswer?: string | null): AnswerQualitySignals {
  const normalizedAnswer = answer.trim();

  if (!normalizedAnswer) {
    return {
      relevance: 0,
      specificity: 0,
      completeness: 0,
      fluency: 0,
      transcriptConfidence: 0,
      fillerPenalty: 0,
      offTopic: true,
      notes: ['No answer was recorded.']
    };
  }

  if (isNonAnswerReply(normalizedAnswer)) {
    return {
      relevance: 0,
      specificity: 0,
      completeness: 0,
      fluency: 1,
      transcriptConfidence: 0,
      fillerPenalty: 0,
      offTopic: true,
      notes: ['The response was a short acknowledgement rather than an answer.']
    };
  }

  // ─── Transcription Spelling Fix vs Complete Alteration Check ──────
  const cleanMetadata = (text: string) => {
    return text.replace(/^\[Silence:.*?\]/i, '').trim();
  };

  const cleanUser = cleanMetadata(normalizedAnswer);
  const cleanOrig = originalAnswer ? cleanMetadata(originalAnswer) : '';

  let similarityValue = 1.0;
  let isAltered = false;
  let textCorrectionNote = '';
  let cheatPenalty = 0;

  if (cleanOrig) {
    similarityValue = getTextSimilarity(cleanOrig, cleanUser);
    // If similarity drops below 75%, they altered the core answer (lookups/cheating)
    if (similarityValue < 0.75) {
      isAltered = true;
      cheatPenalty = 3.0; // softened cheat penalty for rewrites
      textCorrectionNote = `⚠️ Full Answer Rewrite: Candidate completely rewrote the response (similarity ${Number(similarityValue * 100).toFixed(1)}%). Fallback applied to original transcription for grading.`;
    } else if (similarityValue < 1.0) {
      textCorrectionNote = `✓ Transcription Spelling Corrected (similarity ${Number(similarityValue * 100).toFixed(1)}%).`;
    }
  }

  // If a full answer rewrite is detected, evaluate answer on the original raw Whisper output to prevent cheating!
  const textToScore = isAltered ? cleanOrig : cleanUser;

  const relevance = relevanceScore(question, textToScore, topic) * 10;
  const specificity = specificityScore(textToScore) * 10;
  const completeness = lengthScore(textToScore) * 10;
  const fillerPenaltyValue = fillerPenalty(textToScore);
  const repeatedWordsPenalty = computeRepeatedWordsPenalty(textToScore);
  
  // Waveform silence/pause and tab-switching metrics analysis (using the metadata from the raw answer)
  let extraSilencePenalty = 0;
  let silenceStatsText = '';
  let focusPenalty = 0;
  let cheatStatsText = '';

  const metadataSource = originalAnswer || normalizedAnswer;
  const metadataMatch = metadataSource.match(/^\[Silence:\s*([\d.]+)s,\s*Pauses:\s*(\d+),\s*Max\s*Pause:\s*([\d.]+)s(?:,\s*TabSwitches:\s*(\d+),\s*TabAway:\s*([\d.]+)s)?\]/i);
  if (metadataMatch) {
    const totalSilence = parseFloat(metadataMatch[1]);
    const pauses = parseInt(metadataMatch[2], 10);
    const maxPause = parseFloat(metadataMatch[3]);
    const tabSwitches = parseInt(metadataMatch[4] || '0', 10);
    const tabAway = parseFloat(metadataMatch[5] || '0');

    extraSilencePenalty = Math.min(3.5, pauses * 0.4 + totalSilence * 0.1);
    if (pauses > 0) {
      silenceStatsText = `Physical hesitation detected: ${pauses} quiet pause(s), totaling ${totalSilence}s of silence (longest pause: ${maxPause}s).`;
    }

    if (tabSwitches > 0) {
      focusPenalty = Math.min(6.0, tabSwitches * 2.0 + tabAway * 0.2);
      cheatStatsText = `⚠️ Tab Switch Warning: Candidate lost focus ${tabSwitches} time(s) during this turn, staying away for ${tabAway}s. High lookup probability.`;
    }
  }

  const fluency = Math.max(0, 10 - fillerPenaltyValue * 4.0 - repeatedWordsPenalty * 3.0 - extraSilencePenalty - focusPenalty - cheatPenalty);
  const offTopic = hasOffTopicMarkers(textToScore) || relevance < 2.5 || completeness < 1;

  const transcriptConfidence = Math.max(
    0,
    Math.min(
      10,
      relevance * 0.4 + specificity * 0.25 + completeness * 0.2 + fluency * 0.15 - (offTopic ? 3.5 : 0)
    )
  );

  const notes = [
    offTopic ? 'The answer was low-relevance or too short to support the question.' : 'The answer stayed reasonably on-topic.',
    fillerPenaltyValue > 0 ? 'Filler words or hedging were detected.' : 'No strong filler penalty was detected.',
    repeatedWordsPenalty > 0.2 ? 'Repeated words lowered the fluency estimate.' : 'The transcript read cleanly at the text level.'
  ];

  if (silenceStatsText) {
    notes.push(silenceStatsText);
  }

  if (cheatStatsText) {
    notes.push(cheatStatsText);
  }

  if (textCorrectionNote) {
    notes.push(textCorrectionNote);
  }

  return {
    relevance: Number(relevance.toFixed(2)),
    specificity: Number(specificity.toFixed(2)),
    completeness: Number(completeness.toFixed(2)),
    fluency: Number(fluency.toFixed(2)),
    transcriptConfidence: Number(transcriptConfidence.toFixed(2)),
    fillerPenalty: Number(fillerPenaltyValue.toFixed(2)),
    offTopic,
    notes
  };
}

export function analyzeTranscript(transcript: string, topic = '', originalAnswers?: Array<string | null>): {
  overallConfidence: number;
  turns: TranscriptTurnAnalysis[];
  note: string;
} {
  const blocks = transcript
    .split(/\n\n+/)
    .map((block) => block.trim())
    .filter(Boolean);

  if (!blocks.length) {
    return {
      overallConfidence: 0,
      turns: [],
      note: 'No completed answers were available to score.'
    };
  }

  const turns = blocks.map((block, index) => {
    const question = block.match(/Question:\s*(.*)/i)?.[1] || '';
    const answer = block.match(/Answer:\s*([\s\S]*)/i)?.[1] || '';
    const originalAnswer = originalAnswers?.[index];

    return {
      turnSequence: index + 1,
      question,
      answer,
      signals: analyzeAnswer(question, answer, topic || question, originalAnswer)
    };
  });

  const confidences = turns.map((turn) => turn.signals.transcriptConfidence);
  const relevance = average(turns.map((turn) => turn.signals.relevance));
  const specificity = average(turns.map((turn) => turn.signals.specificity));
  const completeness = average(turns.map((turn) => turn.signals.completeness));
  const fluency = average(turns.map((turn) => turn.signals.fluency));
  const averageConfidence = average(confidences);
  const worstConfidence = Math.min(...confidences);
  const overallConfidence = Math.max(0, Math.min(10, Math.min(averageConfidence, worstConfidence + 2)));

  return {
    overallConfidence: Number(overallConfidence.toFixed(2)),
    turns,
    note: `Transcript confidence is estimated from text only. Relevance ${relevance.toFixed(1)}/10, specificity ${specificity.toFixed(1)}/10, completeness ${completeness.toFixed(1)}/10, fluency ${fluency.toFixed(1)}/10.`
  };
}

export function buildMetricBreakdown(
  criterion: MetricConfig,
  signals: AnswerQualitySignals,
  rawJudgeScore: number,
  qualityCap: number
): MetricScoreBreakdown {
  const finalScore = Number(Math.max(0, Math.min(10, Math.min(rawJudgeScore, qualityCap))).toFixed(2));

  return {
    rawJudgeScore: Number(rawJudgeScore.toFixed(2)),
    qualityCap: Number(qualityCap.toFixed(2)),
    finalScore,
    components: [
      {
        name: 'Relevance',
        value: signals.relevance,
        max: 10,
        note: 'How directly the answer addressed the question and topic.'
      },
      {
        name: 'Specificity',
        value: signals.specificity,
        max: 10,
        note: 'Presence of concrete details, examples, and technical nouns.'
      },
      {
        name: 'Completeness',
        value: signals.completeness,
        max: 10,
        note: 'Whether the answer had enough substance to be meaningful.'
      },
      {
        name: 'Fluency',
        value: signals.fluency,
        max: 10,
        note: 'Text-level smoothness after removing filler pressure.'
      },
      {
        name: 'Raw judge score',
        value: rawJudgeScore,
        max: 10,
        note: `LLM score before the quality cap for ${criterion.name}.`
      },
      {
        name: 'Quality cap',
        value: qualityCap,
        max: 10,
        note: 'Upper bound derived from answer quality signals.'
      }
    ],
    rationale: signals.offTopic
      ? `The answer looked off-topic or evasive, so ${criterion.name} was capped hard.`
      : `The score for ${criterion.name} is based on answer quality first, then the rubric-specific judge score was capped by that quality.`,
    evidence: signals.notes
  };
}

function average(values: number[]): number {
  if (!values.length) {
    return 0;
  }

  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function computeRepeatedWordsPenalty(answer: string): number {
  const words = tokenize(answer);

  if (words.length < 4) {
    return 0;
  }

  let repeated = 0;

  for (let index = 1; index < words.length; index += 1) {
    if (words[index] === words[index - 1]) {
      repeated += 1;
    }
  }

  return Math.min(1, repeated / Math.max(1, words.length - 1));
}

function technicalAnswerSignal(answer: string): number {
  const words = uniqueTokens(tokenize(answer));
  if (!words.length) {
    return 0;
  }

  const technicalMatches = words.filter((word) =>
    /^(api|database|latency|cache|schema|query|pipeline|deploy|auth|service|thread|async|react|server|client|prisma|postgres|queue|memory|state|component|optimization|monitoring|store|frontend|backend|architecture|routing|rendering|caching|performance|tradeoff|components?)$/.test(
      word
    )
  ).length;

  const density = technicalMatches / Math.max(1, words.length);
  const diversity = Math.min(1, technicalMatches / 6);

  return Math.min(1, density * 4 + diversity * 0.4);
}

export function buildScoreNarrative(turns: TranscriptTurnAnalysis[], overallConfidence: number): {
  summary: string;
  strengths: string[];
  improvements: string[];
} {
  const bestTurn = turns.reduce<TranscriptTurnAnalysis | null>((best, current) => {
    if (!best) {
      return current;
    }

    return current.signals.transcriptConfidence > best.signals.transcriptConfidence ? current : best;
  }, null);

  const worstTurn = turns.reduce<TranscriptTurnAnalysis | null>((worst, current) => {
    if (!worst) {
      return current;
    }

    return current.signals.transcriptConfidence < worst.signals.transcriptConfidence ? current : worst;
  }, null);

  const strengths = turns
    .filter((turn) => turn.signals.transcriptConfidence >= 6)
    .map((turn) => `Turn ${turn.turnSequence} was ${turn.signals.offTopic ? 'not' : ''} on topic and had ${turn.signals.specificity.toFixed(1)}/10 specificity.`)
    .slice(0, 3);

  const improvements: string[] = [];

  if (turns.some((turn) => turn.signals.offTopic || turn.signals.relevance < 3)) {
    improvements.push('Answer the question directly before adding extra context.');
  }

  if (turns.some((turn) => turn.signals.specificity < 4)) {
    improvements.push('Add one concrete example, number, system detail, or tradeoff.');
  }

  if (turns.some((turn) => turn.signals.completeness < 4)) {
    improvements.push('Finish the thought with a clear outcome or conclusion.');
  }

  if (turns.some((turn) => turn.signals.fluency < 5)) {
    improvements.push('Reduce hedging and filler language to sound more decisive.');
  }

  if (turns.some((turn) => turn.signals.fillerPenalty > 0.2)) {
    improvements.push('Trim pauses, repeated words, and "um/uh" patterns in the response text.');
  }

  if (!improvements.length) {
    improvements.push('Push for a sharper example, tradeoff, or result in the next answer.');
  }

  const summary =
    overallConfidence >= 7
      ? `Strong answer quality overall. ${bestTurn ? `Best turn: ${bestTurn.turnSequence} at ${bestTurn.signals.transcriptConfidence.toFixed(1)}/10.` : ''}`
      : overallConfidence >= 4
        ? `Mixed answer quality overall. ${bestTurn ? `Best turn: ${bestTurn.turnSequence} at ${bestTurn.signals.transcriptConfidence.toFixed(1)}/10.` : ''} ${worstTurn ? `Weakest turn: ${worstTurn.turnSequence} at ${worstTurn.signals.transcriptConfidence.toFixed(1)}/10.` : ''}`
        : `Low answer quality overall. ${worstTurn ? `Weakest turn: ${worstTurn.turnSequence} at ${worstTurn.signals.transcriptConfidence.toFixed(1)}/10.` : ''}`;

  return {
    summary,
    strengths: strengths.length ? strengths : ['At least one answer stayed readable and captured the interview topic.'],
    improvements: improvements.slice(0, 4)
  };
}

function buildImprovementNotes(turns: TranscriptTurnAnalysis[]): string[] {
  const notes = new Set<string>();

  if (turns.some((turn) => turn.signals.offTopic || turn.signals.relevance < 3)) {
    notes.add('Focus directly on the question before adding supporting detail.');
  }

  if (turns.some((turn) => turn.signals.specificity < 4)) {
    notes.add('Use concrete examples, technical nouns, or measurable tradeoffs.');
  }

  if (turns.some((turn) => turn.signals.fillerPenalty > 0.2)) {
    notes.add('Reduce fillers and hedge phrases to improve confidence.');
  }

  if (turns.some((turn) => turn.signals.completeness < 4)) {
    notes.add('End with the result, impact, or conclusion of the answer.');
  }

  return [...notes].slice(0, 4);
}

export function buildPerAnswerScores(
  turns: TranscriptTurnAnalysis[],
  criteria: MetricConfig[],
  metricJudgeScores: Record<string, number>
): TurnScoreBreakdown[] {
  return turns.map((turn) => {
    const metricScores = Object.fromEntries(
      criteria.map((criterion) => {
        const criterionCap = metricJudgeScores[criterion.name] ?? turn.signals.transcriptConfidence;
        const turnMetricScore = Number(Math.min(criterionCap, turn.signals.transcriptConfidence).toFixed(2));
        return [criterion.name, turnMetricScore];
      })
    );

    const weightedScore = Number(
      (
        criteria.reduce((sum, criterion) => {
          const score = metricScores[criterion.name] ?? 0;
          return sum + score * Number(criterion.weight || 0);
        }, 0) / 100
      ).toFixed(2)
    );

    return {
      turnSequence: turn.turnSequence,
      question: turn.question,
      answer: turn.answer,
      turnQualityScore: Number(turn.signals.transcriptConfidence.toFixed(2)),
      weightedScore,
      weightedPercentage: Number((weightedScore * 10).toFixed(2)),
      metricScores,
      notes: turn.signals.notes
    };
  });
}