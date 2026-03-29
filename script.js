
"use strict";

const STORAGE_KEY = "thingworxQuizState_v1";
const QUERY_PARAMS = new URLSearchParams(window.location.search);
const QUIZ_SOURCES = [
  { file: "thingworx-quiz-webapp.json", label: "Set 1" },
  { file: "thingworx-quiz.json", label: "Set 2" }
];
const REQUIRED_LEVELS = ["basic", "intermediate", "advanced"];
const QUESTIONS_PER_LEVEL = 20;
const DEBUG_MODE = QUERY_PARAMS.get("quizDebug") === "1";
const SEED_MODE = String(QUERY_PARAMS.get("seedMode") || "").toLowerCase();
const FIXED_SEED = String(QUERY_PARAMS.get("seed") || "").trim();
const CATEGORY_TARGETS = { core: 10, scenario: 6, helpers: 4 };

const quizState = {
  username: "",
  currentLevelIndex: 0,
  currentQuestionIndex: 0,
  answers: [],
  score: 0
};

let quizData = null;
let baseQuizMetadata = null;
let mergedQuestionPools = createEmptyPoolMap();
let questionLookupByKey = new Map();
let currentDatasetVersion = "";
let currentSeedMode = "off";
let currentSeedValue = null;

let refs = {};
let introIntervalId = null;
let introTimeoutId = null;
let transitionTimeoutId = null;
let autoAdvanceTimeoutId = null;
let isAutoAdvancing = false;
let isTransitioning = false;
let isAnswerCommitInProgress = false;
let hasFatalError = false;

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

async function loadQuiz() {
  try {
    const sourcePayloads = await Promise.all(QUIZ_SOURCES.map((source) => fetchQuizSource(source)));

    sourcePayloads.forEach((entry) => {
      const validation = validateQuizPayload(entry.data, entry.source.label);
      if (!validation.valid) {
        throw new Error(validation.message);
      }
    });

    const mergeResult = mergeQuizSources(sourcePayloads);
    if (!mergeResult.valid) {
      throw new Error(mergeResult.message);
    }

    mergedQuestionPools = mergeResult.pools;
    questionLookupByKey = mergeResult.lookup;
    baseQuizMetadata = mergeResult.baseMetadata;
    currentDatasetVersion = buildDatasetVersion(sourcePayloads);

    quizData = createRandomizedQuizData({ mode: "off", seedValue: null });
    if (!quizData) {
      throw new Error("Unable to create randomized quiz set.");
    }

    refs.appTitle.textContent = baseQuizMetadata.title || "ThingWorx Quiz";
    refs.appDescription.textContent = baseQuizMetadata.description || "Randomized ThingWorx quiz.";
    refs.introLevelCount.textContent = `${REQUIRED_LEVELS.length} Levels`;
    refs.introQuestionCount.textContent = `${QUESTIONS_PER_LEVEL} Questions Each`;

    buildIntroTrack();
    return true;
  } catch (error) {
    console.error(error);
    showFatalError(error.message || "Unable to load quiz data.");
    return false;
  }
}

async function fetchQuizSource(source) {
  const response = await fetch(source.file, { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load ${source.file}. Please verify the file exists and reload.`);
  }

  try {
    const data = await response.json();
    return { source, data };
  } catch {
    throw new Error(`${source.file} is not valid JSON.`);
  }
}

function validateQuizPayload(data, sourceLabel) {
  if (!data || typeof data !== "object") {
    return { valid: false, message: `${sourceLabel} is missing or unreadable.` };
  }

  if (!Array.isArray(data.levels) || data.levels.length !== REQUIRED_LEVELS.length) {
    return { valid: false, message: `${sourceLabel} must contain exactly 3 levels.` };
  }

  const seenLevels = new Set();

  for (let levelIndex = 0; levelIndex < data.levels.length; levelIndex += 1) {
    const levelObj = data.levels[levelIndex];
    const levelName = String(levelObj?.level || "").toLowerCase();

    if (!REQUIRED_LEVELS.includes(levelName)) {
      return { valid: false, message: `${sourceLabel} has an invalid level name at position ${levelIndex + 1}.` };
    }

    if (seenLevels.has(levelName)) {
      return { valid: false, message: `${sourceLabel} has duplicate level '${levelName}'.` };
    }

    seenLevels.add(levelName);

    if (!Array.isArray(levelObj.questions) || levelObj.questions.length !== QUESTIONS_PER_LEVEL) {
      return {
        valid: false,
        message: `${sourceLabel} level '${levelName}' must contain exactly ${QUESTIONS_PER_LEVEL} questions.`
      };
    }

    for (let questionIndex = 0; questionIndex < levelObj.questions.length; questionIndex += 1) {
      const questionObj = levelObj.questions[questionIndex];

      if (!questionObj || typeof questionObj !== "object") {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}' has an invalid question at index ${questionIndex + 1}.`
        };
      }

      if (typeof questionObj.id !== "string" || !questionObj.id.trim()) {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}', question ${questionIndex + 1} is missing a valid id.`
        };
      }

      if (!Array.isArray(questionObj.options) || questionObj.options.length !== 4) {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}', question ${questionIndex + 1} must have exactly 4 options.`
        };
      }

      if (!Number.isInteger(questionObj.answerIndex) || questionObj.answerIndex < 0 || questionObj.answerIndex > 3) {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}', question ${questionIndex + 1} has invalid answerIndex.`
        };
      }
    }
  }

  return { valid: true, message: "OK" };
}

function mergeQuizSources(sourcePayloads) {
  const pools = createEmptyPoolMap();
  const lookup = new Map();
  const normalizedTextSeen = new Map();

  for (const entry of sourcePayloads) {
    for (const levelName of REQUIRED_LEVELS) {
      const levelObj = getLevelByName(entry.data, levelName);
      if (!levelObj || !Array.isArray(levelObj.questions)) {
        return { valid: false, message: `${entry.source.label} is missing question data for '${levelName}'.` };
      }

      for (const question of levelObj.questions) {
        const key = buildQuestionKey(levelName, question.id);

        if (lookup.has(key)) {
          return { valid: false, message: `Duplicate question id '${question.id}' detected in '${levelName}'.` };
        }

        const normalizedQuestionText = normalizeQuestionText(question.question);
        if (normalizedQuestionText) {
          const existing = normalizedTextSeen.get(normalizedQuestionText);
          if (existing && existing.source !== entry.source.label) {
            warnLog(
              `Duplicate-like question text detected between '${existing.id}' (${existing.source}) and '${question.id}' (${entry.source.label}) in level '${levelName}'.`
            );
          } else if (!existing) {
            normalizedTextSeen.set(normalizedQuestionText, {
              id: question.id,
              source: entry.source.label
            });
          }
        }

        pools[levelName].push(question);
        lookup.set(key, question);
      }
    }
  }

  const expectedPoolSize = QUIZ_SOURCES.length * QUESTIONS_PER_LEVEL;

  for (const levelName of REQUIRED_LEVELS) {
    const count = pools[levelName].length;

    if (count < QUESTIONS_PER_LEVEL) {
      return {
        valid: false,
        message: `Merged '${levelName}' pool has only ${count} questions; at least ${QUESTIONS_PER_LEVEL} required.`
      };
    }

    debugLog(`Pool '${levelName}' size: ${count} (expected ${expectedPoolSize})`);
  }

  return {
    valid: true,
    pools,
    lookup,
    baseMetadata: sourcePayloads[0].data
  };
}

function createRandomizedQuizData(randomizationConfig) {
  if (!baseQuizMetadata) {
    return null;
  }

  const config = randomizationConfig || { mode: "off", seedValue: null };
  const levelRandomFactory = createLevelRandomFactory(config);
  const levels = REQUIRED_LEVELS.map((levelName) => {
    const pool = mergedQuestionPools[levelName];

    if (!Array.isArray(pool) || pool.length < QUESTIONS_PER_LEVEL) {
      return null;
    }

    const randomFn = levelRandomFactory(levelName);
    const selected = selectQuestionsForLevel(levelName, pool, randomFn);
    debugLog(`Selected '${levelName}' questions: ${selected.length}`);

    return {
      level: levelName,
      questions: selected
    };
  });

  if (levels.some((levelObj) => !levelObj)) {
    return null;
  }

  return {
    app: baseQuizMetadata.app,
    version: baseQuizMetadata.version,
    title: baseQuizMetadata.title,
    description: baseQuizMetadata.description,
    levels
  };
}

function selectQuestionsForLevel(levelName, pool, randomFn) {
  const buckets = {
    core: [],
    scenario: [],
    helpers: [],
    other: []
  };

  pool.forEach((questionObj) => {
    const normalizedCategory = normalizeCategory(questionObj?.category);
    if (buckets[normalizedCategory]) {
      buckets[normalizedCategory].push(questionObj);
    } else {
      buckets.other.push(questionObj);
    }
  });

  const canBalance =
    buckets.core.length >= CATEGORY_TARGETS.core &&
    buckets.scenario.length >= CATEGORY_TARGETS.scenario &&
    buckets.helpers.length >= CATEGORY_TARGETS.helpers;

  if (!canBalance) {
    debugLog(`Category balance fallback for '${levelName}' (insufficient category distribution in pool).`);
    return shuffleFisherYates([...pool], randomFn).slice(0, QUESTIONS_PER_LEVEL);
  }

  const balancedSelection = [
    ...takeRandomItems(buckets.core, CATEGORY_TARGETS.core, randomFn),
    ...takeRandomItems(buckets.scenario, CATEGORY_TARGETS.scenario, randomFn),
    ...takeRandomItems(buckets.helpers, CATEGORY_TARGETS.helpers, randomFn)
  ];

  return shuffleFisherYates(balancedSelection, randomFn).slice(0, QUESTIONS_PER_LEVEL);
}

function createQuizDataFromSelectedIds(savedSelection) {
  if (!savedSelection || typeof savedSelection !== "object") {
    return null;
  }

  const levels = [];

  for (const levelName of REQUIRED_LEVELS) {
    const ids = getSavedIdsForLevel(savedSelection, levelName);

    if (!Array.isArray(ids) || ids.length !== QUESTIONS_PER_LEVEL) {
      return null;
    }

    const seen = new Set();
    const questions = [];

    for (const id of ids) {
      if (typeof id !== "string" || !id.trim() || seen.has(id.trim())) {
        return null;
      }

      const key = buildQuestionKey(levelName, id.trim());
      const questionObj = questionLookupByKey.get(key);

      if (!questionObj) {
        return null;
      }

      seen.add(id.trim());
      questions.push(questionObj);
    }

    levels.push({ level: levelName, questions });
  }

  return {
    app: baseQuizMetadata.app,
    version: baseQuizMetadata.version,
    title: baseQuizMetadata.title,
    description: baseQuizMetadata.description,
    levels
  };
}

