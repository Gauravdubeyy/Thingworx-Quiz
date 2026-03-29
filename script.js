"use strict";

const STORAGE_KEY = "thingworxQuizState_v1";

const quizState = {
  username: "",
  currentLevelIndex: 0,
  currentQuestionIndex: 0,
  answers: [],
  score: 0
};

let quizData = null;
let refs = {};
let introIntervalId = null;
let introTimeoutId = null;
let transitionTimeoutId = null;
let autoAdvanceTimeoutId = null;
let isAutoAdvancing = false;
let isTransitioning = false;
let isAnswerCommitInProgress = false;
let hasFatalError = false;

// ---------- App Bootstrap ----------
document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  bindEvents();

  const loaded = await loadQuiz();
  if (!loaded || hasFatalError) {
    return;
  }

  initializeFromSavedAttempt();
});

function cacheElements() {
  refs = {
    appTitle: document.getElementById("app-title"),
    appDescription: document.getElementById("app-description"),

    usernameInput: document.getElementById("username-input"),
    startBtn: document.getElementById("start-btn"),
    startError: document.getElementById("start-error"),

    introLevelCount: document.getElementById("intro-level-count"),
    introQuestionCount: document.getElementById("intro-question-count"),
    introLevelTrack: document.getElementById("intro-level-track"),
    introProgressFill: document.getElementById("intro-progress-fill"),

    transitionTitle: document.getElementById("transition-title"),
    transitionText: document.getElementById("transition-text"),

    fatalErrorMessage: document.getElementById("fatal-error-message"),
    errorReloadBtn: document.getElementById("error-reload-btn"),

    usernameChip: document.getElementById("username-chip"),
    levelChip: document.getElementById("level-chip"),

    questionProgressLabel: document.getElementById("question-progress-label"),
    questionProgressPercent: document.getElementById("question-progress-percent"),
    questionProgressFill: document.getElementById("question-progress-fill"),

    overallProgressLabel: document.getElementById("overall-progress-label"),
    overallProgressPercent: document.getElementById("overall-progress-percent"),
    overallProgressFill: document.getElementById("overall-progress-fill"),

    questionCounter: document.getElementById("question-counter"),
    questionCategory: document.getElementById("question-category"),
    questionText: document.getElementById("question-text"),
    questionCard: document.querySelector(".question-card"),
    optionsContainer: document.getElementById("options-container"),

    explanationBox: document.getElementById("explanation-box"),
    answerFeedback: document.getElementById("answer-feedback"),
    explanationText: document.getElementById("explanation-text"),
    correctAnswerText: document.getElementById("correct-answer-text"),

    backBtn: document.getElementById("back-btn"),
    nextBtn: document.getElementById("next-btn"),

    resultUsername: document.getElementById("result-username"),
    resultScore: document.getElementById("result-score"),
    resultPercentage: document.getElementById("result-percentage"),
    resultStatus: document.getElementById("result-status"),
    restartBtn: document.getElementById("restart-btn")
  };
}

function bindEvents() {
  refs.startBtn?.addEventListener("click", startQuizFlow);
  refs.usernameInput?.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      startQuizFlow();
    }
  });

  refs.backBtn?.addEventListener("click", () => navigate(-1));
  refs.nextBtn?.addEventListener("click", () => navigate(1));
  refs.restartBtn?.addEventListener("click", restartQuiz);
  refs.optionsContainer?.addEventListener("keydown", handleOptionKeydown);
  refs.errorReloadBtn?.addEventListener("click", () => window.location.reload());
}

// ---------- Data Loading & Validation ----------
async function loadQuiz() {
  try {
    const response = await fetch("thingworx-quiz-webapp.json", { cache: "no-store" });

    if (!response.ok) {
      showFatalError("Unable to load quiz data. Please verify thingworx-quiz-webapp.json and reload.");
      return false;
    }

    const data = await response.json();
    const validation = validateQuizPayload(data);

    if (!validation.valid) {
      showFatalError(validation.message);
      return false;
    }

    quizData = data;

    if (refs.appTitle) {
      refs.appTitle.textContent = data.title || "ThingWorx Quiz";
    }

    if (refs.appDescription) {
      refs.appDescription.textContent = data.description || "Web quiz";
    }

    if (refs.introLevelCount) {
      refs.introLevelCount.textContent = `${data.levels.length} Levels`;
    }

    if (refs.introQuestionCount) {
      refs.introQuestionCount.textContent = `${data.levels[0].questions.length} Questions Each`;
    }

    buildIntroTrack();
    return true;
  } catch (error) {
    console.error(error);
    showFatalError("Quiz data format is invalid JSON. Please fix the file and reload.");
    return false;
  }
}

function validateQuizPayload(data) {
  if (!data || typeof data !== "object") {
    return { valid: false, message: "Quiz configuration is missing or unreadable." };
  }

  if (!Array.isArray(data.levels) || data.levels.length !== 3) {
    return { valid: false, message: "Invalid quiz structure: exactly 3 levels are required." };
  }

  for (let levelIndex = 0; levelIndex < data.levels.length; levelIndex += 1) {
    const levelObj = data.levels[levelIndex];

    if (!levelObj || !Array.isArray(levelObj.questions) || levelObj.questions.length !== 20) {
      return {
        valid: false,
        message: `Invalid level data at level ${levelIndex + 1}: exactly 20 questions are required.`
      };
    }

    for (let questionIndex = 0; questionIndex < levelObj.questions.length; questionIndex += 1) {
      const questionObj = levelObj.questions[questionIndex];

      if (!questionObj || !Array.isArray(questionObj.options) || questionObj.options.length !== 4) {
        return {
          valid: false,
          message: `Invalid question options at level ${levelIndex + 1}, question ${questionIndex + 1}: exactly 4 options are required.`
        };
      }

      if (!Number.isInteger(questionObj.answerIndex) || questionObj.answerIndex < 0 || questionObj.answerIndex > 3) {
        return {
          valid: false,
          message: `Invalid answerIndex at level ${levelIndex + 1}, question ${questionIndex + 1}: answerIndex must be between 0 and 3.`
        };
      }
    }
  }

  return { valid: true, message: "OK" };
}

function buildIntroTrack() {
  if (!refs.introLevelTrack || !quizData) {
    return;
  }

  refs.introLevelTrack.innerHTML = "";

  quizData.levels.forEach((levelObj) => {
    const item = document.createElement("li");
    item.textContent = toDisplayLevel(levelObj.level);
    refs.introLevelTrack.appendChild(item);
  });

  if (refs.introProgressFill) {
    refs.introProgressFill.style.width = "0%";
  }
}

function showFatalError(message) {
  hasFatalError = true;
  clearTimers();

  isAutoAdvancing = false;
  isTransitioning = false;
  isAnswerCommitInProgress = false;

  if (refs.fatalErrorMessage) {
    refs.fatalErrorMessage.textContent = message || "Unable to initialize quiz.";
  }

  showScreen("error-screen");
}

// ---------- Persistence / Resume ----------
function initializeFromSavedAttempt() {
  if (hasFatalError || !quizData) {
    return;
  }

  const savedState = getSavedState();

  if (!savedState) {
    showScreen("start-screen");
    return;
  }

  const shouldResume = window.confirm("Resume previous attempt?");

  if (!shouldResume) {
    clearSavedState();
    if (refs.usernameInput) {
      refs.usernameInput.value = "";
    }
    showScreen("start-screen");
    return;
  }

  const restored = restoreState(savedState);

  if (!restored) {
    clearSavedState();
    if (refs.startError) {
      refs.startError.textContent = "Previous session could not be restored. Starting fresh.";
    }
    showScreen("start-screen");
    return;
  }

  if (refs.usernameInput) {
    refs.usernameInput.value = quizState.username;
  }

  showScreen("quiz-screen");
  renderQuestion();
}

