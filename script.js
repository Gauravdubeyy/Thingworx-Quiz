"use strict";

const quizState = {
  username: "",
  currentLevelIndex: 0,
  currentQuestionIndex: 0,
  answers: [],
  score: 0
};

const STORAGE_KEY = "thingworxQuizState_v1";

let quizData = null;
let refs = {};
let introIntervalId = null;
let introTimeoutId = null;
let transitionTimeoutId = null;
let autoAdvanceTimeoutId = null;
let isAutoAdvancing = false;

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  bindEvents();
  await loadQuiz();
  hydrateUsernameFromStorage();
  showScreen("start-screen");
});

function cacheElements() {
  refs = {
    appTitle: document.getElementById("app-title"),
    appDescription: document.getElementById("app-description"),

    startScreen: document.getElementById("start-screen"),
    usernameInput: document.getElementById("username-input"),
    startBtn: document.getElementById("start-btn"),
    startError: document.getElementById("start-error"),

    introScreen: document.getElementById("intro-screen"),
    introLevelCount: document.getElementById("intro-level-count"),
    introQuestionCount: document.getElementById("intro-question-count"),
    introLevelTrack: document.getElementById("intro-level-track"),
    introProgressFill: document.getElementById("intro-progress-fill"),

    transitionScreen: document.getElementById("transition-screen"),
    transitionTitle: document.getElementById("transition-title"),
    transitionText: document.getElementById("transition-text"),

    quizScreen: document.getElementById("quiz-screen"),
    usernameChip: document.getElementById("username-chip"),
    levelChip: document.getElementById("level-chip"),

    questionProgressLabel: document.getElementById("question-progress-label"),
    questionProgressPercent: document.getElementById("question-progress-percent"),
    questionProgressFill: document.getElementById("question-progress-fill"),

    levelProgressLabel: document.getElementById("level-progress-label"),
    levelProgressPercent: document.getElementById("level-progress-percent"),
    levelProgressFill: document.getElementById("level-progress-fill"),

    questionCounter: document.getElementById("question-counter"),
    questionCategory: document.getElementById("question-category"),
    questionText: document.getElementById("question-text"),
    optionsContainer: document.getElementById("options-container"),

    explanationBox: document.getElementById("explanation-box"),
    explanationText: document.getElementById("explanation-text"),
    correctAnswerText: document.getElementById("correct-answer-text"),

    backBtn: document.getElementById("back-btn"),
    nextBtn: document.getElementById("next-btn"),

    resultScreen: document.getElementById("result-screen"),
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
}

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
  quizState.score = 0;
  isAutoAdvancing = false;

  saveState();
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

  renderOptions(questionObj, selectedIndex);
  renderExplanation(questionObj, selectedIndex);
  updateNavigation(selectedIndex, questionCount);
  updateProgress(questionCount);
}

function renderOptions(questionObj, selectedIndex) {
  refs.optionsContainer.innerHTML = "";

  questionObj.options.forEach((optionText, optionIndex) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "option-card";
    button.dataset.index = String(optionIndex);

    const optionLetter = String.fromCharCode(65 + optionIndex);
    button.innerHTML = `<span class="option-key">${optionLetter}</span><span>${optionText}</span>`;

    const isAnswered = selectedIndex !== null;

    if (!isAnswered) {
      button.addEventListener("click", () => handleAnswer(optionIndex));
    }

    if (isAnswered) {
      button.disabled = true;

      if (optionIndex === selectedIndex) {
        button.classList.add("selected");
      }

      if (optionIndex === questionObj.answerIndex) {
        button.classList.add("correct");
      }

      if (optionIndex === selectedIndex && selectedIndex !== questionObj.answerIndex) {
        button.classList.add("wrong");
      }
    }

    refs.optionsContainer.appendChild(button);
  });
}

