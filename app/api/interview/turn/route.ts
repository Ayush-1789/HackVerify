import { NextRequest, NextResponse } from 'next/server';
import prisma from '@/lib/prisma';
import { buildHackathonFollowUpPrompt, turnsToChatMessages } from '@/lib/interview';
import { createLLMProvider } from '@/lib/llm';
import { createSTTProvider } from '@/lib/stt';

export const runtime = 'nodejs';

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    
    // ─── Transcribe Mode (multipart/form-data) ─────────────────────
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      const audio = formData.get('audio');
      const interviewId = String(formData.get('interviewId') || '');
      const currentTurnId = String(formData.get('currentTurnId') || '');

      // Silence/pause and tab-switching metrics from client-side Web Audio API/focus analysis
      const totalSilence = String(formData.get('totalSilence') || '0');
      const pauses = String(formData.get('pauses') || '0');
      const longestPause = String(formData.get('longestPause') || '0');
      const tabSwitches = String(formData.get('tabSwitches') || '0');
      const tabAwayDuration = String(formData.get('tabAwayDuration') || '0');

      if (!(audio instanceof Blob)) {
        return NextResponse.json({ error: 'Audio blob is required.' }, { status: 400 });
      }

      if (!interviewId || !currentTurnId) {
        return NextResponse.json({ error: 'interviewId and currentTurnId are required.' }, { status: 400 });
      }

      const stt = createSTTProvider();
      let transcribedUserAnswer = '';

      try {
        transcribedUserAnswer = (await stt.transcribe(audio)).trim();
      } catch {
        return NextResponse.json({ error: 'Transcription failed. Please try again.' }, { status: 502 });
      }

      if (!transcribedUserAnswer) {
        return NextResponse.json({ error: 'No speech detected. Please record an answer and try again.' }, { status: 422 });
      }

      let finalAnswer = transcribedUserAnswer;
      if (totalSilence !== '0' || pauses !== '0' || longestPause !== '0' || tabSwitches !== '0' || tabAwayDuration !== '0') {
        finalAnswer = `[Silence: ${totalSilence}s, Pauses: ${pauses}, Max Pause: ${longestPause}s, TabSwitches: ${tabSwitches}, TabAway: ${tabAwayDuration}s] ${transcribedUserAnswer}`;
      }

      return NextResponse.json({
        transcribedUserAnswer: finalAnswer
      });
    }
    
    // ─── Submit Mode (application/json) ────────────────────────────
    const body = (await request.json()) as {
      interviewId?: string;
      currentTurnId?: string;
      userAnswer?: string;
      originalAnswer?: string;
    };

    const { interviewId, currentTurnId, userAnswer, originalAnswer } = body;

    if (!interviewId || !currentTurnId || !userAnswer || !originalAnswer) {
      return NextResponse.json({ error: 'interviewId, currentTurnId, userAnswer, and originalAnswer are required.' }, { status: 400 });
    }

    const currentTurn = await prisma.interviewTurn.findUnique({
      where: { id: currentTurnId }
    });

    if (!currentTurn || currentTurn.interviewId !== interviewId) {
      return NextResponse.json({ error: 'Interview turn not found.' }, { status: 404 });
    }

    // Save final user answer AND raw original transcript separately in DB
    await prisma.interviewTurn.update({
      where: { id: currentTurnId },
      data: {
        userAnswer: userAnswer.trim(),
        originalAnswer: originalAnswer.trim()
      }
    });

    const interview = await prisma.interview.findUnique({
      where: { id: interviewId },
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

    // ─── Graceful End of 8-Turn Progression Flow ─────────────────────
    if (currentTurn.turnSequence >= 8) {
      await prisma.interview.update({
        where: { id: interviewId },
        data: { status: 'completed' }
      });
      
      return NextResponse.json({ completed: true });
    }

    const nextSequence = currentTurn.turnSequence + 1;
    const systemPrompt = buildHackathonFollowUpPrompt(
      nextSequence,
      interview.initialTopic,
      interview.githubCommitsData,
      interview.problemStatementText
    );

    const llm = createLLMProvider();
    const messages = turnsToChatMessages(interview.turns as Array<{ aiQuestion: string; userAnswer: string | null; turnSequence: number; id: string }>);

    let aiQuestion = '';

    try {
      aiQuestion = (
        await llm.complete({
          systemPrompt,
          messages,
          temperature: 0.7,
          maxTokens: 120
        })
      ).trim();
    } catch (llmError) {
      console.error('LLM question generation failed:', llmError);
      aiQuestion = `Regarding your hackathon solution approach, what are the primary engineering hurdles you expect to encounter next?`;
    }

    if (!aiQuestion) {
      aiQuestion = `Regarding your hackathon solution approach, what are the primary engineering hurdles you expect to encounter next?`;
    }

    const nextTurn = await prisma.interviewTurn.create({
      data: {
        interviewId,
        turnSequence: nextSequence,
        aiQuestion
      }
    });

    return NextResponse.json({
      nextTurnId: nextTurn.id,
      aiQuestion: nextTurn.aiQuestion,
      completed: false
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to process interview turn.'
      },
      { status: 400 }
    );
  }
}