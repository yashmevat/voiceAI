// Tooltip modal logic
const TOOLTIP_TEXT = {
  language: `Choose the language for the interview. Example: English, Hindi, etc. The AI will ask and speak in this language only.`,
  topic: `Enter the main topic or skill for the interview. Example: Salary negotiation, Teamwork, JavaScript, etc.`,
  behavior: `Describe the behavior/personality. Example: strict, soft-hearted, supportive, rude, etc. You can use multiple words like 'rude and arrogant'.`,
  scenario: `Describe the scenario in detail. Example: 'You are HR. I am asking for a salary hike.' Do not use shortforms or incomplete sentences. Be clear and specific about the situation.`
};

function showTooltip(field) {
  const text = TOOLTIP_TEXT[field] || "No info available.";
  const modal = document.createElement("div");
  modal.className = "modal-backdrop";
  modal.innerHTML = `
    <div class="modal">
      <button class="modal-close" onclick="closeTooltip(event)">&times;</button>
      <div style="white-space:pre-line;">${text}</div>
    </div>
  `;
  modal.onclick = (e) => {
    if (e.target === modal) closeTooltip(e);
  };
  document.body.appendChild(modal);
}

function closeTooltip(e) {
  const modal = e.target.closest('.modal-backdrop');
  if (modal) modal.remove();
}
const API_BASE = window.location.hostname.includes("localhost")
  ? ""
  : "https://voiceai-3vgo.onrender.com";


  console.log("api base is: " + API_BASE);
const state = {
  interviewId: "",
  topic: "",
  language: "English",
  scenario: "",
  behavior: "",
  questionNumber: 0,
  currentQuestion: "",
  history: [],
  busy: false,
  recording: false,
  captureMode: null,
  mediaStream: null,
  mediaRecorder: null,
  audioChunks: []
};

const setupNotice = document.getElementById("setupNotice");
const startButton = document.getElementById("startButton");
const languageInput = document.getElementById("languageInput");
const topicInput = document.getElementById("topicInput");
const scenarioInput = document.getElementById("scenarioInput");
const behaviorInput = document.getElementById("behaviorInput");
const workspacePanel = document.getElementById("workspacePanel");
const finalPanel = document.getElementById("finalPanel");
const questionText = document.getElementById("questionText");
const questionMeta = document.getElementById("questionMeta");
const startAnswerButton = document.getElementById("startAnswerButton");
const nextButton = document.getElementById("nextButton");
const finishButton = document.getElementById("finishButton");
const historyList = document.getElementById("historyList");
const techPill = document.getElementById("techPill");
const languagePill = document.getElementById("languagePill");
const behaviorPill = document.getElementById("behaviorPill");
const progressPill = document.getElementById("progressPill");
const statusPill = document.getElementById("statusPill");
const micPill = document.getElementById("micPill");
const stepNotice = document.getElementById("stepNotice");

const audioElement = document.createElement("audio");
audioElement.setAttribute("playsinline", "");
audioElement.setAttribute("webkit-playsinline", "");
audioElement.preload = "auto";
audioElement.style.display = "none";
document.body.appendChild(audioElement);

const RECORDING_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/aac"
];

function getSupportedRecordingMimeType() {
  if (!window.MediaRecorder || typeof MediaRecorder.isTypeSupported !== "function") {
    return "";
  }

  return RECORDING_MIME_TYPES.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) || "";
}

let audioContext = null;

async function unlockAudioPlayback() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) {
      return;
    }

    if (!audioContext) {
      audioContext = new AudioContext();
    }

    if (audioContext.state === "suspended") {
      await audioContext.resume();
    }

    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();
    gainNode.gain.value = 0;
    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);
    oscillator.start();
    oscillator.stop(audioContext.currentTime + 0.01);
  } catch (error) {
    console.log("Audio unlock note:", error.message);
  }
}

function setBusy(isBusy) {
  state.busy = isBusy;
  document.body.classList.toggle("loading", isBusy);
  startButton.disabled = isBusy;
  startAnswerButton.disabled = isBusy;
  nextButton.disabled = isBusy;
  finishButton.disabled = isBusy;
}

