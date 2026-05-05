const express = require("express");
const multer = require("multer");
const fs = require("fs");
const crypto = require("crypto");
const cors = require("cors");
const dotenv = require("dotenv");
const OpenAI = require("openai");
const nspell = require("nspell");

dotenv.config();

fs.mkdirSync("uploads", { recursive: true });

const app = express();
app.use(cors());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

const interviewSessions = new Map();
let englishSpell = null;

app.use(express.json({ limit: "1mb" }));

function loadEnglishSpellChecker() {
  if (englishSpell) {
    return Promise.resolve(englishSpell);
  }

  return import("dictionary-en").then((module) => {
    const dictionary = module.default || module;
    englishSpell = nspell(dictionary);
    return englishSpell;
  });
}

function matchTokenCase(source, target) {
  if (!source || !target) {
    return target;
  }

  const isUpper = source === source.toUpperCase();
  const firstUpper = source[0] === source[0].toUpperCase();

  if (isUpper) {
    return target.toUpperCase();
  }

  if (firstUpper) {
    return target[0].toUpperCase() + target.slice(1);
  }

  return target;
}

function getCorrectionForToken(spell, token, exemptTokens = new Set()) {
  const cleanToken = String(token || "").trim();
  const normalizedToken = cleanToken.toLowerCase();

  if (!cleanToken || cleanToken.length < 2 || /\d/.test(cleanToken)) {
    return cleanToken;
  }

  if (exemptTokens.has(normalizedToken)) {
    return cleanToken;
  }

  if (spell.correct(cleanToken)) {
    return cleanToken;
  }

  const suggestions = spell.suggest(cleanToken);
  if (!suggestions.length) {
    return cleanToken;
  }

  return matchTokenCase(cleanToken, suggestions[0]);
}

function parseJsonResponse(content, fallback) {
  try {
    return JSON.parse(content);
  } catch {
    return fallback;
  }
}

function normalizeOverallScoreOutOf10(value) {
  const raw = Number(value);

  if (!Number.isFinite(raw)) {
    return 5;
  }

  // If model returns percentage style score (e.g., 40), convert to /10.
  const scaled = raw > 10 ? raw / 10 : raw;
  const clamped = Math.max(0, Math.min(10, scaled));

  // Keep one decimal for stable display like 7.5/10.
  return Math.round(clamped * 10) / 10;
}

function normalizeBehavior(behavior) {
  return String(behavior || "").trim().toLowerCase();
}

function getBehaviorMode(behavior) {
  const b = normalizeBehavior(behavior);

  if (/(angry|strict|aggressive|harsh|rude|firm)/i.test(b)) {
    return "rude";
  }

  if (/(soft|gentle|kind|calm|empathetic|supportive|soft-hearted)/i.test(b)) {
    return "soft";
  }

  return "neutral";
}

function getLanguageStyleRules(language, behavior) {
  const lang = String(language || "English").trim().toLowerCase();
  const mode = getBehaviorMode(behavior);

  if (lang === "hindi") {
    if (mode === "rude") {
      return "Use everyday rude/informal Hindi. Address candidate as 'tu/tere/tujhe'. Do not use 'aap' or very formal words.";
    }

    if (mode === "soft") {
      return "Use polite, warm Hindi. Address candidate as 'aap'. Keep tone respectful and supportive.";
    }

    return "Use natural conversational Hindi with normal respectful phrasing ('aap').";
  }

  if (lang === "english") {
    if (mode === "rude") {
      return "Use blunt, everyday spoken English with direct phrasing, contractions, and short tough lines.";
    }

    if (mode === "soft") {
      return "Use warm, friendly spoken English with gentle and encouraging phrasing.";
    }

    return "Use natural professional spoken English.";
  }

  if (mode === "rude") {
    return "Use natural colloquial phrasing in the selected language with a blunt, strict style (not polite/formal wording).";
  }

  if (mode === "soft") {
    return "Use natural colloquial phrasing in the selected language with a warm and respectful style.";
  }

  return "Use natural conversational phrasing in the selected language.";
}

