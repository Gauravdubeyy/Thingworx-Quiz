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

// ---------- App Bootstrap ----------
document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  bindEvents();
  await loadQuiz();
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
  refs.startBtn.addEventListener("click", startQuizFlow);
  refs.usernameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      startQuizFlow();
    }
  });

  refs.backBtn.addEventListener("click", () => navigate(-1));
  refs.nextBtn.addEventListener("click", () => navigate(1));
  refs.restartBtn.addEventListener("click", restartQuiz);
  refs.optionsContainer.addEventListener("keydown", handleOptionKeydown);
}

// ---------- Data Loading ----------
async function loadQuiz() {
  try {
    const response = await fetch("thingworx-quiz-webapp.json", { cache: "no-store" });

    if (!response.ok) {
      throw new Error(`Unable to load JSON (${response.status})`);
    }

    const data = await response.json();

    if (!Array.isArray(data.levels) || data.levels.length === 0) {
      throw new Error("Quiz JSON does not include valid levels.");
    }

    quizData = data;
    refs.appTitle.textContent = data.title || "ThingWorx Quiz";
    refs.appDescription.textContent = data.description || "Web quiz";

    const levelCount = data.levels.length;
    const questionsEach = data.levels[0]?.questions?.length || 0;

    refs.introLevelCount.textContent = `${levelCount} Levels`;
    refs.introQuestionCount.textContent = `${questionsEach} Questions Each`;

    buildIntroTrack();
  } catch (error) {
    refs.appDescription.textContent = "Failed to load quiz JSON.";
    refs.startError.textContent = "Could not load thingworx-quiz-webapp.json. Run with a local web server and try again.";
    refs.startBtn.disabled = true;
    console.error(error);
  }
}

function buildIntroTrack() {
  refs.introLevelTrack.innerHTML = "";

  quizData.levels.forEach((levelObj) => {
    const item = document.createElement("li");
    item.textContent = toDisplayLevel(levelObj.level);
    refs.introLevelTrack.appendChild(item);
  });

  refs.introProgressFill.style.width = "0%";
}

// ---------- Persistence / Resume ----------
function initializeFromSavedAttempt() {
  if (!quizData) {
    showScreen("start-screen");
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
    refs.usernameInput.value = "";
    showScreen("start-screen");
    return;
  }

  const restored = restoreState(savedState);

  if (!restored) {
    clearSavedState();
    showScreen("start-screen");
    return;
  }

  refs.usernameInput.value = quizState.username;
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
  if (!Array.isArray(levels) || levels.length === 0) {
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

// ---------- Flow ----------
function startQuizFlow() {
  if (!quizData) {
    refs.startError.textContent = "Quiz data is not ready yet.";
    return;
  }

  const username = refs.usernameInput.value.trim();
  if (!username) {
    refs.startError.textContent = "Please enter your username to continue.";
    return;
  }

  refs.startError.textContent = "";
  initializeState(username);
  playIntroAnimation();
}

function initializeState(username) {
  quizState.username = username;
  quizState.currentLevelIndex = 0;
  quizState.currentQuestionIndex = 0;
  quizState.answers = quizData.levels.map((levelObj) => Array(levelObj.questions.length).fill(null));

  calculateScore();
  isAutoAdvancing = false;
  persistState();
}

function playIntroAnimation() {
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
    refs.introProgressFill.style.width = `${progress}%`;
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
  clearTimeout(autoAdvanceTimeoutId);
  autoAdvanceTimeoutId = null;

  const completedLevel = quizData.levels[nextLevelIndex - 1];
  const upcomingLevel = quizData.levels[nextLevelIndex];

  quizState.currentLevelIndex = nextLevelIndex;
  quizState.currentQuestionIndex = 0;
  persistState();

  refs.transitionTitle.textContent = `${toDisplayLevel(completedLevel.level)} Complete`;
  refs.transitionText.textContent = `Starting ${toDisplayLevel(upcomingLevel.level)} level...`;

  showScreen("transition-screen");

  clearTimeout(transitionTimeoutId);
  transitionTimeoutId = window.setTimeout(() => {
    showScreen("quiz-screen");
    renderQuestion();
  }, 1400);
}

// ---------- Rendering ----------
function renderQuestion() {
  const levelObj = getCurrentLevel();
  const questionObj = getCurrentQuestion();

  if (!levelObj || !questionObj) {
    return;
  }

  const selectedIndex = quizState.answers[quizState.currentLevelIndex][quizState.currentQuestionIndex];
  const questionCount = levelObj.questions.length;

  refs.usernameChip.textContent = quizState.username;
  refs.levelChip.textContent = `Level: ${toDisplayLevel(levelObj.level)}`;

  refs.questionCounter.textContent = `${quizState.currentQuestionIndex + 1} / ${questionCount}`;
  refs.questionCategory.textContent = String(questionObj.category || "general").toUpperCase();
  refs.questionText.textContent = questionObj.question;

  animateElement(refs.questionCard);
  renderOptions(questionObj, selectedIndex);
  renderExplanation(questionObj, selectedIndex);
  updateNavigation(selectedIndex, questionCount);
  updateProgress(questionCount);
}

function renderOptions(questionObj, selectedIndex) {
  refs.optionsContainer.innerHTML = "";

  questionObj.options.forEach((optionText, optionIndex) => {
    const button = document.createElement("button");
    const isAnswered = selectedIndex !== null;
    const isSelected = optionIndex === selectedIndex;

    button.type = "button";
    button.className = "option-card";
    button.dataset.index = String(optionIndex);
    button.setAttribute("role", "button");
    button.setAttribute("aria-selected", String(isSelected));
    button.setAttribute("aria-disabled", String(isAnswered));
    button.setAttribute("aria-label", `Option ${String.fromCharCode(65 + optionIndex)}: ${optionText}`);

    const optionLetter = String.fromCharCode(65 + optionIndex);
    button.innerHTML = `<span class="option-key">${optionLetter}</span><span class="option-text">${optionText}</span>`;

    if (!isAnswered) {
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
  if (selectedIndex === null) {
    refs.explanationBox.classList.add("hidden");
    refs.answerFeedback.textContent = "";
    refs.explanationText.textContent = "";
    refs.correctAnswerText.textContent = "";
    return;
  }

  const isCorrect = selectedIndex === questionObj.answerIndex;

  refs.answerFeedback.textContent = isCorrect ? "You selected the correct answer." : "Your selection is incorrect.";
  refs.explanationText.textContent = questionObj.explanation;
  refs.correctAnswerText.textContent = `Correct answer: ${questionObj.answerText}`;

  refs.explanationBox.classList.remove("hidden");
  animateElement(refs.explanationBox);
}

function updateProgress(questionCount) {
  const currentQuestionPosition = quizState.currentQuestionIndex + 1;
  const questionProgress = (currentQuestionPosition / questionCount) * 100;

  refs.questionProgressLabel.textContent = `Question ${currentQuestionPosition} / ${questionCount}`;
  refs.questionProgressPercent.textContent = `${Math.round(questionProgress)}%`;
  refs.questionProgressFill.style.width = `${questionProgress}%`;

  const totalQuestions = getTotalQuestions();
  const overallQuestionPosition = getOverallQuestionPosition(
    quizState.currentLevelIndex,
    currentQuestionPosition
  );
  const overallProgress = (overallQuestionPosition / totalQuestions) * 100;

  refs.overallProgressLabel.textContent = `${overallQuestionPosition} / ${totalQuestions}`;
  refs.overallProgressPercent.textContent = `${Math.round(overallProgress)}%`;
  refs.overallProgressFill.style.width = `${overallProgress}%`;
}

function updateNavigation(selectedIndex, questionCount) {
  const isFirstOverall = quizState.currentLevelIndex === 0 && quizState.currentQuestionIndex === 0;
  refs.backBtn.disabled = isFirstOverall || isAutoAdvancing;

  const isLastQuestion = quizState.currentQuestionIndex === questionCount - 1;
  const isLastLevel = quizState.currentLevelIndex === quizData.levels.length - 1;

  if (isAutoAdvancing) {
    refs.nextBtn.disabled = true;
    refs.nextBtn.textContent = "Auto advancing...";
    return;
  }

  refs.nextBtn.textContent = isLastQuestion ? (isLastLevel ? "Finish Quiz" : "Next Level") : "Next";
  refs.nextBtn.disabled = selectedIndex === null;
}

// ---------- Input / Navigation ----------
function handleAnswer(selectedIndex) {
  if (isAutoAdvancing) {
    return;
  }

  const levelIndex = quizState.currentLevelIndex;
  const questionIndex = quizState.currentQuestionIndex;
  const existing = quizState.answers[levelIndex][questionIndex];

  if (existing !== null) {
    return;
  }

  quizState.answers[levelIndex][questionIndex] = selectedIndex;
  calculateScore();
  persistState();

  const levelObj = getCurrentLevel();
  const isLastQuestionInLevel = questionIndex === levelObj.questions.length - 1;

  if (isLastQuestionInLevel) {
    isAutoAdvancing = true;
  }

  renderQuestion();
  smoothScrollToExplanation();

  if (!isLastQuestionInLevel) {
    return;
  }

  const isLastLevel = levelIndex === quizData.levels.length - 1;

  clearTimeout(autoAdvanceTimeoutId);
  autoAdvanceTimeoutId = window.setTimeout(() => {
    isAutoAdvancing = false;

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
  if (isAutoAdvancing || !quizData) {
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
  const selectedIndex = quizState.answers[quizState.currentLevelIndex][quizState.currentQuestionIndex];
  if (selectedIndex === null) {
    return;
  }

  const levelObj = getCurrentLevel();
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
  if (quizState.currentQuestionIndex > 0) {
    quizState.currentQuestionIndex -= 1;
    persistState();
    renderQuestion();
    return;
  }

  if (quizState.currentLevelIndex > 0) {
    quizState.currentLevelIndex -= 1;
    const previousLevel = getCurrentLevel();
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
  const total = getTotalQuestions();
  const percentage = total > 0 ? (quizState.score / total) * 100 : 0;
  const passed = percentage >= 80;

  refs.resultUsername.textContent = `Candidate: ${quizState.username}`;
  refs.resultScore.textContent = `${quizState.score} / ${total}`;
  refs.resultPercentage.textContent = `${percentage.toFixed(2)}%`;
  refs.resultStatus.textContent = passed ? "PASS" : "FAIL";

  refs.resultStatus.classList.toggle("pass", passed);
  refs.resultStatus.classList.toggle("fail", !passed);

  showScreen("result-screen");
}

function restartQuiz() {
  clearTimers();

  const previousUsername = quizState.username;

  quizState.username = "";
  quizState.currentLevelIndex = 0;
  quizState.currentQuestionIndex = 0;
  quizState.answers = [];
  quizState.score = 0;
  isAutoAdvancing = false;

  clearSavedState();

  refs.usernameInput.value = previousUsername;
  refs.startError.textContent = "";
  refs.startBtn.disabled = false;
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
  return quizData.levels.reduce((sum, levelObj) => sum + levelObj.questions.length, 0);
}

function getOverallQuestionPosition(levelIndex, questionPositionInLevel) {
  let totalBeforeLevel = 0;

  for (let index = 0; index < levelIndex; index += 1) {
    totalBeforeLevel += quizData.levels[index].questions.length;
  }

  return totalBeforeLevel + questionPositionInLevel;
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