function setRecordingState(isRecording) {
  state.recording = isRecording;
  const recordingLabel = !isRecording
    ? "Off"
    : "Recording answer";

  micPill.innerHTML = `Mic: <strong>${recordingLabel}</strong>`;

  // Keep controls visible once the interview has a question/session.
  const hasActiveQuestion = Boolean(state.currentQuestion);
  const hasActiveSession = Boolean(state.interviewId);

  startAnswerButton.classList.toggle("hidden", isRecording || !hasActiveQuestion);
  startAnswerButton.disabled = state.busy;
  nextButton.classList.toggle("hidden", !isRecording || !hasActiveQuestion);
  nextButton.disabled = state.busy;
  finishButton.classList.toggle("hidden", !hasActiveSession);
  finishButton.disabled = state.busy;
}

function setStatus(text, color = "") {
  statusPill.innerHTML = `Status: <strong>${text}</strong>`;
  statusPill.style.color = color || "var(--muted)";
}

function renderHistory() {
  historyList.innerHTML = "";

  if (!state.history.length) {
    const empty = document.createElement("div");
    empty.className = "notice";
    empty.textContent = "No answers yet. Your interview history will appear here.";
    historyList.appendChild(empty);
    return;
  }

  state.history.forEach((item, index) => {
    const card = document.createElement("div");
    card.className = "history-card";

    const tag = document.createElement("div");
    tag.className = "tag";
    tag.textContent = `Question ${index + 1}`;

    const question = document.createElement("p");
    question.className = "q";
    question.textContent = `Q: ${item.question}`;

    const answer = document.createElement("p");
    answer.className = "a";
    answer.textContent = `A: ${item.answer}`;

    card.append(tag, question, answer);
    historyList.appendChild(card);
  });
}

function updateQuestionView(question, questionNumber) {
  state.currentQuestion = question;
  state.questionNumber = questionNumber;
  questionText.textContent = question;
  questionMeta.textContent = `Question ${questionNumber}. Listen first, then answer out loud when the microphone opens.`;
  progressPill.innerHTML = `Questions answered: <strong>${state.history.length}</strong>`;
  techPill.innerHTML = `Topic: <strong>${state.topic}</strong>`;
  languagePill.innerHTML = `Language: <strong>${state.language}</strong>`;
  behaviorPill.innerHTML = `Behavior: <strong>${state.behavior}</strong>`;
  setRecordingState(state.recording);
  setStatus("In progress");
}

async function ensureMicrophone() {
  if (state.mediaStream && state.mediaStream.active) {
    return state.mediaStream;
  }

  state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return state.mediaStream;
}

async function requestMicrophoneOnLoad() {
  if (!navigator.mediaDevices?.getUserMedia) {
    return;
  }

  try {
    setupNotice.textContent = "Please allow microphone access when prompted.";
    state.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    setupNotice.textContent = "Microphone permission granted. Fill the setup fields, then start.";
  } catch (error) {
    console.log("Mic permission on load note:", error.message);
    setupNotice.textContent = "Fill the setup fields, then start. Mic permission will be requested when needed.";
  }
}

function base64ToBlobUrl(base64, mimeType = "audio/mpeg") {
  const binary = window.atob(base64);
  const bytes = new Uint8Array(binary.length);

  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }

  const blob = new Blob([bytes], { type: mimeType });
  return URL.createObjectURL(blob);
}

async function playAudio(base64) {
  if (!base64) {
    return;
  }

  const tryPlay = () => new Promise((resolve) => {
    const audioUrl = base64ToBlobUrl(base64);
    audioElement.pause();
    audioElement.currentTime = 0;
    audioElement.src = audioUrl;
    audioElement.load();

    const cleanup = () => {
      audioElement.onended = null;
      audioElement.onerror = null;
      URL.revokeObjectURL(audioUrl);
      resolve(true);
    };

    audioElement.onended = cleanup;
    audioElement.onerror = () => {
      URL.revokeObjectURL(audioUrl);
      resolve(false);
    };

    audioElement.play().then(() => {
      resolve(true);
    }).catch(() => {
      audioElement.pause();
      audioElement.currentTime = 0;
      URL.revokeObjectURL(audioUrl);
      resolve(false);
    });
  });

  const firstAttempt = await tryPlay();
  if (!firstAttempt) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    await tryPlay();
  }
}

async function startRecording() {
  await ensureMicrophone();
  state.audioChunks = [];
  state.captureMode = "answer";

  const mimeType = getSupportedRecordingMimeType();
  state.mediaRecorder = mimeType
    ? new MediaRecorder(state.mediaStream, { mimeType })
    : new MediaRecorder(state.mediaStream);

  state.mediaRecorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      state.audioChunks.push(event.data);
    }
  };

  state.mediaRecorder.onstart = () => {
    setRecordingState(true);
    setStatus("Listening", "var(--good)");
    stepNotice.textContent = "Speak your answer, then click Next to send it.";
  };

  state.mediaRecorder.onerror = () => {
    setRecordingState(false);
    setStatus("Error", "var(--bad)");
    stepNotice.textContent = "Recording failed on this device. Please try again.";
  };

  state.mediaRecorder.start(1000);
}