function getSavedState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return null;
    }

    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch (error) {
    console.warn("Could not read previous state.", error);
    return null;
  }
}

function restoreState(savedState) {
  if (!quizData) {
    return false;
  }

  const normalized = normalizeSavedState(savedState);
  if (!normalized) {
    return false;
  }

  quizState.username = normalized.username;
  quizState.currentLevelIndex = normalized.currentLevelIndex;
  quizState.currentQuestionIndex = normalized.currentQuestionIndex;
  quizState.answers = normalized.answers;

  calculateScore();
  persistState();
  return true;
}

function normalizeSavedState(savedState) {
  const levels = quizData?.levels;
  if (!Array.isArray(levels) || levels.length !== 3) {
    return null;
  }

  if (typeof savedState.username !== "string" || !savedState.username.trim()) {
    return null;
  }

  if (!Array.isArray(savedState.answers) || savedState.answers.length !== levels.length) {
    return null;
  }

  const answers = [];

  for (let levelIndex = 0; levelIndex < levels.length; levelIndex += 1) {
    const questionList = levels[levelIndex].questions;
    const savedLevelAnswers = savedState.answers[levelIndex];

    if (!Array.isArray(savedLevelAnswers) || savedLevelAnswers.length !== questionList.length) {
      return null;
    }

    const normalizedLevel = savedLevelAnswers.map((value) => {
      if (value === null) {
        return null;
      }

      if (Number.isInteger(value) && value >= 0 && value <= 3) {
        return value;
      }

      return null;
    });

    answers.push(normalizedLevel);
  }

  const safeLevelIndex = clampNumber(savedState.currentLevelIndex, 0, levels.length - 1);
  const maxQuestionIndex = levels[safeLevelIndex].questions.length - 1;
  const safeQuestionIndex = clampNumber(savedState.currentQuestionIndex, 0, maxQuestionIndex);

  return {
    username: savedState.username.trim(),
    currentLevelIndex: safeLevelIndex,
    currentQuestionIndex: safeQuestionIndex,
    answers
  };
}

function persistState() {
  if (!quizData || hasFatalError || !isStateReady()) {
    return;
  }

  try {
    const payload = {
      username: quizState.username,
      currentLevelIndex: quizState.currentLevelIndex,
      currentQuestionIndex: quizState.currentQuestionIndex,
      answers: quizState.answers,
      score: quizState.score
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("State persistence skipped.", error);
  }
}

function clearSavedState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("Could not clear previous state.", error);
  }
}

function clearAllLocalStorage() {
  try {
    localStorage.clear();
  } catch (error) {
    console.warn("Could not clear localStorage.", error);
  }
}

// ---------- Flow ----------
function startQuizFlow() {
  if (hasFatalError || !quizData) {
    return;
  }

  const username = refs.usernameInput?.value.trim() || "";
  if (!username) {
    if (refs.startError) {
      refs.startError.textContent = "Please enter your username to continue.";
    }
    return;
  }

  if (refs.startError) {
    refs.startError.textContent = "";
  }

  initializeState(username);
  playIntroAnimation();
}

function initializeState(username) {
  if (!quizData) {
    return;
  }

  resetFlowFlags();

  quizState.username = username;
  quizState.currentLevelIndex = 0;
  quizState.currentQuestionIndex = 0;
  quizState.answers = quizData.levels.map((levelObj) => Array(levelObj.questions.length).fill(null));

  calculateScore();
  persistState();
}

