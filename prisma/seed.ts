import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma';
import { Pool } from 'pg';

const databaseUrl = process.env.DATABASE_URL;

if (!databaseUrl) {
  throw new Error('DATABASE_URL is required to seed the database.');
}

const prisma = new PrismaClient({
  adapter: new PrismaPg(new Pool({ connectionString: databaseUrl }))
});

async function main() {
  const user = await prisma.user.upsert({
    where: { email: 'seed.candidate@example.com' },
    update: { fullName: 'Seed Candidate' },
    create: {
      email: 'seed.candidate@example.com',
      fullName: 'Seed Candidate'
    }
  });

  const interview = await prisma.interview.create({
    data: {
      userId: user.id,
      initialTopic: 'Prisma onboarding interview',
      status: 'in_progress',
      evaluationCriteria: [
        {
          name: 'Communication',
          weight: 50,
          description: 'Clarity, structure, and concision.'
        },
        {
          name: 'Technical Depth',
          weight: 50,
          description: 'Practical accuracy and depth of reasoning.'
        }
      ]
    }
  });

  await prisma.interviewTurn.createMany({
    data: [
      {
        interviewId: interview.id,
        turnSequence: 1,
        aiQuestion: 'Tell me about a system you shipped recently and the tradeoffs you made.',
        userAnswer: 'I focused on modular design and tightened the API contract to reduce drift.'
      },
      {
        interviewId: interview.id,
        turnSequence: 2,
        aiQuestion: 'What would you improve if you had one more week?',
        userAnswer: 'I would add stronger observability and a better rollout strategy.'
      }
    ]
  });

  console.log(`Seeded interview ${interview.id} for ${user.email}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });