
"use strict";

const STORAGE_KEY = "thingworxQuizState_v2";
const QUERY_PARAMS = new URLSearchParams(window.location.search);
const DEBUG_MODE = QUERY_PARAMS.get("quizDebug") === "1";
const AUTO_ADVANCE_ENABLED = QUERY_PARAMS.get("autoAdvance") !== "0";
const SEED_MODE = String(QUERY_PARAMS.get("seedMode") || "").toLowerCase();
const FIXED_SEED = String(QUERY_PARAMS.get("seed") || "").trim();
const DEFAULT_APP_TITLE = "ThingWorx Quiz";
const DEFAULT_APP_DESCRIPTION = "Certification practice quiz";
const CORE_LEVEL_ORDER = ["basic", "intermediate", "advanced"];
const CORE_QUESTIONS_PER_LEVEL = 20;
const CATEGORY_TARGETS_RATIO = { core: 0.5, scenario: 0.3, helpers: 0.2 };

const QUIZ_TYPES = {
  core: {
    id: "core",
    title: "ThingWorx Core Quiz",
    sources: [
      { file: "thingworx-quiz-webapp.json", label: "Set 1" },
      { file: "thingworx-quiz.json", label: "Set 2" }
    ],
    mode: "merged-randomized"
  },
  services: {
    id: "services",
    title: "Services & SQL Code Quiz",
    sources: [{ file: "thingworx-services-sql-quiz-v2.json", label: "Services SQL" }],
    mode: "single-dataset"
  }
};

const quizState = {
  username: "",
  currentLevelIndex: 0,
  currentQuestionIndex: 0,
  answers: [],
  score: 0
};

let quizData = null;
let baseQuizMetadata = null;
let mergedQuestionPools = createEmptyPoolMap(CORE_LEVEL_ORDER);
let questionLookupByKey = new Map();
let currentDatasetVersion = "";
let currentSeedMode = "off";
let currentSeedValue = null;
let currentQuizType = null;
let levelOrder = [];

let refs = {};
let introIntervalId = null;
let introTimeoutId = null;
let transitionTimeoutId = null;
let autoAdvanceTimeoutId = null;
let isTransitioning = false;
let hasFatalError = false;

document.addEventListener("DOMContentLoaded", async () => {
  cacheElements();
  bindEvents();
  await initializeApplication();
});