function playIntroAnimation() {
  if (!quizData || !refs.introLevelTrack || hasFatalError) {
    return;
  }

  clearTimers();
  showScreen("intro-screen");

  const steps = Array.from(refs.introLevelTrack.children);
  const totalSteps = steps.length;
  const stepDuration = 1000;
  let activeIndex = -1;

  const highlightStep = () => {
    activeIndex = Math.min(activeIndex + 1, totalSteps - 1);

    steps.forEach((step, index) => {
      step.classList.toggle("active", index === activeIndex);
      step.classList.toggle("done", index < activeIndex);
    });

    const progress = ((activeIndex + 1) / totalSteps) * 100;
    if (refs.introProgressFill) {
      refs.introProgressFill.style.width = `${progress}%`;
    }
  };

  highlightStep();

  introIntervalId = window.setInterval(highlightStep, stepDuration);
  introTimeoutId = window.setTimeout(() => {
    clearInterval(introIntervalId);
    introIntervalId = null;
    showScreen("quiz-screen");
    renderQuestion();
  }, 3000);
}

function showLevelTransition(nextLevelIndex) {
  if (!quizData || hasFatalError || isTransitioning) {
    return;
  }

  const expectedNext = quizState.currentLevelIndex + 1;
  if (nextLevelIndex !== expectedNext || nextLevelIndex < 1 || nextLevelIndex >= quizData.levels.length) {
    return;
  }

  const completedLevel = quizData.levels[nextLevelIndex - 1];
  const upcomingLevel = quizData.levels[nextLevelIndex];

  if (!completedLevel || !upcomingLevel) {
    showFatalError("Level transition failed due to invalid level data.");
    return;
  }

  isTransitioning = true;

  quizState.currentLevelIndex = nextLevelIndex;
  quizState.currentQuestionIndex = 0;
  persistState();

  if (refs.transitionTitle) {
    refs.transitionTitle.textContent = `${toDisplayLevel(completedLevel.level)} Complete`;
  }

  if (refs.transitionText) {
    refs.transitionText.textContent = `Starting ${toDisplayLevel(upcomingLevel.level)} level...`;
  }

  showScreen("transition-screen");

  clearTimeout(transitionTimeoutId);
  transitionTimeoutId = window.setTimeout(() => {
    isTransitioning = false;
    showScreen("quiz-screen");
    renderQuestion();
  }, 1400);
}

// ---------- Rendering ----------
function renderQuestion() {
  if (hasFatalError || !quizData) {
    return;
  }

  if (!isStateReady()) {
    showFatalError("Quiz state is invalid. Please restart the quiz.");
    return;
  }

  const levelObj = getCurrentLevel();
  const questionObj = getCurrentQuestion();

  if (!levelObj || !questionObj || !Array.isArray(questionObj.options)) {
    showFatalError("Question data is missing. Please reload the page.");
    return;
  }

  if (questionObj.options.length !== 4) {
    showFatalError("Question options are invalid. Exactly 4 options are required.");
    return;
  }

  scrollToTopSmooth();

  const selectedIndex = quizState.answers[quizState.currentLevelIndex][quizState.currentQuestionIndex];
  const questionCount = levelObj.questions.length;

  if (refs.usernameChip) {
    refs.usernameChip.textContent = quizState.username;
  }

  if (refs.levelChip) {
    refs.levelChip.textContent = `Level: ${toDisplayLevel(levelObj.level)}`;
  }

  if (refs.questionCounter) {
    refs.questionCounter.textContent = `${quizState.currentQuestionIndex + 1} / ${questionCount}`;
  }

  if (refs.questionCategory) {
    refs.questionCategory.textContent = String(questionObj.category || "general").toUpperCase();
  }

  if (refs.questionText) {
    refs.questionText.textContent = questionObj.question || "";
  }

  animateElement(refs.questionCard);
  renderOptions(questionObj, selectedIndex);
  renderExplanation(questionObj, selectedIndex);
  updateNavigation(selectedIndex, questionCount);
  updateProgress(questionCount);
}