function resolveVoiceProfile(behavior) {
  const b = normalizeBehavior(behavior);

  if (/(angry|strict|aggressive|harsh|rude|firm)/i.test(b)) {
    return {
      voice: "ash",
      styleInstructions: "Sound stern and strict. Speak with sharp emphasis, faster pace, and lower warmth like a tough HR interviewer."
    };
  }

  if (/(soft|gentle|kind|calm|empathetic|supportive|soft-hearted)/i.test(b)) {
    return {
      voice: "nova",
      styleInstructions: "Sound warm, gentle, and calm. Speak with softer energy, reassuring tone, and empathetic HR delivery."
    };
  }

  if (/(confident|assertive|professional|neutral|balanced)/i.test(b)) {
    return {
      voice: "alloy",
      styleInstructions: "Sound confident and professional with balanced warmth and clear authority."
    };
  }

  return {
    voice: "alloy",
    styleInstructions: "Sound professional and clear in an interviewer tone."
  };
}

async function createJsonChatCompletion(messages, fallback) {
  const response = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    messages,
    response_format: { type: "json_object" }
  });

  const content = response.choices[0].message.content || "{}";
  return parseJsonResponse(content, fallback);
}

function buildVoiceInstructions(language, behavior, scenario = "") {
  const lang = (language || "English").trim();
  const persona = (behavior || "professional and balanced").trim();
  const scenarioContext = (scenario || "").trim();
  const profile = resolveVoiceProfile(persona);
  const languageStyle = getLanguageStyleRules(lang, persona);

  return `Speak only in ${lang}. Keep pronunciation natural for ${lang}. Stay in this scenario persona and talk exactly like that person: ${scenarioContext || "Interviewer"}. Do not break character. Deliver this with this behavior: ${persona}. ${languageStyle} ${profile.styleInstructions} Keep emotional delivery consistent for the full sentence. Do not describe your tone; only speak the content.`;
}

async function speakText(text, options = {}) {
  const profile = resolveVoiceProfile(options.behavior);

  const speech = await openai.audio.speech.create({
    model: "gpt-4o-mini-tts",
    voice: profile.voice,
    input: text,
    instructions: buildVoiceInstructions(options.language, options.behavior, options.scenario)
  });

  return Buffer.from(await speech.arrayBuffer()).toString("base64");
}

async function safeSpeakText(text, options = {}) {
  try {
    return await speakText(text, options);
  } catch (error) {
    console.error("TTS failed on first attempt:", error?.message || error);

    try {
      await new Promise((resolve) => setTimeout(resolve, 400));
      return await speakText(text, options);
    } catch (retryError) {
      console.error("TTS failed after retry:", retryError?.message || retryError);
      return null;
    }
  }
}

function languageToWhisperCode(language) {
  const value = String(language || "").trim().toLowerCase();
  const map = {
    english: "en",
    hindi: "hi",
    tamil: "ta",
    telugu: "te",
    bengali: "bn",
    marathi: "mr",
    gujarati: "gu",
    kannada: "kn",
    malayalam: "ml",
    punjabi: "pa",
    urdu: "ur"
  };

  return map[value] || undefined;
}

function isLowSignalTranscript(text) {
  const raw = String(text || "").trim();
  const normalized = raw.toLowerCase();
  const letters = normalized.match(/\p{L}/gu) || [];

  if (!normalized) {
    return true;
  }

  // Ignore ultra-short recognitions that are common when no clear speech is captured.
  if (letters.length < 2) {
    return true;
  }

  // Keep filler-word filtering narrow so non-English text is not wrongly rejected.
  return /^(you|uh|um|hmm|huh|hmmm|hmmmmm|ok|okay)$/.test(normalized);
}