function cacheElements() {
  refs = {
    appTitle: document.getElementById("app-title"),
    appDescription: document.getElementById("app-description"),
    usernameInput: document.getElementById("username-input"),
    startBtn: document.getElementById("start-btn"),
    startError: document.getElementById("start-error"),
    quizSelectScreen: document.getElementById("quiz-select-screen"),
    quizTypeCards: document.querySelectorAll(".quiz-type-card"),
    quizSelectError: document.getElementById("quiz-select-error"),
    quizSelectBackBtn: document.getElementById("quiz-select-back-btn"),
    quizSelectStartBtn: document.getElementById("quiz-select-start-btn"),
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
    codeSnippetBox: document.getElementById("code-snippet-box"),
    codeSnippetText: document.getElementById("code-snippet-text"),
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

  refs.quizTypeCards?.forEach((card) => {
    card.addEventListener("click", () => selectQuizType(card.dataset.quizType || ""));
  });

  refs.quizSelectBackBtn?.addEventListener("click", goBackToNameScreen);
  refs.quizSelectStartBtn?.addEventListener("click", startSelectedQuizFlow);
  refs.backBtn?.addEventListener("click", () => navigate(-1));
  refs.nextBtn?.addEventListener("click", () => navigate(1));
  refs.restartBtn?.addEventListener("click", restartQuiz);
  refs.optionsContainer?.addEventListener("keydown", handleOptionKeydown);
  refs.errorReloadBtn?.addEventListener("click", () => window.location.reload());
}

async function initializeApplication() {
  const savedState = getSavedState();

  if (savedState?.selectedQuizType && savedState?.username) {
    const shouldResume = window.confirm("Resume previous attempt?");

    if (shouldResume) {
      refs.usernameInput.value = savedState.username;
      selectQuizType(savedState.selectedQuizType);

      const loaded = await loadSelectedQuiz(savedState.selectedQuizType);
      if (loaded && !hasFatalError) {
        initializeFromSavedAttempt(savedState);
        if (!hasFatalError) {
          return;
        }
      }
    }

    clearSavedState();
  }

  showScreen("start-screen");
}

function startQuizFlow() {
  if (hasFatalError) {
    return;
  }

  const username = refs.usernameInput?.value.trim() || "";
  if (!username) {
    refs.startError.textContent = "Please enter your username to continue.";
    return;
  }

  refs.startError.textContent = "";
  refs.quizSelectError.textContent = "";
  showScreen("quiz-select-screen");
}

function goBackToNameScreen() {
  refs.quizSelectError.textContent = "";
  showScreen("start-screen");
}

function selectQuizType(quizTypeId) {
  if (!QUIZ_TYPES[quizTypeId]) {
    return;
  }

  currentQuizType = quizTypeId;

  refs.quizTypeCards?.forEach((card) => {
    const selected = card.dataset.quizType === quizTypeId;
    card.classList.toggle("selected", selected);
    card.setAttribute("aria-pressed", String(selected));
  });

  if (refs.quizSelectStartBtn) {
    refs.quizSelectStartBtn.disabled = false;
  }
}

async function startSelectedQuizFlow() {
  if (hasFatalError) {
    return;
  }

  const username = refs.usernameInput?.value.trim() || "";
  if (!username) {
    refs.quizSelectError.textContent = "Please enter username first.";
    showScreen("start-screen");
    return;
  }

  if (!currentQuizType || !QUIZ_TYPES[currentQuizType]) {
    refs.quizSelectError.textContent = "Please select a quiz type.";
    return;
  }

  refs.quizSelectError.textContent = "";
  const loaded = await loadSelectedQuiz(currentQuizType);
  if (!loaded || hasFatalError) {
    return;
  }

  initializeState(username);
  if (!hasFatalError) {
    playIntroAnimation();
  }
}

async function loadSelectedQuiz(quizTypeId) {
  const quizConfig = QUIZ_TYPES[quizTypeId];
  if (!quizConfig) {
    showFatalError("Invalid quiz type selected.");
    return false;
  }

  currentQuizType = quizTypeId;

  try {
    const sourcePayloads = await Promise.all(quizConfig.sources.map((source) => fetchQuizSource(source)));

    for (const entry of sourcePayloads) {
      const validation = validateQuizPayload(entry.data, entry.source.label, quizConfig.mode);
      if (!validation.valid) {
        throw new Error(validation.message);
      }
    }

    currentDatasetVersion = buildDatasetVersion(sourcePayloads, quizTypeId);

    if (quizConfig.mode === "merged-randomized") {
      const mergeResult = mergeQuizSources(sourcePayloads);
      if (!mergeResult.valid) {
        throw new Error(mergeResult.message);
      }

      mergedQuestionPools = mergeResult.pools;
      questionLookupByKey = mergeResult.lookup;
      baseQuizMetadata = mergeResult.baseMetadata;
      levelOrder = mergeResult.levelOrder;

      quizData = createRandomizedQuizData({ mode: "off", seedValue: null });
      if (!quizData) {
        throw new Error("Unable to create randomized quiz set.");
      }
    } else {
      quizData = normalizeSingleDataset(sourcePayloads[0].data);
      if (!quizData) {
        throw new Error("Selected quiz dataset is invalid.");
      }

      baseQuizMetadata = sourcePayloads[0].data;
      levelOrder = quizData.levels.map((levelObj) => String(levelObj.level || "").toLowerCase());
      mergedQuestionPools = createEmptyPoolMap(levelOrder);
      questionLookupByKey = buildLookupForDataset(quizData);
    }

    applyAppMetadata(baseQuizMetadata);
    refs.introLevelCount.textContent = `${quizData.levels.length} Levels`;
    refs.introQuestionCount.textContent = getQuestionsPerLevelLabel(quizData.levels);
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

function validateQuizPayload(data, sourceLabel, mode) {
  if (!data || typeof data !== "object") {
    return { valid: false, message: `${sourceLabel} is missing or unreadable.` };
  }

  if (!Array.isArray(data.levels) || data.levels.length === 0) {
    return { valid: false, message: `${sourceLabel} must contain levels.` };
  }

  if (mode === "merged-randomized" && data.levels.length !== CORE_LEVEL_ORDER.length) {
    return { valid: false, message: `${sourceLabel} must contain exactly 3 levels.` };
  }

  const seenLevels = new Set();

  for (let levelIndex = 0; levelIndex < data.levels.length; levelIndex += 1) {
    const levelObj = data.levels[levelIndex];
    const levelName = String(levelObj?.level || "").trim().toLowerCase();

    if (!levelName) {
      return { valid: false, message: `${sourceLabel} has an empty level name at position ${levelIndex + 1}.` };
    }

    if (seenLevels.has(levelName)) {
      return { valid: false, message: `${sourceLabel} has duplicate level '${levelName}'.` };
    }

    seenLevels.add(levelName);

    if (mode === "merged-randomized" && !CORE_LEVEL_ORDER.includes(levelName)) {
      return { valid: false, message: `${sourceLabel} has an invalid level name '${levelName}'.` };
    }

    if (!Array.isArray(levelObj.questions) || levelObj.questions.length === 0) {
      return { valid: false, message: `${sourceLabel} level '${levelName}' must contain questions.` };
    }

    if (mode === "merged-randomized" && levelObj.questions.length !== CORE_QUESTIONS_PER_LEVEL) {
      return {
        valid: false,
        message: `${sourceLabel} level '${levelName}' must contain exactly ${CORE_QUESTIONS_PER_LEVEL} questions.`
      };
    }

    const seenQuestionIds = new Set();

    for (let questionIndex = 0; questionIndex < levelObj.questions.length; questionIndex += 1) {
      const questionObj = levelObj.questions[questionIndex];

      if (!questionObj || typeof questionObj !== "object") {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}' has an invalid question at index ${questionIndex + 1}.`
        };
      }

      const questionId = String(questionObj.id || "").trim();
      if (!questionId) {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}', question ${questionIndex + 1} is missing a valid id.`
        };
      }

      if (seenQuestionIds.has(questionId)) {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}' contains duplicate question id '${questionId}'.`
        };
      }

      seenQuestionIds.add(questionId);

      if (typeof questionObj.question !== "string" || !questionObj.question.trim()) {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}', question ${questionId} is missing question text.`
        };
      }

      if (!Array.isArray(questionObj.options) || questionObj.options.length !== 4) {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}', question ${questionId} must have exactly 4 options.`
        };
      }

      for (const option of questionObj.options) {
        if (typeof option !== "string" || !option.trim()) {
          return {
            valid: false,
            message: `${sourceLabel} level '${levelName}', question ${questionId} has an invalid option value.`
          };
        }
      }

      if (!Number.isInteger(questionObj.answerIndex) || questionObj.answerIndex < 0 || questionObj.answerIndex > 3) {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}', question ${questionId} has invalid answerIndex.`
        };
      }

      if (questionObj.codeSnippet !== undefined && typeof questionObj.codeSnippet !== "string") {
        return {
          valid: false,
          message: `${sourceLabel} level '${levelName}', question ${questionId} has invalid codeSnippet.`
        };
      }
    }
  }

  if (mode === "merged-randomized") {
    for (const levelName of CORE_LEVEL_ORDER) {
      if (!seenLevels.has(levelName)) {
        return { valid: false, message: `${sourceLabel} is missing required level '${levelName}'.` };
      }
    }
  }

  return { valid: true, message: "OK" };
}
function mergeQuizSources(sourcePayloads) {
  const pools = createEmptyPoolMap(CORE_LEVEL_ORDER);
  const lookup = new Map();
  const normalizedTextSeen = new Map();

  for (const entry of sourcePayloads) {
    for (const levelName of CORE_LEVEL_ORDER) {
      const levelObj = getLevelByName(entry.data, levelName);
      if (!levelObj || !Array.isArray(levelObj.questions)) {
        return { valid: false, message: `${entry.source.label} is missing question data for '${levelName}'.` };
      }

      for (const question of levelObj.questions) {
        const key = buildQuestionKey(levelName, question.id);

        if (lookup.has(key)) {
          return { valid: false, message: `Duplicate question id '${question.id}' detected in level '${levelName}'.` };
        }

        const normalizedQuestionText = normalizeQuestionText(question.question);
        if (normalizedQuestionText) {
          const existing = normalizedTextSeen.get(normalizedQuestionText);
          if (existing && existing.source !== entry.source.label) {
            warnLog(
              `Duplicate-like question text detected between '${existing.id}' (${existing.source}) and '${question.id}' (${entry.source.label}) in level '${levelName}'.`
            );
          } else if (!existing) {
            normalizedTextSeen.set(normalizedQuestionText, { id: question.id, source: entry.source.label });
          }
        }

        pools[levelName].push(question);
        lookup.set(key, question);
      }
    }
  }

  for (const levelName of CORE_LEVEL_ORDER) {
    const count = pools[levelName].length;
    if (count < CORE_QUESTIONS_PER_LEVEL) {
      return {
        valid: false,
        message: `Merged '${levelName}' pool has only ${count} questions; at least ${CORE_QUESTIONS_PER_LEVEL} required.`
      };
    }

    debugLog(`Pool '${levelName}' size: ${count}`);
  }

  return {
    valid: true,
    pools,
    lookup,
    baseMetadata: sourcePayloads[0].data,
    levelOrder: [...CORE_LEVEL_ORDER]
  };
}