function renderOptions(questionObj, selectedIndex) {
  if (!refs.optionsContainer || !Array.isArray(questionObj?.options)) {
    return;
  }

  refs.optionsContainer.innerHTML = "";

  const shouldLockInteractions =
    selectedIndex !== null || isAnswerCommitInProgress || isAutoAdvancing || isTransitioning;

  setOptionInteractionLock(shouldLockInteractions);

  questionObj.options.forEach((optionText, optionIndex) => {
    const button = document.createElement("button");
    const isAnswered = selectedIndex !== null;
    const isSelected = optionIndex === selectedIndex;

    button.type = "button";
    button.className = "option-card";
    button.dataset.index = String(optionIndex);
    button.setAttribute("role", "button");
    button.setAttribute("aria-selected", String(isSelected));
    button.setAttribute("aria-disabled", String(isAnswered || shouldLockInteractions));
    button.setAttribute("aria-label", `Option ${String.fromCharCode(65 + optionIndex)}: ${optionText}`);

    const optionLetter = String.fromCharCode(65 + optionIndex);
    button.innerHTML = `<span class="option-key">${optionLetter}</span><span class="option-text">${optionText}</span>`;

    if (!isAnswered && !shouldLockInteractions) {
      button.addEventListener("click", () => handleAnswer(optionIndex));
      button.tabIndex = optionIndex === 0 ? 0 : -1;
    } else {
      button.disabled = true;
      button.tabIndex = -1;
    }

    if (isAnswered) {
      if (isSelected) {
        button.classList.add("selected");
      }

      if (optionIndex === questionObj.answerIndex) {
        button.classList.add("correct");
      }

      if (isSelected && selectedIndex !== questionObj.answerIndex) {
        button.classList.add("wrong");
      }
    }

    refs.optionsContainer.appendChild(button);
  });

  animateElement(refs.optionsContainer);
}

function renderExplanation(questionObj, selectedIndex) {
  if (!refs.explanationBox || !refs.answerFeedback || !refs.explanationText || !refs.correctAnswerText) {
    return;
  }

  if (selectedIndex === null) {
    refs.explanationBox.classList.add("hidden");
    refs.answerFeedback.textContent = "";
    refs.explanationText.textContent = "";
    refs.correctAnswerText.textContent = "";
    return;
  }

  const isCorrect = selectedIndex === questionObj.answerIndex;

  refs.answerFeedback.textContent = isCorrect
    ? "You selected the correct answer."
    : "Your selection is incorrect.";
  refs.explanationText.textContent = questionObj.explanation || "No explanation available.";
  refs.correctAnswerText.textContent = `Correct answer: ${questionObj.answerText || "N/A"}`;

  refs.explanationBox.classList.remove("hidden");
  animateElement(refs.explanationBox);
}

function updateProgress(questionCount) {
  if (!quizData || !questionCount || questionCount <= 0) {
    return;
  }

  const currentQuestionPosition = quizState.currentQuestionIndex + 1;
  const questionProgress = (currentQuestionPosition / questionCount) * 100;

  if (refs.questionProgressLabel) {
    refs.questionProgressLabel.textContent = `Question ${currentQuestionPosition} / ${questionCount}`;
  }

  if (refs.questionProgressPercent) {
    refs.questionProgressPercent.textContent = `${Math.round(questionProgress)}%`;
  }

  if (refs.questionProgressFill) {
    refs.questionProgressFill.style.width = `${questionProgress}%`;
  }

  const totalQuestions = getTotalQuestions();
  const overallQuestionPosition = getOverallQuestionPosition(quizState.currentLevelIndex, currentQuestionPosition);
  const overallProgress = totalQuestions > 0 ? (overallQuestionPosition / totalQuestions) * 100 : 0;

  if (refs.overallProgressLabel) {
    refs.overallProgressLabel.textContent = `${overallQuestionPosition} / ${totalQuestions}`;
  }

  if (refs.overallProgressPercent) {
    refs.overallProgressPercent.textContent = `${Math.round(overallProgress)}%`;
  }

  if (refs.overallProgressFill) {
    refs.overallProgressFill.style.width = `${overallProgress}%`;
  }
}

