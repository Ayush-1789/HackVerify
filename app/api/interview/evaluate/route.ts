import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import {
  capJudgeOutputByQuality,
  analyzeTranscript,
  buildMetricBreakdown,
  buildPerAnswerScores,
  buildScoreNarrative,
  buildJudgeMessages,
  buildFallbackJudgeOutput,
  buildJudgeSystemPrompt,
  calculateWeightedScore,
  formatTranscript,
  safeParseJudgeOutput
} from '@/lib/interview';
import { createLLMProvider } from '@/lib/llm';
import type { MetricConfig, ScoringMetricsPayload, JudgeOutput } from '@/lib/types';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as { interviewId?: string };

    if (!body.interviewId) {
      return NextResponse.json({ error: 'interviewId is required.' }, { status: 400 });
    }

    const interview = await prisma.interview.findUnique({
      where: { id: body.interviewId },
      include: {
        turns: {
          orderBy: {
            turnSequence: 'asc'
          }
        }
      }
    });

    if (!interview) {
      return NextResponse.json({ error: 'Interview not found.' }, { status: 404 });
    }

    const criteria = interview.evaluationCriteria as MetricConfig[];
    const completedTurns = interview.turns.filter((turn) => turn.userAnswer && turn.userAnswer.trim().length > 0);

    if (!completedTurns.length) {
      return NextResponse.json({ error: 'At least one completed answer is required before evaluation.' }, { status: 400 });
    }

    const transcript = formatTranscript(
      completedTurns.map((turn) => ({
        id: turn.id,
        turnSequence: turn.turnSequence,
        aiQuestion: turn.aiQuestion,
        userAnswer: turn.userAnswer,
        createdAt: turn.createdAt
      }))
    );
    const qualityReport = analyzeTranscript(
      transcript,
      interview.initialTopic,
      completedTurns.map((turn) => turn.originalAnswer)
    );
    const answerQualityCap = qualityReport.overallConfidence;
    const scoreNarrative = buildScoreNarrative(qualityReport.turns, qualityReport.overallConfidence);

    const llm = createLLMProvider();
    let rawJudgeOutput = '';
    let judgeOutput: JudgeOutput;

    try {
      rawJudgeOutput = await llm.complete({
        systemPrompt: buildJudgeSystemPrompt(criteria),
        messages: buildJudgeMessages(transcript),
        temperature: 0.2,
        maxTokens: 1200
      });

      judgeOutput = safeParseJudgeOutput(rawJudgeOutput);
    } catch (error) {
      rawJudgeOutput = error instanceof Error ? error.message : 'LLM judge unavailable';
      judgeOutput = buildFallbackJudgeOutput(criteria, transcript, interview.initialTopic);
    }

    const rawMetricScores = Object.fromEntries(
      criteria.map((criterion) => [
        criterion.name,
        Number(judgeOutput.criteria[criterion.name]?.score || 0)
      ])
    );

    judgeOutput = capJudgeOutputByQuality(judgeOutput, answerQualityCap);

    const metricBreakdowns = Object.fromEntries(
      criteria.map((criterion) => {
        const rawJudgeScore = Number(judgeOutput.criteria[criterion.name]?.score || 0);
        return [
          criterion.name,
          buildMetricBreakdown(
            criterion,
            qualityReport.turns[0]?.signals || {
              relevance: 0,
              specificity: 0,
              completeness: 0,
              fluency: 0,
              transcriptConfidence: 0,
              fillerPenalty: 0,
              offTopic: true,
              notes: ['No answer was available to score.']
            },
            rawJudgeScore,
            answerQualityCap
          )
        ];
      })
    );

    const metricJudgeScores = Object.fromEntries(
      criteria.map((criterion) => [criterion.name, Number(judgeOutput.criteria[criterion.name]?.score || 0)])
    );

    const perAnswerScores = buildPerAnswerScores(qualityReport.turns, criteria, rawMetricScores);

    const weightedScore = calculateWeightedScore(criteria, judgeOutput);
    const scoringMetrics: ScoringMetricsPayload = {
      ...judgeOutput,
      summary: scoreNarrative.summary,
      strengths: scoreNarrative.strengths,
      improvements: scoreNarrative.improvements,
      weightedScore,
      weightedPercentage: Number((weightedScore * 10).toFixed(2)),
      evaluatedAt: new Date().toISOString(),
      rawJudgeOutput,
      answerQualityCap,
      qualitySignals: {
        relevance: Number((qualityReport.turns[0]?.signals.relevance || 0).toFixed(2)),
        specificity: Number((qualityReport.turns[0]?.signals.specificity || 0).toFixed(2)),
        completeness: Number((qualityReport.turns[0]?.signals.completeness || 0).toFixed(2)),
        fluency: Number((qualityReport.turns[0]?.signals.fluency || 0).toFixed(2)),
        transcriptConfidence: Number(answerQualityCap.toFixed(2)),
        fillerPenalty: Number((qualityReport.turns[0]?.signals.fillerPenalty || 0).toFixed(2)),
        offTopic: Boolean(qualityReport.turns[0]?.signals.offTopic),
        notes: [qualityReport.note, ...(qualityReport.turns[0]?.signals.notes || [])]
      },
      metricBreakdowns,
      turnAnalysis: qualityReport.turns,
      perAnswerScores,
      scoreNarrative
    };

    await prisma.interview.update({
      where: { id: body.interviewId },
      data: {
        scoringMetrics,
        status: 'completed'
      }
    });

    return NextResponse.json({ scoringMetrics });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to evaluate interview.'
      },
      { status: 400 }
    );
  }
}