
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