function renderExplanation(questionObj, selectedIndex) {
  const showWrongExplanation = selectedIndex !== null && selectedIndex !== questionObj.answerIndex;

  if (showWrongExplanation) {
    refs.explanationText.textContent = questionObj.explanation;
    refs.correctAnswerText.textContent = `Correct answer: ${questionObj.answerText}`;
    refs.explanationBox.classList.remove("hidden");
    return;
  }

  refs.explanationBox.classList.add("hidden");
  refs.explanationText.textContent = "";
  refs.correctAnswerText.textContent = "";
}

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
  saveState();

  const levelObj = getCurrentLevel();
  const isLastQuestionInLevel = questionIndex === levelObj.questions.length - 1;

  if (isLastQuestionInLevel) {
    isAutoAdvancing = true;
  }

  renderQuestion();

  if (!isLastQuestionInLevel) {
    return;
  }

  const isLastLevel = levelIndex === quizData.levels.length - 1;

  clearTimeout(autoAdvanceTimeoutId);
  autoAdvanceTimeoutId = window.setTimeout(() => {
    isAutoAdvancing = false;

    if (isLastLevel) {
      calculateScore();
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
        renderResult();
      } else {
        showLevelTransition(quizState.currentLevelIndex + 1);
      }
      return;
    }

    quizState.currentQuestionIndex += 1;
    saveState();
    renderQuestion();
    return;
  }

  if (direction < 0) {
    if (quizState.currentQuestionIndex > 0) {
      quizState.currentQuestionIndex -= 1;
      saveState();
      renderQuestion();
      return;
    }

    if (quizState.currentLevelIndex > 0) {
      quizState.currentLevelIndex -= 1;
      const previousLevel = getCurrentLevel();
      quizState.currentQuestionIndex = previousLevel.questions.length - 1;
      saveState();
      renderQuestion();
    }
  }
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

function updateProgress(questionCount) {
  const currentQuestionPosition = quizState.currentQuestionIndex + 1;
  const questionProgress = (currentQuestionPosition / questionCount) * 100;

  refs.questionProgressLabel.textContent = `Question ${currentQuestionPosition} / ${questionCount}`;
  refs.questionProgressPercent.textContent = `${Math.round(questionProgress)}%`;
  refs.questionProgressFill.style.width = `${questionProgress}%`;

  const levelPosition = quizState.currentLevelIndex + 1;
  const totalLevels = quizData.levels.length;
  const levelProgress = ((quizState.currentLevelIndex + currentQuestionPosition / questionCount) / totalLevels) * 100;

  refs.levelProgressLabel.textContent = `Level Progress ${levelPosition} / ${totalLevels}`;
  refs.levelProgressPercent.textContent = `${Math.round(levelProgress)}%`;
  refs.levelProgressFill.style.width = `${levelProgress}%`;
}

function showLevelTransition(nextLevelIndex) {
  clearTimeout(autoAdvanceTimeoutId);
  autoAdvanceTimeoutId = null;

  const completedLevel = quizData.levels[nextLevelIndex - 1];
  const upcomingLevel = quizData.levels[nextLevelIndex];

  quizState.currentLevelIndex = nextLevelIndex;
  quizState.currentQuestionIndex = 0;
  saveState();

  refs.transitionTitle.textContent = `${toDisplayLevel(completedLevel.level)} Complete`;
  refs.transitionText.textContent = `Starting ${toDisplayLevel(upcomingLevel.level)} level...`;

  showScreen("transition-screen");

  clearTimeout(transitionTimeoutId);
  transitionTimeoutId = window.setTimeout(() => {
    showScreen("quiz-screen");
    renderQuestion();
  }, 1400);
}

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
  saveState();
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

function toDisplayLevel(levelName) {
  const value = String(levelName || "").trim();
  if (!value) {
    return "Unknown";
  }
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

function showScreen(screenId) {
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("active", screen.id === screenId);
  });
}

function saveState() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(quizState));
  } catch (error) {
    console.warn("State persistence skipped.", error);
  }
}

function hydrateUsernameFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      return;
    }

    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed.username === "string") {
      refs.usernameInput.value = parsed.username;
    }
  } catch (error) {
    console.warn("Could not read previous state.", error);
  }
}

function clearSavedState() {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch (error) {
    console.warn("Could not clear previous state.", error);
  }
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