function updateNavigation(selectedIndex, questionCount) {
  if (!refs.backBtn || !refs.nextBtn || !quizData) {
    return;
  }

  const isFirstOverall = quizState.currentLevelIndex === 0 && quizState.currentQuestionIndex === 0;
  refs.backBtn.disabled = isFirstOverall || isAutoAdvancing || isTransitioning;

  const isLastQuestion = quizState.currentQuestionIndex === questionCount - 1;
  const isLastLevel = quizState.currentLevelIndex === quizData.levels.length - 1;

  if (isAutoAdvancing || isTransitioning || isAnswerCommitInProgress) {
    refs.nextBtn.disabled = true;
    refs.nextBtn.textContent = "Auto advancing...";
    return;
  }

  refs.nextBtn.textContent = isLastQuestion ? (isLastLevel ? "Finish Quiz" : "Next Level") : "Next";
  refs.nextBtn.disabled = selectedIndex === null;
}

// ---------- Input / Navigation ----------
function handleAnswer(selectedIndex) {
  if (hasFatalError || isAutoAdvancing || isTransitioning || isAnswerCommitInProgress) {
    return;
  }

  if (!isStateReady()) {
    showFatalError("Quiz state is invalid. Please restart the quiz.");
    return;
  }

  const levelIndex = quizState.currentLevelIndex;
  const questionIndex = quizState.currentQuestionIndex;
  const levelObj = getCurrentLevel();
  const questionObj = getCurrentQuestion();

  if (!levelObj || !questionObj || !Array.isArray(questionObj.options)) {
    showFatalError("Question data could not be loaded.");
    return;
  }

  if (!Number.isInteger(selectedIndex) || selectedIndex < 0 || selectedIndex >= questionObj.options.length) {
    return;
  }

  const existing = quizState.answers?.[levelIndex]?.[questionIndex];
  if (existing !== null && existing !== undefined) {
    return;
  }

  isAnswerCommitInProgress = true;
  setOptionInteractionLock(true);

  quizState.answers[levelIndex][questionIndex] = selectedIndex;
  calculateScore();
  persistState();

  const isLastQuestionInLevel = questionIndex === levelObj.questions.length - 1;
  const isLastLevel = levelIndex === quizData.levels.length - 1;

  if (isLastQuestionInLevel) {
    isAutoAdvancing = true;
  }

  renderQuestion();
  smoothScrollToExplanation();

  if (!isLastQuestionInLevel) {
    isAnswerCommitInProgress = false;
    return;
  }

  clearTimeout(autoAdvanceTimeoutId);
  autoAdvanceTimeoutId = window.setTimeout(() => {
    isAnswerCommitInProgress = false;
    isAutoAdvancing = false;

    if (levelIndex !== quizState.currentLevelIndex || questionIndex !== quizState.currentQuestionIndex) {
      return;
    }

    if (isLastLevel) {
      calculateScore();
      persistState();
      renderResult();
      return;
    }

    showLevelTransition(levelIndex + 1);
  }, 1000);
}

function navigate(direction) {
  if (hasFatalError || !quizData || isAutoAdvancing || isTransitioning || isAnswerCommitInProgress) {
    return;
  }

  if (direction > 0) {
    moveNext();
    return;
  }

  if (direction < 0) {
    moveBack();
  }
}

function moveNext() {
  if (!quizData || hasFatalError) {
    return;
  }

  const selectedIndex = quizState.answers?.[quizState.currentLevelIndex]?.[quizState.currentQuestionIndex];
  if (selectedIndex === null || selectedIndex === undefined) {
    return;
  }

  const levelObj = getCurrentLevel();
  if (!levelObj || !Array.isArray(levelObj.questions)) {
    showFatalError("Level data is missing.");
    return;
  }

  const isLastQuestion = quizState.currentQuestionIndex === levelObj.questions.length - 1;
  const isLastLevel = quizState.currentLevelIndex === quizData.levels.length - 1;

  if (isLastQuestion) {
    if (isLastLevel) {
      calculateScore();
      persistState();
      renderResult();
    } else {
      showLevelTransition(quizState.currentLevelIndex + 1);
    }
    return;
  }

  quizState.currentQuestionIndex += 1;
  persistState();
  renderQuestion();
}

