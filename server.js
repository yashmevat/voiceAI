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

function getCorrectionForToken(spell, token) {
  const cleanToken = String(token || "").trim();

  if (!cleanToken || cleanToken.length < 2 || /\d/.test(cleanToken)) {
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
    console.error("TTS failed:", error?.message || error);
    return null;
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
    punjabi: "pu",
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
  "fundamentals",
  "real-world workflow",
  "tools and implementation",
  "debugging and troubleshooting",
  "edge cases",
  "trade-offs and decision making",
  "performance and scalability",
  "communication and collaboration"
];

function buildAspectProgress(history, questionNumber) {
  const answeredCount = Array.isArray(history) ? history.length : 0;
  const targetIndex = Math.max(0, Math.min(TOPIC_ASPECTS.length - 1, questionNumber - 1));
  const focusAspect = TOPIC_ASPECTS[targetIndex] || TOPIC_ASPECTS[0];
  const coveredAspects = TOPIC_ASPECTS.slice(0, Math.min(answeredCount, TOPIC_ASPECTS.length));

  return {
    focusAspect,
    coveredAspects,
    remainingAspects: TOPIC_ASPECTS.filter((item) => !coveredAspects.includes(item)),
    allAspects: TOPIC_ASPECTS
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

  return createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are doing strict role-play Q&A in the field/domain: ${topic}. The scenario defines WHO you are (for example HR, doctor, CEO, manager). You MUST become that person and stay in character for every question. Do not act like a generic practice bot and do not break persona. Ask exactly one question at a time, and return only one question. NEVER include suggestions, hints, feedback, coaching, evaluation, explanation, or extra lines. NEVER repeat any previous question intent already present in history. Each next question must cover a NEW topic aspect not already covered. Keep wording short, clear, and conversational for spoken answers. The question must be easy to answer verbally. Do not ask for typed code, punctuation-heavy syntax, or long written snippets. Prefer conceptual, scenario-based, and step-by-step explanation questions. The interview language is ${language}. Always ask only in ${language}. Behavior style to apply: ${behavior}. ${languageStyle} Scenario/persona to mimic: ${scenario || "No extra context provided."}. The question must end with '?'. Return JSON with keys: question, topic, difficulty.`
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
          history
        })
      }
    ],
    {
      question: `Question ${questionNumber} for ${topic}`,
      topic,
      difficulty: 5
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
  if (speakable) {
    return speakable;
  }

  return forceSingleQuestion(`What is one practical concept related to ${topic}`, topic);
}

function fallbackQuestionText(topic) {
  return `What is one practical concept related to ${topic}?`;
}

async function finalAssessment(topic, history, context = {}) {
  const language = (context.language || "English").trim();
  const scenario = (context.scenario || "").trim();
  const behavior = (context.behavior || "professional and balanced").trim();

  return createJsonChatCompletion(
    [
      {
        role: "system",
        content: `You are giving a final hiring-style assessment for an interview in the field/domain ${topic}. Decide whether the candidate is ready to work in this field/domain based on the conversation so far. The interview language is ${language}, so all output must be in ${language}. Use this scenario context: ${scenario || "No extra context provided."}. The interviewer behavior used was: ${behavior}. Return JSON with keys: canProceed, verdict, overallScore, summary, strengths, gaps, recommendation. IMPORTANT: overallScore must be a number strictly between 0 and 10 (not percentage, not out of 100).`
      },
      {
        role: "user",
        content: JSON.stringify({
          topic,
          language,
          scenario,
          behavior,
          history
        })
      }
    ],
    {
      canProceed: false,
      verdict: "needs practice",
      overallScore: 5,
      summary: "Unable to generate a final assessment.",
      strengths: [],
      gaps: [],
      recommendation: "Try again with clearer answers."
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

    if (!session) {
      return res.status(400).json({ error: "Interview session not found" });
    }

    if (!currentQuestion) {
      return res.status(400).json({ error: "Question is required" });
    }

    if (!audioPath) {
      return res.status(400).json({ error: "Audio answer is required" });
    }

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
      answer: currentAnswer
    });

    const nextQuestionNumber = session.history.length + 1;

    let nextQuestion;
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
      const voiceNextQuestion = await makeVoiceFriendlyQuestion(
        session.topic,
        generated.question || fallbackQuestionText(session.topic),
        session.language,
        session.behavior,
        session.scenario
      );
      nextQuestion = {
        text: voiceNextQuestion,
        topic: generated.topic,
        difficulty: generated.difficulty
      };
    } catch (error) {
      console.error("Question generation failed:", error?.message || error);
      nextQuestion = {
        text: `Please explain one practical experience related to ${session.topic}.`,
        topic: session.topic,
        difficulty: 5
      };
    }

    const nextQuestionAudio = await safeSpeakText(nextQuestion.text, {
      language: session.language,
      behavior: session.behavior,
      scenario: session.scenario
    });

    res.json({
      interviewId,
      questionNumber: nextQuestionNumber,
      history: session.history,
      currentAnswer,
      nextQuestion: nextQuestion.text,
      nextQuestionAudio,
      topic: nextQuestion.topic,
      difficulty: nextQuestion.difficulty,
      language: session.language,
      scenario: session.scenario,
      behavior: session.behavior
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ error: "Unable to continue interview" });
  } finally {
    const audioPath = req.file?.path;
    if (audioPath && fs.existsSync(audioPath)) {
      fs.unlinkSync(audioPath);
    }
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

    if (!text.trim()) {
      return res.json({ correctedText: text, changed: false });
    }

    const spell = await loadEnglishSpellChecker();
    const correctedText = text.replace(/[A-Za-z']+/g, (token) => {
      return getCorrectionForToken(spell, token);
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