function stopRecording() {
  return new Promise((resolve) => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
      resolve(null);
      return;
    }

    state.mediaRecorder.onstop = () => {
      const blobType = state.mediaRecorder.mimeType || state.audioChunks[0]?.type || "audio/webm";
      const blob = new Blob(state.audioChunks, {
        type: blobType
      });
      resolve(blob);
    };

    state.mediaRecorder.stop();
  });
}

function stopRecordingSilently() {
  return new Promise((resolve) => {
    if (!state.mediaRecorder || state.mediaRecorder.state !== "recording") {
      resolve();
      return;
    }

    state.mediaRecorder.onstop = () => {
      state.audioChunks = [];
      resolve();
    };

    state.mediaRecorder.stop();
  });
}

async function askQuestion(questionTextValue, questionAudio) {
  setRecordingState(false);
  state.captureMode = null;
  setStatus("AI speaking", "var(--accent)");
  stepNotice.textContent = "Listen to the question, then click 'Start giving answer' when ready to record your response.";
  await playAudio(questionAudio);
  setStatus("Ready for answer", "var(--good)");
  stepNotice.textContent = "Question done. Click 'Start giving answer' to begin recording your response.";
}

async function beginRecording() {
  await startRecording();
}

function showFieldError(inputElem, message) {
  let errorElem = inputElem.parentElement.querySelector('.field-error');
  if (!errorElem) {
    errorElem = document.createElement('div');
    errorElem.className = 'field-error';
    errorElem.style.color = '#f87171';
    errorElem.style.fontSize = '13px';
    errorElem.style.marginTop = '4px';
    inputElem.parentElement.appendChild(errorElem);
  }
  errorElem.textContent = message;
}

function clearFieldError(inputElem) {
  const errorElem = inputElem.parentElement.querySelector('.field-error');
  if (errorElem) errorElem.remove();
}

async function startInterview() {
  const topic = topicInput.value.trim();
  const language = languageInput.value.trim() || "English";
  const scenario = scenarioInput.value.trim();
  const behavior = behaviorInput.value.trim();

  let hasError = false;
  clearFieldError(topicInput);
  clearFieldError(scenarioInput);
  clearFieldError(behaviorInput);

  if (!topic) {
    showFieldError(topicInput, "This field is required");
    hasError = true;
  }
  if (!scenario) {
    showFieldError(scenarioInput, "This field is required");
    hasError = true;
  }
  if (!behavior) {
    showFieldError(behaviorInput, "This field is required");
    hasError = true;
  }
  if (hasError) return;

  setBusy(true);
  finalPanel.classList.add("hidden");
  workspacePanel.classList.remove("hidden");
  state.topic = topic;
  state.language = language;
  state.scenario = scenario;
  state.behavior = behavior;
  state.interviewId = "";
  state.questionNumber = 0;
  state.currentQuestion = "";
  state.history = [];
  state.captureMode = null;
  setRecordingState(false);
  setupNotice.textContent = `Starting interview in ${state.language}...`;
  stepNotice.textContent = "Preparing your voice interview...";
  renderHistory();
  languagePill.innerHTML = `Language: <strong>${state.language}</strong>`;
  behaviorPill.innerHTML = `Behavior: <strong>${state.behavior}</strong>`;
  techPill.innerHTML = `Topic: <strong>${state.topic}</strong>`;
  progressPill.innerHTML = "Questions answered: <strong>0</strong>";

  try {
    await unlockAudioPlayback();
    await ensureMicrophone();
    await unlockAudioPlayback();
    
    const response = await fetch(`${API_BASE}/api/interview/start`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        topic: state.topic,
        language: state.language,
        scenario: state.scenario,
        behavior: state.behavior
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to start interview");
    }

    state.interviewId = data.interviewId;
    state.language = data.language || state.language;
    state.scenario = data.scenario || state.scenario;
    state.behavior = data.behavior || state.behavior;
    setupNotice.textContent = `Interview started in ${state.language}.`;

    updateQuestionView(data.question, data.questionNumber);
    await askQuestion(data.question, data.questionAudio);
  } catch (error) {
    setStatus("Error", "var(--bad)");
    setRecordingState(false);
    state.captureMode = null;
    setupNotice.textContent = "Unable to start interview. Check your inputs and try again.";
  } finally {
    setBusy(false);
  }
}