function moveBack() {
  if (!quizData || hasFatalError) {
    return;
  }

  if (quizState.currentQuestionIndex > 0) {
    quizState.currentQuestionIndex -= 1;
    persistState();
    renderQuestion();
    return;
  }

  if (quizState.currentLevelIndex > 0) {
    quizState.currentLevelIndex -= 1;

    const previousLevel = getCurrentLevel();
    if (!previousLevel || !Array.isArray(previousLevel.questions) || previousLevel.questions.length === 0) {
      showFatalError("Previous level data is missing.");
      return;
    }

    quizState.currentQuestionIndex = previousLevel.questions.length - 1;
    persistState();
    renderQuestion();
  }
}

function handleOptionKeydown(event) {
  const active = document.activeElement;
  if (!active || !active.classList.contains("option-card")) {
    return;
  }

  if (event.key === "ArrowRight" || event.key === "ArrowDown") {
    event.preventDefault();
    moveOptionFocus(1);
    return;
  }

  if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
    event.preventDefault();
    moveOptionFocus(-1);
    return;
  }

  if ((event.key === "Enter" || event.key === " ") && !active.disabled) {
    event.preventDefault();
    const selectedIndex = Number(active.dataset.index);
    if (Number.isInteger(selectedIndex)) {
      handleAnswer(selectedIndex);
    }
  }
}

function moveOptionFocus(step) {
  if (!refs.optionsContainer) {
    return;
  }

  const options = Array.from(refs.optionsContainer.querySelectorAll(".option-card:not([disabled])"));

  if (options.length === 0) {
    return;
  }

  let currentIndex = options.findIndex((option) => option === document.activeElement);
  if (currentIndex < 0) {
    currentIndex = 0;
  }

  const nextIndex = (currentIndex + step + options.length) % options.length;

  options.forEach((option, index) => {
    option.tabIndex = index === nextIndex ? 0 : -1;
  });

  options[nextIndex].focus();
}

// ---------- Scoring / Result ----------
function calculateScore() {
  if (!quizData || !isStateReady()) {
    quizState.score = 0;
    return 0;
  }

  let correctCount = 0;

  quizData.levels.forEach((levelObj, levelIndex) => {
    levelObj.questions.forEach((questionObj, questionIndex) => {
      const selectedIndex = quizState.answers[levelIndex][questionIndex];
      if (selectedIndex === questionObj.answerIndex) {
        correctCount += 1;
      }
    });
  });

  quizState.score = correctCount;
  return correctCount;
}

function renderResult() {
  if (hasFatalError || !quizData) {
    return;
  }

  calculateScore();

  const total = getTotalQuestions();
  const percentage = total > 0 ? (quizState.score / total) * 100 : 0;
  const passed = percentage >= 80;

  if (refs.resultUsername) {
    refs.resultUsername.textContent = `Candidate: ${quizState.username}`;
  }

  if (refs.resultScore) {
    refs.resultScore.textContent = `${quizState.score} / ${total}`;
  }

  if (refs.resultPercentage) {
    refs.resultPercentage.textContent = `${percentage.toFixed(2)}%`;
  }

  if (refs.resultStatus) {
    refs.resultStatus.textContent = passed ? "PASS" : "FAIL";
    refs.resultStatus.classList.toggle("pass", passed);
    refs.resultStatus.classList.toggle("fail", !passed);
  }

  showScreen("result-screen");
}

