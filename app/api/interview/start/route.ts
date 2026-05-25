import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import prisma from '@/lib/prisma';
import { buildHackathonOpeningPrompt, validateMetricWeights } from '@/lib/interview';
import { createLLMProvider } from '@/lib/llm';
import { summarizeCandidateActivity } from '@/lib/github';
import { parsePdfBuffer } from '@/lib/pdf';

export const runtime = 'nodejs';

const metricSchema = z.object({
  name: z.string().min(1),
  weight: z.number(),
  description: z.string().default('')
});

export async function POST(request: NextRequest) {
  try {
    const contentType = request.headers.get('content-type') || '';
    
    let userId = '';
    let fullName = 'Candidate';
    let initialTopic = '';
    let githubUsername = '';
    let githubRepo = '';
    let metrics: any[] = [];
    let problemStatementText: string | null = null;

    // ─── FormData Mode (Supports PDF upload) ─────────────────────────
    if (contentType.includes('multipart/form-data')) {
      const formData = await request.formData();
      userId = String(formData.get('userId') || '');
      fullName = String(formData.get('fullName') || 'Candidate');
      initialTopic = String(formData.get('initialTopic') || '');
      githubUsername = String(formData.get('githubUsername') || '');
      githubRepo = String(formData.get('githubRepo') || '');
      
      const metricsRaw = String(formData.get('metrics') || '[]');
      try {
        metrics = JSON.parse(metricsRaw);
      } catch {
        return NextResponse.json({ error: 'Metrics must be a valid JSON array.' }, { status: 400 });
      }

      const file = formData.get('problemStatementPdf');
      if (file && file instanceof Blob && file.size > 0) {
        try {
          const buffer = Buffer.from(await file.arrayBuffer());
          problemStatementText = await parsePdfBuffer(buffer);
        } catch (pdfError) {
          console.error('PDF extraction failed:', pdfError);
          return NextResponse.json({ error: 'Failed to extract text from the problem statements PDF.' }, { status: 400 });
        }
      }
    } 
    // ─── JSON Mode ───────────────────────────────────────────────────
    else {
      const json = await request.json();
      userId = String(json.userId || '');
      fullName = String(json.fullName || 'Candidate');
      initialTopic = String(json.initialTopic || '');
      githubUsername = String(json.githubUsername || '');
      githubRepo = String(json.githubRepo || '');
      metrics = json.metrics || [];
      problemStatementText = json.problemStatementText || null;
    }

    if (!userId || !initialTopic) {
      return NextResponse.json({ error: 'userId and initialTopic are required.' }, { status: 400 });
    }

    // Validate metrics weights
    validateMetricWeights(metrics);

    // ─── Fetch Candidate Activity ────────────────────────────────────
    let githubCommitsData = null;
    if (githubUsername.trim() && githubRepo.trim()) {
      try {
        githubCommitsData = await summarizeCandidateActivity(githubRepo, githubUsername);
      } catch (githubError) {
        console.error('GitHub API error during setup:', githubError);
        // We do not crash the start route if GitHub fails (e.g. rate limit, down, private repo),
        // we log it and continue with null context.
      }
    }

    const llm = createLLMProvider();
    const prompt = buildHackathonOpeningPrompt(initialTopic, problemStatementText);

    let aiQuestion = '';

    try {
      aiQuestion = (
        await llm.complete({
          systemPrompt: prompt.systemPrompt,
          messages: [{ role: 'user', content: prompt.userPrompt }],
          temperature: 0.7,
          maxTokens: 120
        })
      ).trim();
    } catch (llmError) {
      console.error('LLM question generation failed:', llmError);
      aiQuestion = `Welcome to the mock evaluation! Which problem statement did you select, and what motivated your team to choose it?`;
    }

    if (!aiQuestion) {
      aiQuestion = `Welcome to the mock evaluation! Which problem statement did you select, and what motivated your team to choose it?`;
    }

    const created = await prisma.$transaction(async (tx) => {
      await tx.user.upsert({
        where: { id: userId },
        update: {
          fullName
        },
        create: {
          id: userId,
          email: `${userId}@local.test`,
          fullName
        }
      });

      const interview = await tx.interview.create({
        data: {
          userId,
          initialTopic,
          evaluationCriteria: metrics,
          status: 'in_progress',
          githubUsername: githubUsername.trim() || null,
          githubRepo: githubRepo.trim() || null,
          problemStatementText: problemStatementText || null,
          githubCommitsData: githubCommitsData ? (githubCommitsData as any) : null
        }
      });

      const turn = await tx.interviewTurn.create({
        data: {
          interviewId: interview.id,
          turnSequence: 1,
          aiQuestion
        }
      });

      return { interview, turn };
    });

    return NextResponse.json({
      interviewId: created.interview.id,
      turnId: created.turn.id,
      aiQuestion: created.turn.aiQuestion
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : 'Unable to start hackathon evaluation.'
      },
      { status: 400 }
    );
  }
}