function getSavedIdsForLevel(savedSelection, levelName) {
  if (Array.isArray(savedSelection)) {
    const levelEntry = savedSelection.find((entry) => String(entry?.level || "").toLowerCase() === levelName);
    return levelEntry && Array.isArray(levelEntry.ids) ? levelEntry.ids : null;
  }

  return savedSelection[levelName] || null;
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

function initializeFromSavedAttempt() {
  if (hasFatalError || !quizData) {
    return;
  }

  const savedState = getSavedState();

  if (!savedState) {
    showScreen("start-screen");
    return;
  }

  if (!isSavedStateVersionCompatible(savedState)) {
    clearSavedState();
    refs.startError.textContent = "Question bank version changed. Please start a new attempt.";
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

  if (!restoreQuizSetFromSavedState(savedState)) {
    clearSavedState();
    refs.startError.textContent = "Previous session question set could not be restored. Starting fresh.";
    showScreen("start-screen");
    return;
  }

  if (!restoreState(savedState)) {
    clearSavedState();
    refs.startError.textContent = "Previous session could not be restored. Starting fresh.";
    showScreen("start-screen");
    return;
  }

  refs.usernameInput.value = quizState.username;
  showScreen("quiz-screen");
  renderQuestion();
}

function restoreQuizSetFromSavedState(savedState) {
  const restoredQuizData = createQuizDataFromSelectedIds(savedState?.selectedQuestionIdsByLevel);
  if (!restoredQuizData) {
    return false;
  }

  quizData = restoredQuizData;
  buildIntroTrack();
  return true;
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

function isSavedStateVersionCompatible(savedState) {
  if (!savedState || typeof savedState !== "object") {
    return false;
  }

  const savedVersion = String(savedState.datasetVersion || "");
  const currentVersion = String(currentDatasetVersion || "");

  return Boolean(savedVersion) && Boolean(currentVersion) && savedVersion === currentVersion;
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
  currentSeedMode = typeof savedState.seedMode === "string" ? savedState.seedMode : "off";
  currentSeedValue = Number.isInteger(savedState.seedValue) ? savedState.seedValue : null;

  calculateScore();
  persistState();
  return true;
}

function normalizeSavedState(savedState) {
  const levels = quizData?.levels;
  if (!Array.isArray(levels) || levels.length !== REQUIRED_LEVELS.length) {
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

    answers.push(
      savedLevelAnswers.map((value) => (value === null || (Number.isInteger(value) && value >= 0 && value <= 3) ? value : null))
    );
  }

  const safeLevelIndex = clampNumber(savedState.currentLevelIndex, 0, levels.length - 1);
  const maxQuestionIndex = levels[safeLevelIndex].questions.length - 1;

  return {
    username: savedState.username.trim(),
    currentLevelIndex: safeLevelIndex,
    currentQuestionIndex: clampNumber(savedState.currentQuestionIndex, 0, maxQuestionIndex),
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
      score: quizState.score,
      selectedQuestionIdsByLevel: getSelectedQuestionIdsByLevel(),
      datasetVersion: currentDatasetVersion,
      seedMode: currentSeedMode,
      seedValue: currentSeedValue
    };

    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch (error) {
    console.warn("State persistence skipped.", error);
  }
}

function getSelectedQuestionIdsByLevel() {
  if (!quizData || !Array.isArray(quizData.levels)) {
    return null;
  }

  const selection = {};

  for (const levelObj of quizData.levels) {
    const levelName = String(levelObj?.level || "").toLowerCase();
    if (!REQUIRED_LEVELS.includes(levelName) || !Array.isArray(levelObj.questions)) {
      return null;
    }

    selection[levelName] = levelObj.questions.map((questionObj) => questionObj.id);
  }

  return selection;
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

function startQuizFlow() {
  if (hasFatalError || !quizData) {
    return;
  }

  const username = refs.usernameInput?.value.trim() || "";
  if (!username) {
    refs.startError.textContent = "Please enter your username to continue.";
    return;
  }

  refs.startError.textContent = "";
  initializeState(username);
  playIntroAnimation();
}

function initializeState(username) {
  if (!quizData) {
    return;
  }

  resetFlowFlags();

  const randomizationConfig = resolveRandomizationConfig(username);
  const randomizedQuiz = createRandomizedQuizData(randomizationConfig);
  if (!randomizedQuiz) {
    showFatalError("Unable to generate randomized quiz questions.");
    return;
  }

  currentSeedMode = randomizationConfig.mode;
  currentSeedValue = randomizationConfig.seedValue;
  quizData = randomizedQuiz;
  buildIntroTrack();

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
  let activeIndex = -1;

  const highlightStep = () => {
    activeIndex = Math.min(activeIndex + 1, totalSteps - 1);

    steps.forEach((step, index) => {
      step.classList.toggle("active", index === activeIndex);
      step.classList.toggle("done", index < activeIndex);
    });

    refs.introProgressFill.style.width = `${((activeIndex + 1) / totalSteps) * 100}%`;
  };

  highlightStep();
  introIntervalId = window.setInterval(highlightStep, 1000);
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

  try {
    quizState.currentLevelIndex = nextLevelIndex;
    quizState.currentQuestionIndex = 0;
    persistState();

    refs.transitionTitle.textContent = `${toDisplayLevel(completedLevel.level)} Complete`;
    refs.transitionText.textContent = `Starting ${toDisplayLevel(upcomingLevel.level)} level...`;

    showScreen("transition-screen");

    clearTimeout(transitionTimeoutId);
    transitionTimeoutId = window.setTimeout(() => {
      try {
        showScreen("quiz-screen");
        renderQuestion();
      } catch (error) {
        console.error("Transition render failed:", error);
      } finally {
        isTransitioning = false;
        recoverNavigationState();
      }
    }, 1400);
  } catch (error) {
    console.error("Transition setup failed:", error);
    isTransitioning = false;
    recoverNavigationState();
  }
}

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

  if (!levelObj || !questionObj || !Array.isArray(questionObj.options) || questionObj.options.length !== 4) {
    showFatalError("Question data is missing or invalid. Please reload the page.");
    return;
  }

  scrollToTopSmooth();

  const selectedIndex = quizState.answers[quizState.currentLevelIndex][quizState.currentQuestionIndex];
  const questionCount = levelObj.questions.length;

  refs.usernameChip.textContent = quizState.username;
  refs.levelChip.textContent = `Level: ${toDisplayLevel(levelObj.level)}`;
  refs.questionCounter.textContent = `${quizState.currentQuestionIndex + 1} / ${questionCount}`;
  refs.questionCategory.textContent = String(questionObj.category || "general").toUpperCase();
  refs.questionText.textContent = questionObj.question || "";

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
    button.innerHTML = `<span class="option-key">${String.fromCharCode(65 + optionIndex)}</span><span class="option-text">${optionText}</span>`;

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
  if (selectedIndex === null) {
    refs.explanationBox.classList.add("hidden");
    refs.answerFeedback.textContent = "";
    refs.explanationText.textContent = "";
    refs.correctAnswerText.textContent = "";
    return;
  }

  refs.answerFeedback.textContent =
    selectedIndex === questionObj.answerIndex ? "You selected the correct answer." : "Your selection is incorrect.";
  refs.explanationText.textContent = questionObj.explanation || "No explanation available.";
  refs.correctAnswerText.textContent = `Correct answer: ${questionObj.answerText || "N/A"}`;

  refs.explanationBox.classList.remove("hidden");
  animateElement(refs.explanationBox);
}

function updateProgress(questionCount) {
  if (!quizData || questionCount <= 0) {
    return;
  }

  const currentQuestionPosition = quizState.currentQuestionIndex + 1;
  const questionProgress = (currentQuestionPosition / questionCount) * 100;

  refs.questionProgressLabel.textContent = `Question ${currentQuestionPosition} / ${questionCount}`;
  refs.questionProgressPercent.textContent = `${Math.round(questionProgress)}%`;
  refs.questionProgressFill.style.width = `${questionProgress}%`;

  const totalQuestions = getTotalQuestions();
  const overallQuestionPosition = getOverallQuestionPosition(quizState.currentLevelIndex, currentQuestionPosition);
  const overallProgress = totalQuestions > 0 ? (overallQuestionPosition / totalQuestions) * 100 : 0;

  refs.overallProgressLabel.textContent = `${overallQuestionPosition} / ${totalQuestions}`;
  refs.overallProgressPercent.textContent = `${Math.round(overallProgress)}%`;
  refs.overallProgressFill.style.width = `${overallProgress}%`;
}

function updateNavigation(selectedIndex, questionCount) {
  if (!quizData) {
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

  if (!isLastQuestionInLevel) {
    isAnswerCommitInProgress = false;
    console.log("Moving to next question");
    renderQuestion();
    smoothScrollToExplanation();
    recoverNavigationState();
    return;
  }

  isAutoAdvancing = true;
  console.log("Auto advancing started");
  renderQuestion();
  smoothScrollToExplanation();

  clearTimeout(autoAdvanceTimeoutId);
  autoAdvanceTimeoutId = window.setTimeout(() => {
    try {
      console.log("Moving to next question");

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
    } catch (error) {
      console.error("Auto-advance failed:", error);
    } finally {
      isAnswerCommitInProgress = false;
      isAutoAdvancing = false;
      recoverNavigationState();
      console.log("Auto advancing ended");
    }
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

function calculateScore() {
  if (!quizData || !isStateReady()) {
    quizState.score = 0;
    return 0;
  }

  let correctCount = 0;

  quizData.levels.forEach((levelObj, levelIndex) => {
    levelObj.questions.forEach((questionObj, questionIndex) => {
      if (quizState.answers[levelIndex][questionIndex] === questionObj.answerIndex) {
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
  resetFlowFlags();
  resetQuizState();
  clearAllLocalStorage();
  currentSeedMode = "off";
  currentSeedValue = null;

  refs.usernameInput.value = "";
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
  if (!quizData || !Array.isArray(quizData.levels)) {
    return 0;
  }

  return quizData.levels.reduce((sum, levelObj) => {
    return sum + (Array.isArray(levelObj.questions) ? levelObj.questions.length : 0);
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

function recoverNavigationState() {
  if (!quizData || !isStateReady()) {
    return;
  }

  if (!isTransitioning) {
    setOptionInteractionLock(false);
  }

  const levelObj = getCurrentLevel();
  if (!levelObj || !Array.isArray(levelObj.questions)) {
    return;
  }

  const selectedIndex = quizState.answers?.[quizState.currentLevelIndex]?.[quizState.currentQuestionIndex] ?? null;
  updateNavigation(selectedIndex, levelObj.questions.length);
}

function scrollToTopSmooth() {
  try {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch {
    window.scrollTo(0, 0);
  }
}

function getLevelByName(data, levelName) {
  if (!data || !Array.isArray(data.levels)) {
    return null;
  }

  return data.levels.find((levelObj) => String(levelObj?.level || "").toLowerCase() === levelName) || null;
}

function buildDatasetVersion(sourcePayloads) {
  return sourcePayloads
    .map((entry) => `${entry.source.file}:${String(entry.data?.version || "unknown")}`)
    .sort()
    .join("|");
}

function resolveRandomizationConfig(username) {
  if (FIXED_SEED) {
    return {
      mode: "fixed",
      seedValue: hashStringToSeed(FIXED_SEED),
      seedDescriptor: `fixed:${FIXED_SEED}`
    };
  }

  if (SEED_MODE === "user") {
    const normalizedUser = normalizeSeedPart(username) || "anonymous";
    return {
      mode: "user",
      seedValue: hashStringToSeed(`user:${normalizedUser}`),
      seedDescriptor: `user:${normalizedUser}`
    };
  }

  if (SEED_MODE === "attempt") {
    const normalizedUser = normalizeSeedPart(username) || "anonymous";
    const descriptor = `attempt:${normalizedUser}:${Date.now()}`;
    return {
      mode: "attempt",
      seedValue: hashStringToSeed(descriptor),
      seedDescriptor: descriptor
    };
  }

  return { mode: "off", seedValue: null, seedDescriptor: null };
}

function createLevelRandomFactory(randomizationConfig) {
  if (!randomizationConfig || !Number.isInteger(randomizationConfig.seedValue)) {
    return () => Math.random;
  }

  return (levelName) => {
    const mixedSeed = mixSeeds(
      randomizationConfig.seedValue,
      hashStringToSeed(`level:${String(levelName || "").toLowerCase()}`)
    );
    return createMulberry32(mixedSeed);
  };
}

function buildQuestionKey(levelName, questionId) {
  return `${levelName}::${String(questionId).trim()}`;
}

function shuffleFisherYates(items, randomFn = Math.random) {
  for (let index = items.length - 1; index > 0; index -= 1) {
    const randomIndex = Math.floor(randomFn() * (index + 1));
    [items[index], items[randomIndex]] = [items[randomIndex], items[index]];
  }

  return items;
}

function takeRandomItems(items, count, randomFn) {
  return shuffleFisherYates([...items], randomFn).slice(0, count);
}

function normalizeCategory(categoryValue) {
  const normalized = String(categoryValue || "").trim().toLowerCase();

  if (normalized.startsWith("core")) {
    return "core";
  }

  if (normalized.startsWith("scenario")) {
    return "scenario";
  }

  if (normalized === "helper" || normalized.startsWith("helpers")) {
    return "helpers";
  }

  return "other";
}

function normalizeQuestionText(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\\s]/g, " ")
    .replace(/\\s+/g, " ")
    .trim();
}

function normalizeSeedPart(value) {
  return String(value || "").trim().toLowerCase();
}

function hashStringToSeed(value) {
  const input = String(value || "");
  let hash = 2166136261;

  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function mixSeeds(seedA, seedB) {
  return (seedA ^ seedB) >>> 0;
}

function createMulberry32(seed) {
  let state = seed >>> 0;

  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function createEmptyPoolMap() {
  return {
    basic: [],
    intermediate: [],
    advanced: []
  };
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

function debugLog(message) {
  if (DEBUG_MODE) {
    console.log(`[QuizDebug] ${message}`);
  }
}

function warnLog(message) {
  console.warn(`[QuizWarning] ${message}`);
}
