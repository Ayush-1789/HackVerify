# 🎙️ AI Mock Interview Platform for Hackathon Evaluations

A premium, modular voice-based mock interview platform built with **Next.js App Router**, **Prisma**, **PostgreSQL**, and advanced client-server heuristics to conduct technical evaluations for hackathons.

This platform assesses hackathon candidates over an **8-Turn Progression Flow**, evaluating their system design, tech stack choice, and deep code ownership by fetching and asking questions directly about their **GitHub commits** and modified files, while utilizing advanced real-time anti-cheat and waveform hesitation tracking.

---

## 🚀 Quick Start & Setup

### 1. Prerequisites & Installation
* Node.js v18+ and PostgreSQL installed.
* Clone the repository and install dependencies:
  ```bash
  npm install
  ```

### 2. Configure Environment Variables
Copy `.env.example` to `.env` and set your credentials:
```env
DATABASE_URL="postgresql://postgres:password@localhost:5432/interview_db?schema=public"

# LLM Providers Configuration (Switch between gemini | groq | openai | local)
LLM_PROVIDER=groq
GROQ_API_KEY="gsk_your_key_here"
# Default Model utilized: llama-3.3-70b-versatile

# Speech-to-Text Configuration (Switch between groq-whisper | openai-whisper | local-whisper)
STT_PROVIDER=groq-whisper

# GitHub Personal Access Token (for fetching candidate commit histories)
GITHUB_TOKEN="ghp_your_personal_access_token"
```

### 3. Database Migrations
Initialize your database schema using Prisma:
```bash
npx prisma generate
npx prisma migrate dev --name init
```