const TOPIC_ASPECTS = [
  // ── Knowledge & Understanding ────────────────────
  "core concepts and fundamentals",           // basic knowledge of the domain
  "depth of understanding",                   // theory, principles, how things work
  "domain-specific terminology and accuracy", // correct use of field terms

  // ── Practical Experience ─────────────────────────
  "real-world experience and examples",       // what they have actually done
  "hands-on skills and execution",            // how they do things practically
  "tools, methods and resources used",        // what they use to get work done

  // ── Problem Solving ──────────────────────────────
  "handling challenges and obstacles",        // how they deal with difficulties
  "troubleshooting and finding root causes",  // diagnosing what went wrong
  "edge cases and unexpected situations",     // what if things go wrong/unusual

  // ── Decision Making ──────────────────────────────
  "decision making and reasoning",            // why they chose one thing over another
  "trade-offs and alternative approaches",    // awareness of other options
  "risk awareness and safety",                // what could go wrong, how to prevent

  // ── Quality & Standards ──────────────────────────
  "quality, accuracy and attention to detail",// how careful and precise they are
  "process, planning and organization",       // how they structure their work
  "learning, growth and self-improvement",    // how they stay updated/improve

  // ── People & Collaboration ───────────────────────
  "teamwork and collaboration",               // working with others
  "communication and explanation skills",     // how clearly they explain things
  "leadership and ownership",                 // taking responsibility, guiding others
];

function buildAspectProgress(history, questionNumber) {
  const answeredCount = Array.isArray(history) ? history.length : 0;

  const consecutiveCrossQuestions = (() => {
    let count = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      if ((history[i].mode || "new_aspect") === "cross_question") count++;
      else break;
    }
    return count;
  })();

  const forceNewAspect = consecutiveCrossQuestions >= 2;

  // Slower progression: every ~2 answers = 1 new aspect (allows 1-2 cross-questions per aspect)
  const aspectIndex = Math.min(
    Math.floor(answeredCount / 2),
    TOPIC_ASPECTS.length - 1
  );

  const coveredAspects = TOPIC_ASPECTS.slice(0, aspectIndex);

  // If forced new aspect, focus on next uncovered one
  const focusIndex = forceNewAspect
    ? Math.min(aspectIndex, TOPIC_ASPECTS.length - 1)
    : Math.min(questionNumber - 1, TOPIC_ASPECTS.length - 1);

  const focusAspect = TOPIC_ASPECTS[focusIndex] || TOPIC_ASPECTS[aspectIndex] || TOPIC_ASPECTS[0];

  return {
    focusAspect,
    coveredAspects,
    remainingAspects: TOPIC_ASPECTS.filter(a => !coveredAspects.includes(a)),
    allAspects: TOPIC_ASPECTS,
    consecutiveCrossQuestions,
    forceNewAspect
  };
}


function forceSingleQuestion(text, topic) {
  const raw = String(text || "").replace(/\s+/g, " ").trim();

  if (!raw) {
    return `What is one practical example of ${topic}?`;
  }

  const cleaned = raw
    .replace(/^[-*\d.)\s]+/, "")
    .replace(/\b(Tip|Suggestion|Advice|Feedback)\s*:\s*.*/i, "")
    .trim();

  if (!cleaned) {
    return `What is one practical example of ${topic}?`;
  }

  const firstSentence = cleaned.split(/(?<=[?.!])\s+/)[0] || cleaned;
  const withoutTrailing = firstSentence.replace(/[.!]+$/, "").trim();

  if (!withoutTrailing) {
    return `What is one practical example of ${topic}?`;
  }

  return /\?$/.test(withoutTrailing) ? withoutTrailing : `${withoutTrailing}?`;
}

async function transcribeAudioFile(filePath, originalName, mimeType, options = {}) {
  const audioFile = await OpenAI.toFile(
    fs.createReadStream(filePath),
    originalName,
    { type: mimeType }
  );

  const languageCode = languageToWhisperCode(options.language);

  let transcription;
  try {
    transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1",
      ...(languageCode ? { language: languageCode } : {})
    });
  } catch (error) {
    const isUnsupportedLanguage =
      error?.code === "unsupported_language" ||
      error?.error?.code === "unsupported_language";

    if (!languageCode || !isUnsupportedLanguage) {
      throw error;
    }

    // Fallback: retry without explicit language so model can auto-detect.
    console.warn(
      `Transcription language '${languageCode}' not supported. Retrying without language hint.`
    );

    transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1"
    });
  }

  return transcription.text || "";
}