async function submitNextAnswer() {
  if (!state.currentQuestion) {
    return;
  }

  setBusy(true);

  try {
    const answerBlob = await stopRecording();

    if (!answerBlob || answerBlob.size === 0) {
      alert("Say something before going next.");
      return;
    }

    setRecordingState(false);
    setStatus("Transcribing", "var(--accent)");
    stepNotice.textContent = "Transcribing your answer and preparing the next question...";

    const formData = new FormData();
    formData.append("interviewId", state.interviewId);
    formData.append("currentQuestion", state.currentQuestion);
    formData.append("questionNumber", String(state.questionNumber));
    formData.append("audio", answerBlob, "answer.webm");

    const response = await fetch(`${API_BASE}/api/interview/next`, {
      method: "POST",
      body: formData
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to move to the next question");
    }

    if (!data.nextQuestion) {
      throw new Error("Could not fetch next question. Please try Next again.");
    }

    state.history = data.history;
    state.language = data.language || state.language;
    state.scenario = data.scenario || state.scenario;
    state.behavior = data.behavior || state.behavior;

    renderHistory();
    setRecordingState(false);

    updateQuestionView(data.nextQuestion, data.questionNumber);
    stepNotice.textContent = "Answer saved. Moving to the next question.";
    await askQuestion(data.nextQuestion, data.nextQuestionAudio);
  } catch (error) {
    alert(error.message);
    setStatus("Error", "var(--bad)");
    setRecordingState(false);
  } finally {
    setBusy(false);
  }
}

async function finishInterview() {
  if (!state.history.length) {
    return;
  }

  setBusy(true);
  stepNotice.textContent = "Generating final assessment...";

  try {
    const response = await fetch(`${API_BASE}/api/interview/finish`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        interviewId: state.interviewId
      })
    });

    const data = await response.json();

    if (!response.ok) {
      throw new Error(data.error || "Unable to finish interview");
    }

    const assessment = data.assessment;
    state.language = data.language || state.language;
    state.scenario = data.scenario || state.scenario;
    state.behavior = data.behavior || state.behavior;
    setupNotice.textContent = `Interview started in ${state.language}.`;
    finalPanel.classList.remove("hidden");
    document.getElementById("finalVerdict").textContent = assessment.verdict;
    document.getElementById("finalScore").textContent = `${assessment.overallScore}/10`;
    document.getElementById("finalRecommendation").textContent = assessment.recommendation;
    document.getElementById("finalSummary").textContent = assessment.summary;

    const strengths = document.getElementById("finalStrengths");
    const gaps = document.getElementById("finalGaps");
    setupNotice.textContent = "Unable to start interview. Check your inputs and try again.";
    gaps.innerHTML = "";

    if ((assessment.strengths || []).length) {
      assessment.strengths.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        strengths.appendChild(li);
      });
    } else {
      const li = document.createElement("li");
      li.textContent = "No strengths returned.";
      strengths.appendChild(li);
    }

    if ((assessment.gaps || []).length) {
      assessment.gaps.forEach((item) => {
        const li = document.createElement("li");
        li.textContent = item;
        gaps.appendChild(li);
      });
    } else {
      const li = document.createElement("li");
      li.textContent = "No gaps returned.";
      gaps.appendChild(li);
    }

    setStatus(assessment.canProceed ? "Ready" : "Needs practice", assessment.canProceed ? "var(--good)" : "var(--bad)");
    stepNotice.textContent = "Final assessment complete.";
    await playAudio(data.assessmentAudio);

    state.interviewId = "";
    state.currentQuestion = "";
    state.questionNumber = 0;
    setRecordingState(false);
  } catch (error) {
    alert(error.message);
    setStatus("Error", "var(--bad)");
  } finally {
    setBusy(false);
  }
}

async function endInterview() {
  if (state.busy) {
    return;
  }

  setBusy(true);

  try {
    await stopRecordingSilently();
    setRecordingState(false);
    state.captureMode = null;
    await finishInterview();
  } catch (error) {
    alert(error.message);
    setStatus("Error", "var(--bad)");
  } finally {
    setBusy(false);
  }
}

renderHistory();
requestMicrophoneOnLoad();