function restartQuiz() {
  clearTimers();
  resetFlowFlags();
  resetQuizState();
  clearAllLocalStorage();

  if (refs.usernameInput) {
    refs.usernameInput.value = "";
  }

  if (refs.startError) {
    refs.startError.textContent = "";
  }

  if (refs.startBtn) {
    refs.startBtn.disabled = false;
  }

  showScreen("start-screen");
}

// ---------- Utilities ----------
function getCurrentLevel() {
  return quizData?.levels?.[quizState.currentLevelIndex] || null;
}

function getCurrentQuestion() {
  const levelObj = getCurrentLevel();
  return levelObj?.questions?.[quizState.currentQuestionIndex] || null;
}

function getTotalQuestions() {
  if (!quizData || !Array.isArray(quizData.levels)) {
    return 0;
  }

  return quizData.levels.reduce((sum, levelObj) => {
    const questionCount = Array.isArray(levelObj.questions) ? levelObj.questions.length : 0;
    return sum + questionCount;
  }, 0);
}

function getOverallQuestionPosition(levelIndex, questionPositionInLevel) {
  if (!quizData || !Array.isArray(quizData.levels)) {
    return 0;
  }

  let totalBeforeLevel = 0;

  for (let index = 0; index < levelIndex; index += 1) {
    const levelQuestions = quizData.levels[index]?.questions;
    totalBeforeLevel += Array.isArray(levelQuestions) ? levelQuestions.length : 0;
  }

  return totalBeforeLevel + questionPositionInLevel;
}

function isStateReady() {
  if (!quizData || !Array.isArray(quizData.levels) || !Array.isArray(quizState.answers)) {
    return false;
  }

  if (quizState.answers.length !== quizData.levels.length) {
    return false;
  }

  for (let levelIndex = 0; levelIndex < quizData.levels.length; levelIndex += 1) {
    const questions = quizData.levels[levelIndex]?.questions;
    const answers = quizState.answers[levelIndex];

    if (!Array.isArray(questions) || !Array.isArray(answers) || answers.length !== questions.length) {
      return false;
    }
  }

  return true;
}

function setOptionInteractionLock(locked) {
  if (!refs.optionsContainer) {
    return;
  }

  refs.optionsContainer.style.pointerEvents = locked ? "none" : "auto";
}

function scrollToTopSmooth() {
  try {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch (error) {
    window.scrollTo(0, 0);
  }
}

function toDisplayLevel(levelName) {
  const value = String(levelName || "").trim();
  if (!value) {
    return "Unknown";
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function clampNumber(value, min, max) {
  const safeNumber = Number.isInteger(value) ? value : min;
  if (safeNumber < min) {
    return min;
  }
  if (safeNumber > max) {
    return max;
  }
  return safeNumber;
}

function showScreen(screenId) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("active", screen.id === screenId);
  });
}

function clearTimers() {
  clearInterval(introIntervalId);
  clearTimeout(introTimeoutId);
  clearTimeout(transitionTimeoutId);
  clearTimeout(autoAdvanceTimeoutId);

  introIntervalId = null;
  introTimeoutId = null;
  transitionTimeoutId = null;
  autoAdvanceTimeoutId = null;
}

function resetFlowFlags() {
  isAutoAdvancing = false;
  isTransitioning = false;
  isAnswerCommitInProgress = false;
  setOptionInteractionLock(false);
}

function resetQuizState() {
  quizState.username = "";
  quizState.currentLevelIndex = 0;
  quizState.currentQuestionIndex = 0;
  quizState.answers = [];
  quizState.score = 0;
}

function animateElement(element) {
  if (!element) {
    return;
  }

  element.classList.remove("animate-in");
  void element.offsetWidth;
  element.classList.add("animate-in");
}

function smoothScrollToExplanation() {
  if (!refs.explanationBox || refs.explanationBox.classList.contains("hidden")) {
    return;
  }

  refs.explanationBox.scrollIntoView({ behavior: "smooth", block: "nearest" });
}