async function generateQuestion(topic, history, questionNumber, context = {}) {
  const language = (context.language || "English").trim();
  const scenario = (context.scenario || "").trim();
  const behavior = (context.behavior || "professional and balanced").trim();
  const languageStyle = getLanguageStyleRules(language, behavior);
  const aspectProgress = buildAspectProgress(history, questionNumber);

  const lastEntry = history.length > 0 ? history[history.length - 1] : null;

  // Count consecutive cross-questions from history
  const recentCrossCount = aspectProgress.consecutiveCrossQuestions;

  // Build last few exchanges for context (max 3)
  const recentHistory = history.slice(-3).map((h, i) =>
    `Q: ${h.question}\nA: ${h.answer}\nMode: ${h.mode || "new_aspect"}`
  ).join("\n---\n");

  return createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are conducting a REAL spoken interview for the domain: "${topic}".
Persona: ${scenario || "Senior Interviewer"}. Stay in character. Never break persona.

══════════════════════════════════════════════
YOUR ONLY JOB: Ask the SINGLE best next question
══════════════════════════════════════════════

STEP 1 — READ THE LAST ANSWER CAREFULLY:
${lastEntry
  ? `Last Question: "${lastEntry.question}"
Last Answer: "${lastEntry.answer}"`
  : "This is the first question. Ask about fundamentals."}

STEP 2 — DECIDE: Cross-question OR New Aspect?

CROSS-QUESTION if ANY of these are true about the last answer:
  ✓ Answer was vague ("it handles async stuff", "it's used for performance")
  ✓ Candidate made a claim but gave no example ("I've used Redis in production")
  ✓ Answer had a factual error or assumption worth challenging
  ✓ Answer was incomplete — stopped midway or skipped key part
  ✓ Candidate said something interesting worth digging into
  → Cross-question examples:
    - "You mentioned Redis — what specific eviction policy did you use and why?"
    - "You said it improves performance — can you walk me through a specific case where it did?"
    - "That's not quite right — can you reconsider how the event loop handles microtasks?"

NEW ASPECT if ALL of these are true:
  ✓ Last answer was clear, accurate, and reasonably complete
  ✓ OR cross-questioning has already happened ${recentCrossCount >= 2 ? "2+ times in a row (MUST move on now)" : `${recentCrossCount} time(s) recently`}
  → Next uncovered aspect to focus on: "${aspectProgress.focusAspect}"
  → Already covered: ${aspectProgress.coveredAspects.join(", ") || "none yet"}
  → Remaining: ${aspectProgress.remainingAspects.join(", ")}

${recentCrossCount >= 2
  ? "⚠️ FORCED: You have cross-questioned 2 times in a row. You MUST ask about a NEW aspect now. Do NOT cross-question again."
  : ""}

STEP 3 — STRICT QUESTION RULES:
- Ask EXACTLY ONE question. Never multi-part.
- No hints, feedback, tips, coaching, or praise.
- No code blocks or syntax. Prefer verbal explanation.
- Question must end with '?'
- Language: ${language}. ${languageStyle}
- Sound like a REAL interviewer continuing a live conversation, not reading from a list.

Return JSON: { question, topic, difficulty, mode }
where mode = "cross_question" OR "new_aspect" (your decision based on STEP 2)`
      },
      {
        role: "user",
        content: JSON.stringify({
          topic,
          language,
          scenario,
          behavior,
          questionNumber,
          aspectPlan: aspectProgress,
          recentHistory,
          lastAnswer: lastEntry?.answer || null,
          lastQuestion: lastEntry?.question || null,
          consecutiveCrossQuestions: recentCrossCount,
          forceNewAspect: aspectProgress.forceNewAspect
        })
      }
    ],
    {
      question: `Tell me about your experience with ${topic}.`,
      topic,
      difficulty: 5,
      mode: "new_aspect"
    }
  );
}

async function makeVoiceFriendlyQuestion(topic, question, language, behavior, scenario = "") {
  const languageStyle = getLanguageStyleRules(language, behavior);

  const rewritten = await createJsonChatCompletion(
    [
      {
        role: "system",
        content: `Rewrite interview questions for voice conversation in the field/domain ${topic}. Keep the exact intent but make it naturally speakable. Stay in this exact scenario persona while phrasing: ${scenario || "Interviewer"}. The rewritten question must sound like it is asked by that person only. Rules: output exactly one question only, no statements before or after, no advice, no hints, no feedback, no coaching text, no code blocks, no request for exact syntax, no symbols-heavy prompt. If the original asks to write code, convert it to explain approach verbally. Output must be only in ${language || "English"}. ${languageStyle} The final text must end with '?'. Return JSON with key: question.`
      },
      {
        role: "user",
        content: JSON.stringify({ question })
      }
    ],
    {
      question: `${question} Please explain verbally, no code needed.`
    }
  );

  const speakable = forceSingleQuestion(rewritten.question || question, topic);
return speakable; // direct return, no if needed

  return forceSingleQuestion(`What is one practical concept related to ${topic}`, topic);
}

function fallbackQuestionText(topic) {
  return `What is one practical concept related to ${topic}?`;
}

async function finalAssessment(topic, history, context = {}) {
  const language = (context.language || "English").trim();
  const scenario = (context.scenario || "").trim();
  const behavior = (context.behavior || "professional and balanced").trim();

  const answersBlock = history
    .map((entry, i) =>
      `Q${i + 1}: ${entry.question}\nA${i + 1}: ${String(entry.answer || "(no answer given)").trim()}`
    )
    .join("\n\n");

  return createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are a strict, honest hiring evaluator for the domain: "${topic}".
You will receive numbered Q&A pairs from a voice interview. Evaluate EVERY answer honestly based on what was ACTUALLY said — not what the candidate might have meant.

═══════════════════════════════════════
SCORING RUBRIC — perAnswerScore (0–10)
═══════════════════════════════════════
0.0 – 1.0  → Answer is completely off-topic, random, or the candidate said nothing meaningful. No connection to the question at all.
              EXAMPLE: Asked "What is the event loop?" → Answers "I like JavaScript" or gives unrelated words.

1.0 – 2.5  → Answer is almost entirely wrong or irrelevant. Candidate clearly does not know the topic.
              EXAMPLE: Asked "What is the event loop?" → "It's a loop that runs events in a server."

2.5 – 4.0  → Candidate drops buzzwords or vague phrases but shows no real understanding. Surface-level only.
              EXAMPLE: Asked "What is the event loop?" → "It handles async stuff and callbacks somehow."

4.0 – 5.5  → Basic awareness. Candidate is in the right direction but misses key details or depth.
              EXAMPLE: Asked "What is the event loop?" → "It processes tasks in a queue, I think it's related to async code."

5.5 – 7.0  → Decent answer. Mostly correct with minor gaps or unclear explanation.
              EXAMPLE: Asked "What is the event loop?" → "It processes the call stack and callback queue, letting Node handle async code without blocking."

7.0 – 8.5  → Good answer. Clear, accurate, demonstrates solid understanding.
              EXAMPLE: Asked "What is the event loop?" → Correctly explains call stack, web APIs, callback queue, and microtask queue distinction.

8.5 – 10.0 → Expert answer. Insightful, complete, uses real examples or edge cases confidently.
              EXAMPLE: Asked "What is the event loop?" → Above plus explains microtask priority over macrotasks, gives a real scenario.

═══════════════════════════════════════
STRICT RULES — YOU MUST FOLLOW THESE
═══════════════════════════════════════
1. Score EVERY answer individually in perAnswerScores. Do NOT skip any.
2. NEVER default to 5. If you are tempted to give 5, re-read the answer and pick a more precise score.
3. overallScore = weighted average of perAnswerScores. Do the math explicitly.
4. A candidate who answers 4 questions irrelevantly and 1 correctly scores below 3.0 overall.
5. A candidate who answers mostly well but fumbles one question should still score 6.5+.
6. canProceed = true ONLY if overallScore >= 6.5 AND most answers are relevant and correct.
7. strengths = only list things the candidate ACTUALLY demonstrated. If nothing was good, return [].
8. gaps = be specific. Do not write "needs improvement". Write "Could not explain event loop correctly".

═══════════════════════════════════════
VOICE TRANSCRIPTION TOLERANCE ← NEW
═══════════════════════════════════════
These answers were captured from SPOKEN audio and auto-transcribed by Whisper AI.
Transcription errors are very common in voice interviews. You MUST account for this:

- Evaluate the MEANING and INTENT of the answer, not the exact words typed.
- Common transcription errors to forgive:
    "uvar" or "u var"   → means "var"
    "termination"       → means "declaration"
    "false variable"    → means "const variable"
    "reference error"   → means "ReferenceError"
    "undefined"         → may mean the keyword or the concept
    Broken grammar      → speaker was explaining verbally, not writing
    Filler words        → "like", "basically", "I mean", "sort of" are natural in speech
- If the CORE MEANING of the answer is correct despite transcription noise → score it as correct.
- Do NOT penalize a candidate for words that were clearly mishearing or mis-transcription.
- If unsure whether it is a transcription error or genuine mistake — give benefit of the doubt.

═══════════════════════════════════════
OUTPUT — All text in ${language}
═══════════════════════════════════════
Return JSON:
{
  "canProceed": boolean,
  "verdict": "one-line hiring decision",
  "overallScore": number (0–10, one decimal place),
  "perAnswerScores": [
    {
      "questionNumber": 1,
      "question": "...",
      "answer": "...",
      "score": number (0–10),
      "reason": "one sentence explaining why this score"
    }
  ],
  "summary": "2–3 sentence honest assessment of overall performance",
  "strengths": ["only real demonstrated strengths"],
  "gaps": ["specific weak areas with what was wrong"],
  "recommendation": "what to study or practice"
}

Scenario context: ${scenario || "Senior technical interviewer"}.
Interviewer behavior style: ${behavior}.`
      },
      {
        role: "user",
        content: JSON.stringify({
          topic,
          language,
          scenario,
          behavior,
          totalQuestions: history.length,
          formattedAnswers: answersBlock,
          history
        })
      }
    ],
    {
      canProceed: false,
      verdict: "Unable to evaluate",
      overallScore: 0,
      perAnswerScores: [],
      summary: "Assessment could not be completed.",
      strengths: [],
      gaps: ["Assessment failed — please retry"],
      recommendation: "Please try the interview again."
    }
  );
}