function normalizeSingleDataset(data) {
  if (!data || !Array.isArray(data.levels)) {
    return null;
  }

  const levels = data.levels.map((levelObj) => {
    const levelName = String(levelObj?.level || "").trim().toLowerCase();
    const questions = Array.isArray(levelObj?.questions)
      ? levelObj.questions.map((questionObj) => ({ ...questionObj }))
      : [];

    return {
      level: levelName,
      questions
    };
  });

  return {
    app: data.app,
    version: data.version,
    title: data.title,
    description: data.description,
    levels
  };
}

function buildLookupForDataset(data) {
  const lookup = new Map();

  if (!data || !Array.isArray(data.levels)) {
    return lookup;
  }

  data.levels.forEach((levelObj) => {
    const levelName = String(levelObj?.level || "").toLowerCase();
    if (!levelName || !Array.isArray(levelObj.questions)) {
      return;
    }

    levelObj.questions.forEach((questionObj) => {
      const questionId = String(questionObj?.id || "").trim();
      if (!questionId) {
        return;
      }

      lookup.set(buildQuestionKey(levelName, questionId), questionObj);
    });
  });

  return lookup;
}

function createRandomizedQuizData(randomizationConfig) {
  if (!baseQuizMetadata || !Array.isArray(levelOrder) || levelOrder.length === 0) {
    return null;
  }

  const config = randomizationConfig || { mode: "off", seedValue: null };
  const levelRandomFactory = createLevelRandomFactory(config);

  const levels = levelOrder.map((levelName) => {
    const pool = mergedQuestionPools[levelName];
    if (!Array.isArray(pool) || pool.length < CORE_QUESTIONS_PER_LEVEL) {
      return null;
    }

    const randomFn = levelRandomFactory(levelName);
    const selected = selectQuestionsForLevel(levelName, pool, CORE_QUESTIONS_PER_LEVEL, randomFn);
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

function selectQuestionsForLevel(levelName, pool, count, randomFn) {
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

  const targets = computeCategoryTargets(count);

  const canBalance =
    buckets.core.length >= targets.core &&
    buckets.scenario.length >= targets.scenario &&
    buckets.helpers.length >= targets.helpers;

  if (!canBalance) {
    debugLog(`Category balance fallback for '${levelName}'.`);
    return shuffleFisherYates([...pool], randomFn).slice(0, count);
  }

  const selected = [
    ...takeRandomItems(buckets.core, targets.core, randomFn),
    ...takeRandomItems(buckets.scenario, targets.scenario, randomFn),
    ...takeRandomItems(buckets.helpers, targets.helpers, randomFn)
  ];

  if (selected.length < count) {
    const selectedIds = new Set(selected.map((item) => buildQuestionKey(levelName, item.id)));
    const remainder = shuffleFisherYates(
      pool.filter((item) => !selectedIds.has(buildQuestionKey(levelName, item.id))),
      randomFn
    );
    selected.push(...remainder.slice(0, count - selected.length));
  }

  return shuffleFisherYates(selected, randomFn).slice(0, count);
}

function computeCategoryTargets(count) {
  const core = Math.round(count * CATEGORY_TARGETS_RATIO.core);
  const scenario = Math.round(count * CATEGORY_TARGETS_RATIO.scenario);
  const helpers = Math.max(0, count - core - scenario);

  return { core, scenario, helpers };
}

function initializeState(username) {
  if (!quizData) {
    return;
  }

  resetFlowFlags();

  if (QUIZ_TYPES[currentQuizType]?.mode === "merged-randomized") {
    const randomizationConfig = resolveRandomizationConfig(username);
    const randomizedQuiz = createRandomizedQuizData(randomizationConfig);

    if (!randomizedQuiz) {
      showFatalError("Unable to generate randomized quiz questions.");
      return;
    }

    currentSeedMode = randomizationConfig.mode;
    currentSeedValue = randomizationConfig.seedValue;
    quizData = randomizedQuiz;
  } else {
    currentSeedMode = "off";
    currentSeedValue = null;
  }

  buildIntroTrack();

  quizState.username = username;
  quizState.currentLevelIndex = 0;
  quizState.currentQuestionIndex = 0;
  quizState.answers = quizData.levels.map((levelObj) => Array(levelObj.questions.length).fill(null));

  calculateScore();
  persistState();
}

function initializeFromSavedAttempt(savedState) {
  if (hasFatalError || !quizData) {
    return;
  }

  if (!isSavedStateVersionCompatible(savedState)) {
    clearSavedState();
    refs.startError.textContent = "Question bank version changed. Please start a new attempt.";
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
  if (!savedState || typeof savedState !== "object") {
    return false;
  }

  if (!savedState.selectedQuestionIdsByLevel) {
    return QUIZ_TYPES[currentQuizType]?.mode === "single-dataset";
  }

  const restoredQuizData = createQuizDataFromSelectedIds(savedState.selectedQuestionIdsByLevel);
  if (!restoredQuizData) {
    return false;
  }

  quizData = restoredQuizData;
  buildIntroTrack();
  return true;
}

function createQuizDataFromSelectedIds(savedSelection) {
  if (!savedSelection || typeof savedSelection !== "object" || !Array.isArray(levelOrder)) {
    return null;
  }

  const levels = [];

  for (const levelName of levelOrder) {
    const ids = getSavedIdsForLevel(savedSelection, levelName);
    const expectedCount = getQuestionCountForLevel(levelName);

    if (!Array.isArray(ids) || ids.length !== expectedCount) {
      return null;
    }

    const seen = new Set();
    const questions = [];

    for (const id of ids) {
      const trimmedId = String(id || "").trim();
      if (!trimmedId || seen.has(trimmedId)) {
        return null;
      }

      const key = buildQuestionKey(levelName, trimmedId);
      const questionObj = questionLookupByKey.get(key);
      if (!questionObj) {
        return null;
      }

      seen.add(trimmedId);
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

function getQuestionCountForLevel(levelName) {
  const levelObj = getLevelByName(quizData, levelName);
  return Array.isArray(levelObj?.questions) ? levelObj.questions.length : 0;
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

    if (refs.introProgressFill) {
      refs.introProgressFill.style.width = `${((activeIndex + 1) / Math.max(1, totalSteps)) * 100}%`;
    }
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

function buildIntroTrack() {
  if (!refs.introLevelTrack || !quizData || !Array.isArray(quizData.levels)) {
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
  refs.questionCategory.textContent = formatCategoryLabel(questionObj.category);
  refs.questionText.textContent = questionObj.question || "";

  renderCodeSnippet(questionObj);
  renderOptions(questionObj, selectedIndex);
  renderExplanation(questionObj, selectedIndex);
  updateNavigation(selectedIndex, questionCount);
  updateProgress(questionCount);

  animateElement(refs.questionCard);
}
function renderCodeSnippet(questionObj) {
  if (!refs.codeSnippetBox || !refs.codeSnippetText) {
    return;
  }

  const snippet = typeof questionObj?.codeSnippet === "string" ? questionObj.codeSnippet : "";

  if (!snippet.trim()) {
    refs.codeSnippetBox.classList.add("hidden");
    refs.codeSnippetText.textContent = "";
    return;
  }

  refs.codeSnippetText.textContent = snippet;
  refs.codeSnippetBox.classList.remove("hidden");
  animateElement(refs.codeSnippetBox);
}

function renderOptions(questionObj, selectedIndex) {
  if (!refs.optionsContainer || !Array.isArray(questionObj?.options)) {
    return;
  }

  refs.optionsContainer.innerHTML = "";
  refs.optionsContainer.style.pointerEvents = "";

  const isAnswered = selectedIndex !== null && selectedIndex !== undefined;
  const codeMode = isCodeQuestion(questionObj);
  refs.optionsContainer.classList.toggle("code-mode", codeMode);

  questionObj.options.forEach((optionTextValue, optionIndex) => {
    const optionText = String(optionTextValue || "");
    const button = document.createElement("button");
    const isSelected = optionIndex === selectedIndex;

    button.type = "button";
    button.className = "option-card";
    button.dataset.index = String(optionIndex);
    button.setAttribute("role", "button");
    button.setAttribute("aria-selected", String(isSelected));
    button.setAttribute("aria-disabled", String(isAnswered));
    button.setAttribute("aria-label", `Option ${String.fromCharCode(65 + optionIndex)}: ${optionText}`);

    const keySpan = document.createElement("span");
    keySpan.className = "option-key";
    keySpan.textContent = String.fromCharCode(65 + optionIndex);

    const textSpan = document.createElement("span");
    textSpan.className = "option-text";
    textSpan.textContent = optionText;

    button.appendChild(keySpan);
    button.appendChild(textSpan);

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
  if (!refs.explanationBox || !refs.answerFeedback || !refs.explanationText || !refs.correctAnswerText) {
    return;
  }

  if (selectedIndex === null || selectedIndex === undefined) {
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

function updateNavigation(selectedIndex, questionCount) {
  if (!quizData || !refs.backBtn || !refs.nextBtn) {
    return;
  }

  const isFirstOverall = quizState.currentLevelIndex === 0 && quizState.currentQuestionIndex === 0;
  refs.backBtn.disabled = isFirstOverall;

  const isLastQuestion = quizState.currentQuestionIndex === questionCount - 1;
  const isLastLevel = quizState.currentLevelIndex === quizData.levels.length - 1;

  refs.nextBtn.textContent = isLastQuestion ? (isLastLevel ? "Finish Quiz" : "Next Level") : "Next";
  refs.nextBtn.disabled = selectedIndex === null || selectedIndex === undefined;
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

function handleAnswer(selectedIndex) {
  if (hasFatalError || isTransitioning || !isStateReady()) {
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

  const existing = quizState.answers[levelIndex][questionIndex];
  if (existing !== null && existing !== undefined) {
    return;
  }

  if (refs.optionsContainer) {
    refs.optionsContainer.style.pointerEvents = "none";
  }

  try {
    quizState.answers[levelIndex][questionIndex] = selectedIndex;
    calculateScore();
    persistState();

    const isLastQuestionInLevel = questionIndex === levelObj.questions.length - 1;
    const isLastLevel = levelIndex === quizData.levels.length - 1;

    renderQuestion();
    smoothScrollToExplanation();

    if (isLastQuestionInLevel) {
      scheduleOptionalAutoAdvance(levelIndex, questionIndex, isLastLevel);
    }
  } finally {
    if (refs.optionsContainer) {
      refs.optionsContainer.style.pointerEvents = "";
    }
  }
}

function navigate(direction) {
  if (hasFatalError || !quizData || isTransitioning) {
    return;
  }

  cancelAutoAdvance();

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
    recoverNavigationState();
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

function scheduleOptionalAutoAdvance(levelIndex, questionIndex, isLastLevel) {
  if (!AUTO_ADVANCE_ENABLED) {
    return;
  }

  debugLog("Auto advancing started");
  cancelAutoAdvance();

  autoAdvanceTimeoutId = window.setTimeout(() => {
    try {
      debugLog("Moving to next question");

      if (isTransitioning) {
        return;
      }

      if (quizState.currentLevelIndex !== levelIndex || quizState.currentQuestionIndex !== questionIndex) {
        return;
      }

      const selectedIndex = quizState.answers?.[levelIndex]?.[questionIndex];
      if (selectedIndex === null || selectedIndex === undefined) {
        return;
      }

      if (isLastLevel) {
        calculateScore();
        persistState();
        renderResult();
      } else {
        showLevelTransition(levelIndex + 1);
      }
    } catch (error) {
      console.error("Auto-advance failed:", error);
    } finally {
      recoverNavigationState();
      debugLog("Auto advancing ended");
    }
  }, 1000);
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
  currentQuizType = null;
  currentDatasetVersion = "";
  levelOrder = [];
  quizData = null;
  baseQuizMetadata = null;
  questionLookupByKey = new Map();
  mergedQuestionPools = createEmptyPoolMap(CORE_LEVEL_ORDER);

  refs.quizTypeCards?.forEach((card) => {
    card.classList.remove("selected");
    card.setAttribute("aria-pressed", "false");
  });

  if (refs.quizSelectStartBtn) {
    refs.quizSelectStartBtn.disabled = true;
  }

  refs.usernameInput.value = "";
  refs.startError.textContent = "";
  refs.quizSelectError.textContent = "";

  applyAppMetadata({ title: DEFAULT_APP_TITLE, description: DEFAULT_APP_DESCRIPTION });
  refs.introLevelCount.textContent = "3 Levels";
  refs.introQuestionCount.textContent = "20 Questions Each";

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

  return quizData.levels.reduce((sum, levelObj) => sum + (Array.isArray(levelObj.questions) ? levelObj.questions.length : 0), 0);
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

function recoverNavigationState() {
  if (!quizData || !isStateReady()) {
    return;
  }

  const levelObj = getCurrentLevel();
  if (!levelObj || !Array.isArray(levelObj.questions)) {
    return;
  }

  const selectedIndex = quizState.answers[quizState.currentLevelIndex][quizState.currentQuestionIndex];
  updateNavigation(selectedIndex, levelObj.questions.length);
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
      selectedQuizType: currentQuizType,
      selectedQuestionIdsByLevel: getSelectedQuestionIdsByLevel(),
      datasetVersion: currentDatasetVersion,
      seedMode: currentSeedMode,
      seedValue: currentSeedValue,
      savedAt: Date.now()
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
    if (!levelName || !Array.isArray(levelObj.questions)) {
      return null;
    }

    selection[levelName] = levelObj.questions.map((questionObj) => questionObj.id);
  }

  return selection;
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

  currentSeedMode = typeof savedState.seedMode === "string" ? savedState.seedMode : "off";
  currentSeedValue = Number.isInteger(savedState.seedValue) ? savedState.seedValue : null;

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
    const questionList = levels[levelIndex]?.questions;
    const savedLevelAnswers = savedState.answers[levelIndex];

    if (!Array.isArray(questionList) || !Array.isArray(savedLevelAnswers) || savedLevelAnswers.length !== questionList.length) {
      return null;
    }

    answers.push(
      savedLevelAnswers.map((value) =>
        value === null || (Number.isInteger(value) && value >= 0 && value <= 3) ? value : null
      )
    );
  }

  const safeLevelIndex = clampNumber(savedState.currentLevelIndex, 0, levels.length - 1);
  const maxQuestionIndex = Math.max(0, levels[safeLevelIndex].questions.length - 1);

  return {
    username: savedState.username.trim(),
    currentLevelIndex: safeLevelIndex,
    currentQuestionIndex: clampNumber(savedState.currentQuestionIndex, 0, maxQuestionIndex),
    answers
  };
}

function isSavedStateVersionCompatible(savedState) {
  if (!savedState || typeof savedState !== "object") {
    return false;
  }

  if (savedState.selectedQuizType !== currentQuizType) {
    return false;
  }

  const savedVersion = String(savedState.datasetVersion || "");
  const currentVersion = String(currentDatasetVersion || "");

  return Boolean(savedVersion) && Boolean(currentVersion) && savedVersion === currentVersion;
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

function showFatalError(message) {
  hasFatalError = true;
  clearTimers();
  isTransitioning = false;

  if (refs.fatalErrorMessage) {
    refs.fatalErrorMessage.textContent = message || "Unable to initialize quiz.";
  }

  showScreen("error-screen");
}

function applyAppMetadata(metadata) {
  if (!refs.appTitle || !refs.appDescription) {
    return;
  }

  refs.appTitle.textContent = metadata?.title || DEFAULT_APP_TITLE;
  refs.appDescription.textContent = metadata?.description || DEFAULT_APP_DESCRIPTION;
}

function getQuestionsPerLevelLabel(levels) {
  if (!Array.isArray(levels) || levels.length === 0) {
    return "Questions";
  }

  const counts = levels.map((levelObj) => (Array.isArray(levelObj.questions) ? levelObj.questions.length : 0));
  const allSame = counts.every((count) => count === counts[0]);

  if (allSame) {
    return `${counts[0]} Questions Each`;
  }

  return levels
    .map((levelObj, index) => `${toDisplayLevel(levelObj.level)} ${counts[index]}`)
    .join(" • ");
}

function isCodeQuestion(questionObj) {
  const category = String(questionObj?.category || "").toLowerCase();
  const hasSnippet = typeof questionObj?.codeSnippet === "string" && questionObj.codeSnippet.trim().length > 0;

  return hasSnippet || category.includes("sql") || category.includes("js") || category.includes("snippet") || category.includes("code");
}

function formatCategoryLabel(categoryValue) {
  const normalized = String(categoryValue || "General")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "GENERAL";
  }

  return normalized
    .split(" ")
    .map((word) => {
      const lower = word.toLowerCase();
      if (lower === "js") {
        return "JS";
      }
      if (lower === "sql") {
        return "SQL";
      }
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function buildDatasetVersion(sourcePayloads, quizTypeId) {
  return `${quizTypeId}::${sourcePayloads
    .map((entry) => `${entry.source.file}:${String(entry.data?.version || "unknown")}`)
    .sort()
    .join("|")}`;
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
  return `${String(levelName || "").toLowerCase()}::${String(questionId).trim()}`;
}

function getLevelByName(data, levelName) {
  if (!data || !Array.isArray(data.levels)) {
    return null;
  }

  return data.levels.find((levelObj) => String(levelObj?.level || "").toLowerCase() === levelName) || null;
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
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
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

function createEmptyPoolMap(levelNames) {
  const map = {};
  (Array.isArray(levelNames) && levelNames.length > 0 ? levelNames : CORE_LEVEL_ORDER).forEach((levelName) => {
    map[levelName] = [];
  });
  return map;
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
  cancelAutoAdvance();

  introIntervalId = null;
  introTimeoutId = null;
  transitionTimeoutId = null;
}

function cancelAutoAdvance() {
  clearTimeout(autoAdvanceTimeoutId);
  autoAdvanceTimeoutId = null;
}

function resetFlowFlags() {
  isTransitioning = false;
  cancelAutoAdvance();
}

function resetQuizState() {
  quizState.username = "";
  quizState.currentLevelIndex = 0;
  quizState.currentQuestionIndex = 0;
  quizState.answers = [];
  quizState.score = 0;
}

function scrollToTopSmooth() {
  try {
    window.scrollTo({ top: 0, behavior: "smooth" });
  } catch {
    window.scrollTo(0, 0);
  }
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