### 4. Running Locally
Start the Next.js development server:
```bash
npm run dev
```
Open [http://localhost:3000](http://localhost:3000) to view the recruiter cockpit and candidate interview dashboard.

---

## 🔄 Provider Configuration Matrix

The platform is designed with a provider-factory architecture to allow seamless, zero-downtime hot-swapping of LLM and STT engines in the `.env` file:

| Variable | Approved Options | Description |
| :--- | :--- | :--- |
| `LLM_PROVIDER` | `gemini` \| `groq` \| `openai` \| `local` | Governs follow-up question generation and final Judge LLM grading. Uses `llama-3.3-70b-versatile` under Groq for optimal latency-to-quality performance. |
| `STT_PROVIDER` | `groq-whisper` \| `openai-whisper` \| `local-whisper` | Transcribes candidate speech recordings to text. |
| **TTS Engine** | *Native browser API* | Utilizes standard Web Speech Synthesis for high-performance, client-side Text-to-Speech playback. |

---

## 📐 End-to-End System Architecture

The following diagram illustrates the complete, secure turn-based lifecycle of an interview session, detailing the client-side tracking and server-side verification:

```mermaid
graph TD
    A[AI Generates & Speaks Question via TTS] --> B[Recording Starts Automatically]
    B --> C[Real-Time Waveform & Window Focus Tracking]
    C --> D[Stop Recording & Send Audio Blob to Server]
    D --> E[Whisper Transcribes Response & Appends Metadata Bracket]
    E --> F[Interactive Review Panel: Clipboard Locked Text Box]
    F --> G[Candidate Submits Edited Answer]
    G --> H[Server Similarity Check: Edited vs. Original Whisper]
    H --> I{Similarity >= 75%?}
    I -- Yes: Spelling Fix --> J[Evaluate on Edited Text]
    I -- No: Answer Rewrite Cheat --> K[Fallback to Raw Whisper + Deduct 3.0 Fluency + Log Warning]
    J --> L[Local Quality Scoring & Next Question Generation]
    K --> L
    L --> M[Candidate Completes Interview]
    M --> N[LLM Judge Rubric Evaluation]
    N --> O[Score Capped by local Quality Cap]
    O --> P[Persisted Final Recruiter Report]
```

---

## 🎙️ 1. Real-Time Waveform Silence & Pause Analysis

To evaluate hesitation, confidence, and articulation fluency, the browser-side interface performs real-time frequency-domain waveform analysis during candidate recording.

### Technical Implementation:
* **API Utilized**: HTML5 Web Audio API `AudioContext` and `AnalyserNode` connected to the candidate's active microphone input stream.
* **Fast Fourier Transform (FFT) Size**: Set to `256`, producing `128` frequency bin magnitudes.
* **Sampling Rate**: Every `100ms`, the browser sums and averages all frequency bin magnitudes (`avgVolume` out of `255`).
* **Hesitation & Silence Thresholds**:
  * **Physical Silence**: Average magnitude `< 12` registers as silent recording frame.
  * **Pause (Hesitation)**: Triggered when a physical silence streak lasts continuously for $\ge 1000\text{ ms}$ (1.0 second).
* **Tracked Metrics**:
  1. `totalSilence`: Cumulative duration (in seconds) spent in physical silence.
  2. `pauses`: The integer count of continuous hesitations ($\ge 1.0\text{s}$).
  3. `longestPause`: The duration of the single longest hesitation in seconds.

---

## 🛡️ 2. Anti-Cheat Browser Window Focus Tracker

To identify if a candidate is opening external tabs, looking up definitions, or reading pre-written answers during recording, browser-level events monitor focus status.

### Technical Implementation:
* **API Listeners**: Listens directly to `visibilitychange` (HTML5 Page Visibility API), `blur`, and `focus` events when recording starts.
* **State Protection Guard**: Utilizes an `activeFocusLossRef` boolean state manager. If a focus loss is detected on `visibilitychange` or `blur`, the platform registers the loss only if the state is set to active focus (`activeFocusLossRef.current = false`), preventing double-counting of single focus events.
* **Tracked Metrics**:
  1. `tabSwitches`: The count of focus loss events recorded during the turn.
  2. `tabAwayDuration`: The cumulative time (in seconds) spent away from the browser, measured using `performance.now()`.
* **Cleanup**: All window event listeners are aggressively dismantled on stop recording, component unmount, or interview resets to prevent memory leaks.

---

## 🔒 3. Transcription Review & Clipboard Lockout

After a recording completes, the browser sends the audio blob and physical telemetry to `POST /api/interview/turn` (Transcribe Mode). The server transcribes the speech via Whisper and returns the text prepended with a metadata bracket:
`[Silence: X.Xs, Pauses: Y, Max Pause: Z.Zs, TabSwitches: A, TabAway: B.Bs] <Raw Transcript>`

### Review Panel Safeguards:
1. **Interactive Review**: The candidate reviews the transcribed text to fix minor spelling errors. While review is active (`isVerifying = true`), window focus listeners are disabled so candidates are not penalized for benign actions post-recording.
2. **Clipboard Lockout**: The textbox disables all copy, paste, and cut commands to block candidates from pasting pre-written or AI-generated responses:
   ```typescript
   onCopy={(e) => e.preventDefault()}
   onPaste={(e) => {
     e.preventDefault();
     setErrorMessage('Copy, paste, and cut are disabled in the transcription review box...');
   }}
   onCut={(e) => e.preventDefault()}
   ```
3. **Reconstruction**: Upon submission, the client extracts the original silence/focus metadata bracket and pre-prepends it to the candidate's edited text, sending the combined string back to the server in **Submit Mode**.

---

## 🔒 4. Anti-Alteration Server Heuristic (Similarity Check)

Upon receiving the edited response (`userAnswer`) and the original raw Whisper output (`originalAnswer`), the server performs an anti-alteration similarity assessment to identify lookup cheats or complete answer rewrites.

### Heuristic Algorithm: Row-Optimized Levenshtein Distance
To compute character-level similarity without memory overhead, we implement a row-optimized Levenshtein Distance algorithm utilizing $O(\min(N,M))$ memory space rather than a full $O(N \times M)$ table:

```typescript
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
```

* **Preprocessing**: Both strings are stripped of metadata, converted to lowercase, and cleared of punctuation or whitespace: `text.toLowerCase().replace(/[^a-z0-9]/g, '')`.
* **Similarity Ratio Formula**:
  $$\text{Similarity} = 1.0 - \frac{\text{Levenshtein Distance}}{\max(\text{Length}_a, \text{Length}_b)}$$

### Threshold Classification:
* **Spelling Correction ($\ge 75\%$ Similarity)**:
  * Approved as a benign spelling/transcription adjustment.
  * The final grading evaluations are run directly on the **edited text** (`userAnswer`).
* **Full Answer Rewrite Cheat ($< 75\%$ Similarity)**:
  * Classified as an infraction (candidate completely rewrote their spoken answer).
  * **Fallback Enforcement**: The server discards the edited text and **evaluates the raw Whisper transcription** (`originalAnswer`) to score their actual spoken performance.
  * **Cheat Penalty**: A heavy **fluency penalty (-3.0)** is applied.
  * Logs a severe warning: `⚠️ Full Answer Rewrite: Candidate completely rewrote the response (similarity X%). Fallback applied to original transcription.`

---

## 📈 5. Automated Local Quality Scoring (`lib/interview.ts`)

Before the final LLM Judge is called, the server calculates objective quality signals based on text attributes, hesitations, and tab switches:

### 1. Relevance ($0.0 - 10.0$)
Scores token overlaps between the unique tokens in the Question, Topic, and Answer.
* **Softer Overlap Math**: `Math.min(0.4, questionOverlap * 0.7 + topicOverlap * 0.2)` plus technical term boosts.
* **Base Relevance Protection**: Normal non-evasive answers receive a generous base relevance of `0.45` (short answers) or `0.6` (answers $\ge 12$ words) to prevent natural answers from getting extremely low relevance scores. Evasive answers (e.g., *"I don't know"*) are heavily penalized to `0.1`.

### 2. Specificity ($0.0 - 10.0$)
Assesses response detail using vocabulary variety, technical terms, and transitional examples:
* **Base**: `0.35`
* **Boosts**: Unique word counts $\ge 6$ (`+0.15`), $\ge 12$ (`+0.15`), presence of transitional examples (`+0.15`), numbers (`+0.1`), and industry technical terms like *API, postgres, query, latency, optimize* (`+0.15`).

### 3. Completeness ($0.0 - 10.0$)
Optimized for succinct, high-quality responses:
* Ideal length of $15 - 45$ words gives full `10.0`.
* Word count $12-14$ (`4.5`), $< 4$ words (`0.5`). Extremely verbose answers ($> 80$ words) are slightly discouraged (`6.5` score) to promote concise engineering communication.

### 4. Fluency ($0.0 - 10.0$)
Starts at a perfect `10.0` and applies deductions:
* **Filler Words**: Deducts `-0.1` per filler occurrence (e.g. *um, uh, like, you know, basically*) scaled by **4.0x** (yielding `-0.4` per occurrence).
* **Word Repetition**: immediate word stutters scaled by **3.0x**.
* **Waveform Silence**: Deducts `-0.4` per pause ($\ge 1.0\text{s}$) and `-0.1` per cumulative second of silence (max silence deduction capped at `-3.5`).
* **Tab Switches**: Deducts `-2.0` per focus loss and `-0.2` per cumulative second spent away (max tab loss deduction capped at `-6.0`).
* **Cheat Rewrite Infraction**: Deducts `-3.0` directly.
* **Fluency Formula**:
  $$\text{Fluency} = \max\left(0, 10.0 - 4.0 \times \text{FillerPenalty} - 3.0 \times \text{RepeatedWordsPenalty} - \text{SilencePenalty} - \text{TabLossPenalty} - \text{RewritePenalty}\right)$$

### 5. Transcript Quality Cap ($0.0 - 10.0$)
Blends all local signals to determine the absolute maximum score the candidate can receive:
$$\text{Quality Cap} = \text{Relevance} \times 0.4 + \text{Specificity} \times 0.25 + \text{Completeness} \times 0.2 + \text{Fluency} \times 0.15 - \text{OffTopicPenalty}$$
* **Off-Topic Penalty**: An additional `-3.5` is deducted if the answer is evasive, or if Relevance $< 2.5$, or if Completeness $< 1.0$.

---

## 🎓 6. Judge LLM Final Evaluation & Capping

At the completion of the mock interview, the **Judge LLM** evaluates the entire session transcript. 

### 1. Customizable Recruiter Rubrics
Recruiters can customize the criteria and weights in the recruiter dashboard before launching an interview. The platform seeds the following industry-standard default weights:
* **Problem Clarity (20%)**: Does the candidate understand the problem statement deeply?
* **Solution Ownership (25%)**: Can they defend their architectural choices?
* **Code Comprehension (40%)**: Can they explain specific code files and modifications?
* **Communication (15%)**: Clarity and articulation confidence.

### 2. Anti-Inflation Programmatic Capping
To prevent the Judge LLM from inflating scores for polite but shallow, hesitant, or cheated transcripts, every metric returned by the LLM is programmatically capped:
$$\text{Final Score} = \min\left(\text{LLM Score}, \text{Transcript Quality Cap}\right)$$
The final weighted score is then computed:
$$\text{Final Weighted Score} = \frac{\sum \left(\text{Final Score}_i \times \text{Weight}_i\right)}{100}$$

---

## 🔄 The 8-Turn Progression Steering Flow

The mock interview proceeds through a carefully structured 8-turn sequence to comprehensively evaluate a candidate's hackathon project:

```
[Turn 1: Problem Selection & Motivation]
  ├── (Prompted using the uploaded Problem Statements PDF)
  └── Motive for selecting this statement over other options.
          ↓
[Turn 2: Tech Stack Justification]
  └── Frameworks, database, programming language, and why optimal.
          ↓
[Turn 3: System Design & Architecture]
  └── Progress so far and core architectural system design choice.
          ↓
[Turn 4: Deep Code Commit Evaluation #1]
  └── AI reads candidate's cached GitHub commit history, identifies 
      a modified file, and asks a deep technical question on their logic.
          ↓
[Turn 5: Deep Code Commit Evaluation #2]
  └── Evaluates a different modified file or structural code pattern 
      from their commit history, probing role and implementation details.
          ↓
[Turn 6: Wrong-Answer Probing (Confidence & Ownership Test)]
  └── AI suggests a slightly incorrect interpretation of their commit code 
      (e.g., 'Looking at file Y, it seems you do X to solve Z?') to see 
      if they have the confidence and deep code ownership to correction-verify.
          ↓
[Turn 7: Technical Blocker & Debugging]
  └── Challenging bugs faced during the hackathon and how they debugged.
          ↓
[Turn 8: Wrap-up & Future Scope]
  └── How the project can scale for production and visionary commercial potential.
```

---

## 🎨 Recruiter Reporting Badges (UI/UX)

The recruiter cockpit visualizes candidate scores alongside clear telemetry indicator badges:

| Badge | Condition Trigger | Visual Style |
| :--- | :--- | :--- |
| **`✓ Spelling Corrected`** | $\ge 75\%$ similarity & edited | Emerald green pill showing similarity % |
| **`⚠️ Full Answer Rewrite`** | $< 75\%$ similarity | Pulsing red/rose warning badge |
| **`⚠️ Tab Switched`** | Focus loss detected during recording | Pulsing orange/red warning with total duration |
| **`⏳ Silence & Pauses`** | Waveform silence metrics exceeded | Slate grey info badge with total silence time |