app.post("/api/interview/topic", upload.single("audio"), async (req, res) => {
  const audioPath = req.file?.path;
  const originalName = req.file?.originalname || "topic.webm";
  const mimeType = req.file?.mimetype || "audio/webm";

  if (!audioPath) {
    return res.status(400).json({ error: "Topic audio is required" });
  }

  try {
    const topicRaw = await transcribeAudioFile(audioPath, originalName, mimeType);
    const topic = topicRaw.trim().replace(/[.,!?]+$/g, "");

    if (!topic) {
      return res.status(400).json({ error: "Could not detect topic name" });
    }

    res.json({ topic });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to process topic audio" });
  } finally {
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
  }
});

app.post("/api/interview/start", async (req, res) => {
  try {
    const topic = (req.body?.topic || "").trim();
    const language = (req.body?.language || "English").trim();
    const scenario = (req.body?.scenario || "").trim();
    const behavior = (req.body?.behavior || "professional and balanced").trim();

    if (!topic) {
      return res.status(400).json({ error: "Topic is required" });
    }

    if (!language) {
      return res.status(400).json({ error: "Language is required" });
    }

    if (!scenario) {
      return res.status(400).json({ error: "Scenario prompt is required" });
    }

    if (!behavior) {
      return res.status(400).json({ error: "Behavior is required" });
    }

    const firstQuestion = await generateQuestion(topic, [], 1, {
      language,
      scenario,
      behavior
    });
    const voiceQuestion = await makeVoiceFriendlyQuestion(
      topic,
      firstQuestion.question || fallbackQuestionText(topic),
      language,
      behavior,
      scenario
    );
    const questionAudio = await safeSpeakText(voiceQuestion, {
      language,
      behavior,
      scenario
    });
    const interviewId = crypto.randomUUID();

    interviewSessions.set(interviewId, {
      topic,
      language,
      scenario,
      behavior,
      history: [],
      createdAt: Date.now()
    });

    res.json({
      interviewId,
      questionNumber: 1,
      question: voiceQuestion,
      questionAudio,
      topic: firstQuestion.topic,
      difficulty: firstQuestion.difficulty,
      language,
      scenario,
      behavior
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to start topic interview" });
  }
});

app.post("/api/interview/next", upload.single("audio"), async (req, res) => {
  try {
    const interviewId = (req.body?.interviewId || "").trim();
    const currentQuestion = (req.body?.currentQuestion || "").trim();
    const audioPath = req.file?.path;
    const originalName = req.file?.originalname || "answer.webm";
    const mimeType = req.file?.mimetype || "audio/webm";
    const session = interviewSessions.get(interviewId);

    if (!session) return res.status(400).json({ error: "Interview session not found" });
    if (!currentQuestion) return res.status(400).json({ error: "Question is required" });
    if (!audioPath) return res.status(400).json({ error: "Audio answer is required" });

    const currentAnswer = await transcribeAudioFile(audioPath, originalName, mimeType, {
      language: session.language
    });

    if (!currentAnswer.trim() || isLowSignalTranscript(currentAnswer)) {
      return res.status(400).json({
        error: "Could not clearly transcribe your answer. Please speak a bit longer and try Next again."
      });
    }

    session.history.push({
      question: currentQuestion,
      answer: currentAnswer,
      mode: "new_aspect"   // default before we know the next mode
    });

    const nextQuestionNumber = session.history.length + 1;

    // ✅ Initialize with fallback FIRST — prevents "before initialization" crash
    let nextQuestionText = `Please explain one practical experience related to ${session.topic}.`;
    let nextQuestionTopic = session.topic;
    let nextQuestionDifficulty = 5;
    let nextQuestionMode = "new_aspect";

    try {
      const generated = await generateQuestion(
        session.topic,
        session.history,
        nextQuestionNumber,
        {
          language: session.language,
          scenario: session.scenario,
          behavior: session.behavior
        }
      );

      const rawQuestion = generated.question || fallbackQuestionText(session.topic);

      const voiceNextQuestion = await makeVoiceFriendlyQuestion(
        session.topic,
        rawQuestion,
        session.language,
        session.behavior,
        session.scenario
      );

      nextQuestionText       = voiceNextQuestion || rawQuestion;
      nextQuestionTopic      = generated.topic || session.topic;
      nextQuestionDifficulty = generated.difficulty || 5;
      nextQuestionMode       = generated.mode || "new_aspect";

    } catch (genError) {
      console.error("Question generation failed:", genError?.message || genError);
      // fallback values already set above — continues gracefully
    }

    // Update the last history entry with the actual mode
    session.history[session.history.length - 1].mode = nextQuestionMode;

    const nextQuestionAudio = await safeSpeakText(nextQuestionText, {
      language: session.language,
      behavior: session.behavior,
      scenario: session.scenario
    });

    res.json({
      interviewId,
      questionNumber: nextQuestionNumber,
      history: session.history,
      currentAnswer,
      nextQuestion: nextQuestionText,
      nextQuestionAudio,
      topic: nextQuestionTopic,
      difficulty: nextQuestionDifficulty,
      mode: nextQuestionMode,
      language: session.language,
      scenario: session.scenario,
      behavior: session.behavior
    });

  } catch (error) {
    console.error("NEXT ROUTE ERROR:", error?.message);
    res.status(500).json({ error: "Unable to continue interview", detail: error?.message });
  } finally {
    const audioPath = req.file?.path;
    if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
  }
});

app.post("/api/interview/finish", async (req, res) => {
  try {
    const interviewId = (req.body?.interviewId || "").trim();
    const session = interviewSessions.get(interviewId);

    if (!session) {
      return res.status(400).json({ error: "Interview session not found" });
    }

    if (!session.history.length) {
      return res.status(400).json({ error: "Answer at least one question before finishing" });
    }

    const assessment = await finalAssessment(session.topic, session.history, {
      language: session.language,
      scenario: session.scenario,
      behavior: session.behavior
    });
    assessment.overallScore = normalizeOverallScoreOutOf10(assessment.overallScore);

    // ✅ Add this block
if (Array.isArray(assessment.perAnswerScores)) {
  assessment.perAnswerScores = assessment.perAnswerScores.map(entry => ({
    ...entry,
    score: normalizeOverallScoreOutOf10(entry.score ?? 0)
  }));

  // Recalculate overallScore from per-answer math for consistency
  if (assessment.perAnswerScores.length > 0) {
    const avg = assessment.perAnswerScores.reduce((sum, e) => sum + e.score, 0)
                / assessment.perAnswerScores.length;
    assessment.overallScore = Math.round(avg * 10) / 10;
  }
}
    const assessmentAudio = await safeSpeakText(
      `${assessment.verdict}. ${assessment.summary} Recommendation: ${assessment.recommendation}.`
      , {
        language: session.language,
        behavior: session.behavior,
        scenario: session.scenario
      }
    );

    interviewSessions.delete(interviewId);
    res.json({
      topic: session.topic,
      language: session.language,
      scenario: session.scenario,
      behavior: session.behavior,
      history: session.history,
      assessment,
      assessmentAudio
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to finish interview" });
  }
});

app.post("/api/spellcheck", async (req, res) => {
  try {
    const text = String(req.body?.text || "");
    const exemptTokens = new Set(
      Array.isArray(req.body?.exemptTokens)
        ? req.body.exemptTokens.map((token) => String(token || "").trim().toLowerCase()).filter(Boolean)
        : []
    );

    if (!text.trim()) {
      return res.json({ correctedText: text, changed: false });
    }

    const spell = await loadEnglishSpellChecker();
    const correctedText = text.replace(/[A-Za-z']+/g, (token) => {
      return getCorrectionForToken(spell, token, exemptTokens);
    });

    return res.json({
      correctedText,
      changed: correctedText !== text
    });
  } catch (error) {
    console.error("Spellcheck failed:", error?.message || error);
    return res.status(500).json({ error: "Spellcheck service unavailable" });
  }
});

// 🎤 Voice Interview API
app.post("/interview", upload.single("audio"), async (req, res) => {
  const audioPath = req.file?.path;
  const originalName = req.file?.originalname || "audio.webm";
  const mimeType = req.file?.mimetype || "audio/webm";

  if (!audioPath) {
    return res.status(400).send("No audio file uploaded");
  }

  try {
    const audioFile = await OpenAI.toFile(
      fs.createReadStream(audioPath),
      originalName,
      { type: mimeType }
    );

    // 1️⃣ Speech to Text (Whisper)
    const transcription = await openai.audio.transcriptions.create({
      file: audioFile,
      model: "whisper-1"
    });

    const userText = transcription.text;

    // 2️⃣ AI Interview + Evaluation
    const aiResponse = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content: `
You are a professional interviewer.

Ask next interview question AND evaluate user's answer.

Return response in JSON:
{
  "reply": "next question or response",
  "score": number (1-10),
  "grammar": number,
  "confidence": number,
  "technical": number,
  "feedback": "short feedback"
}
`
        },
        {
          role: "user",
          content: userText
        }
      ]
    });

    const content = aiResponse.choices[0].message.content;

    let parsed;
    try {
      parsed = JSON.parse(content);
    } catch {
      parsed = {
        reply: content,
        score: 5,
        grammar: 5,
        confidence: 5,
        technical: 5,
        feedback: "Could not parse structured response"
      };
    }

    // 3️⃣ Text to Speech
    const speech = await openai.audio.speech.create({
      model: "gpt-4o-mini-tts",
      voice: "alloy",
      input: parsed.reply
    });

    const audioBuffer = Buffer.from(await speech.arrayBuffer());

    // 4️⃣ Send Response
    res.json({
      userText,
      aiText: parsed.reply,
      scores: {
        score: parsed.score,
        grammar: parsed.grammar,
        confidence: parsed.confidence,
        technical: parsed.technical
      },
      feedback: parsed.feedback,
      audio: audioBuffer.toString("base64")
    });

  } catch (error) {
    console.error(error);
    res.status(500).send("Error processing interview");
  } finally {
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
  }
});

const port = process.env.PORT || 3000;

app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});