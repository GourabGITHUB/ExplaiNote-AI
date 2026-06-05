import type { 
  RecallResult, 
  QuizQuestion, 
  QuizQuestionType, 
  SimplifiedSummary, 
  BigPictureRecall, 
  SectionRecall, 
  FlashCard
} from '../types';

const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// ============ RETRY CONFIG ============

interface RetryConfig {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
}

const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 1500,
  maxDelayMs: 15000,
};

function isRetryableError(status: number): boolean {
  return status === 429 || status === 503 || status === 500;
}

async function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============ IN-FLIGHT DEDUPLICATION ============

const inflightRequests = new Map<string, Promise<any>>();

function deduplicatedRequest<T>(key: string, producer: () => Promise<T>): Promise<T> {
  const existing = inflightRequests.get(key);
  if (existing) {
    console.log(`[dedup] Piggy-backing on in-flight request: ${key}`);
    return existing as Promise<T>;
  }

  const promise = producer().finally(() => {
    inflightRequests.delete(key);
  });

  inflightRequests.set(key, promise);
  return promise;
}

// ============ SECTION EXPAND THROTTLE ============

/**
 * Micro-jitter delay + sequential queue for section recall requests.
 *
 * Problem: When a user rapidly clicks 4 section expanders within ~50ms,
 * each click resolves its await buildCacheKey() at slightly different times,
 * so they all miss the dedup map and fire 4 parallel API calls → instant
 * rate-limit on the free tier.
 *
 * Solution: A tiny queue that spaces section requests apart by at least
 * SECTION_JITTER_MS. The first request goes immediately; subsequent ones
 * wait for the previous to start + jitter.
 */
const SECTION_JITTER_MS = 350;
let sectionQueueTail: Promise<void> = Promise.resolve();

function enqueueSectionRequest<T>(fn: () => Promise<T>): Promise<T> {
  // Chain onto the tail: wait for previous section to START (not finish),
  // then add jitter, then run ours.
  const result = sectionQueueTail.then(async () => {
    await sleep(SECTION_JITTER_MS);
    return fn();
  });

  // Update the tail to track when THIS request's jitter has elapsed
  // (not when the API call finishes — we don't want to serialize fully)
  sectionQueueTail = sectionQueueTail
    .then(() => sleep(SECTION_JITTER_MS))
    .catch(() => {}); // swallow errors so the queue never jams

  return result;
}

// ============ SHA-256 HASHING ============

const CACHE_VERSION = 'v1';

function normalizeTextForHashing(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

async function sha256(input: string): Promise<string> {
  try {
    const encoder = new TextEncoder();
    const data    = encoder.encode(input);
    const buffer  = await crypto.subtle.digest('SHA-256', data);
    const bytes   = new Uint8Array(buffer);
    return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    let hash = 5381;
    for (let i = 0; i < input.length; i++) {
      hash = ((hash << 5) + hash + input.charCodeAt(i)) >>> 0;
    }
    return hash.toString(16);
  }
}

async function buildCacheKey(prefix: string, text: string, extra?: string): Promise<string> {
  const normalized = normalizeTextForHashing(text);
  const hash       = await sha256(normalized);
  const short      = hash.substring(0, 16);
  return extra
    ? `${prefix}:${CACHE_VERSION}:${short}:${extra}`
    : `${prefix}:${CACHE_VERSION}:${short}`;
}

// ============ INDEXEDDB CACHE LAYER ============

const DB_NAME    = 'ExplaiNoteCache';
const DB_VERSION = 1;
const STORE_NAME = 'gemini_responses';
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

interface CacheEntry {
  key: string;
  data: any;
  timestamp: number;
}

function openCacheDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'key' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror   = () => reject(request.error);
  });
}

async function getCached<T>(key: string): Promise<T | null> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx    = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req   = store.get(key);

      req.onsuccess = () => {
        const entry = req.result as CacheEntry | undefined;
        if (!entry) { resolve(null); return; }

        if (Date.now() - entry.timestamp > CACHE_TTL_MS) {
          const delTx = db.transaction(STORE_NAME, 'readwrite');
          delTx.objectStore(STORE_NAME).delete(key);
          resolve(null);
          return;
        }

        resolve(entry.data as T);
      };

      req.onerror = () => resolve(null);
    });
  } catch {
    return null;
  }
}

async function setCache(key: string, data: any): Promise<void> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx    = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const entry: CacheEntry = { key, data, timestamp: Date.now() };
      store.put(entry);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  } catch {
    // Silently ignore
  }
}

export async function clearGeminiCache(): Promise<void> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  } catch {
    // Silently ignore
  }
}

// ============ JSON REPAIR PIPELINE ============

function stripRogueCharacters(text: string): string {
  return text
    .replace(/[\uFEFF\u200B\u200C\u200D\u2060]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, '-');
}

function normalizeLiteralWhitespace(text: string): string {
  let result = '';
  let insideString = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === '\\' && insideString && i + 1 < text.length) {
      result += char + text[i + 1];
      i += 2;
      continue;
    }

    if (char === '"') {
      insideString = !insideString;
      result += char;
      i++;
      continue;
    }

    if (insideString) {
      if (char === '\n') { result += '\\n'; i++; continue; }
      if (char === '\r') { result += '\\r'; i++; continue; }
      if (char === '\t') { result += '\\t'; i++; continue; }
    }

    result += char;
    i++;
  }

  return result;
}

function fixUnescapedQuotes(text: string): string {
  let result = '';
  let insideString = false;
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === '\\' && i + 1 < text.length) {
      result += char + text[i + 1];
      i += 2;
      continue;
    }

    if (char === '"') {
      if (!insideString) {
        insideString = true;
        result += char;
        i++;
        continue;
      }

      const next = peekNextNonWhitespace(text, i + 1);
      const isClosingQuote =
        next === ',' ||
        next === '}' ||
        next === ']' ||
        next === '';

      if (isClosingQuote) {
        insideString = false;
        result += char;
      } else {
        result += '\\"';
      }

      i++;
      continue;
    }

    result += char;
    i++;
  }

  return result;
}

function peekNextNonWhitespace(text: string, fromIndex: number): string {
  for (let j = fromIndex; j < text.length; j++) {
    if (!/\s/.test(text[j])) return text[j];
  }
  return '';
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

function extractBalanced(
  text: string,
  startIdx: number,
  openChar: string,
  closeChar: string
): string | null {
  let depth = 0;
  let insideString = false;
  let i = startIdx;

  while (i < text.length) {
    const char = text[i];
    if (char === '\\' && insideString) { i += 2; continue; }
    if (char === '"') { insideString = !insideString; i++; continue; }
    if (!insideString) {
      if (char === openChar)  depth++;
      if (char === closeChar) depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
    i++;
  }

  return null;
}

function attemptTruncationRepair(text: string): string {
  let insideString = false;
  const stack: string[] = [];
  let i = 0;

  while (i < text.length) {
    const char = text[i];

    if (char === '\\' && insideString && i + 1 < text.length) {
      i += 2;
      continue;
    }

    if (char === '"') {
      insideString = !insideString;
      i++;
      continue;
    }

    if (!insideString) {
      if (char === '{' || char === '[') stack.push(char);
      if (char === '}' || char === ']') stack.pop();
    }

    i++;
  }

  let repaired = text;
  if (insideString) repaired += '"';
  for (let j = stack.length - 1; j >= 0; j--) {
    repaired += stack[j] === '{' ? '}' : ']';
  }

  return repaired;
}

function extractJSON(text: string): string {
  const cleaned = stripRogueCharacters(text);

  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]?.trim()) return fenceMatch[1].trim();

  const firstBracket = cleaned.search(/[\[{]/);
  if (firstBracket !== -1) {
    const openChar  = cleaned[firstBracket];
    const closeChar = openChar === '[' ? ']' : '}';
    const balanced  = extractBalanced(cleaned, firstBracket, openChar, closeChar);
    if (balanced) return balanced;
    return cleaned.slice(firstBracket);
  }

  return cleaned;
}

function safeParseJSON<T>(text: string): T {
  const s1 = stripRogueCharacters(text);
  const s2 = normalizeLiteralWhitespace(s1);
  const s3 = removeTrailingCommas(s2);
  const s4 = attemptTruncationRepair(s2);
  const s5 = fixUnescapedQuotes(s2);
  const s6 = removeTrailingCommas(s5);
  const s7 = attemptTruncationRepair(s5);
  const s8 = removeTrailingCommas(attemptTruncationRepair(fixUnescapedQuotes(s2)));

  const strategies: Array<{ name: string; value: string }> = [
    { name: 'raw',                                        value: text },
    { name: 'strip-rogue-chars',                          value: s1   },
    { name: 'normalize-whitespace',                       value: s2   },
    { name: 'normalize + remove-trailing-commas',         value: s3   },
    { name: 'normalize + truncation-repair',              value: s4   },
    { name: 'normalize + fix-quotes',                     value: s5   },
    { name: 'normalize + fix-quotes + remove-commas',     value: s6   },
    { name: 'normalize + fix-quotes + truncation-repair', value: s7   },
    { name: 'full-pipeline',                              value: s8   },
  ];

  const errors: string[] = [];

  for (const strategy of strategies) {
    try {
      const parsed = JSON.parse(strategy.value);
      if (strategy.name !== 'raw') {
        console.warn(`[safeParseJSON] Recovered using strategy: "${strategy.name}"`);
      }
      return parsed as T;
    } catch (err: any) {
      errors.push(`  • [${strategy.name}]: ${err.message}`);
    }
  }

  throw new Error(
    `[safeParseJSON] All strategies failed.\n` +
    `Attempted:\n${errors.join('\n')}\n` +
    `Input (first 500 chars):\n${text.slice(0, 500)}`
  );
}

// ============ GEMINI FETCH WITH RETRY ============

async function callGeminiWithRetry<T>(
  userApiKey: string,
  requestBody: object,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: Error | null = null;

  const trimmedUserKey = userApiKey.trim();
  const targetUrl = trimmedUserKey
    ? `${GEMINI_API_URL}?key=${trimmedUserKey}`
    : `/api/proxy`;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-App-Client': 'ExplaiNote-SPA-Client',
        },
        body: JSON.stringify(requestBody),
      });

      if (!response.ok) {
        const errData    = await response.json().catch(() => ({}));
        const errMessage = errData?.error?.message || `API error: ${response.status}`;

        if (isRetryableError(response.status) && attempt < config.maxRetries) {
          const delay = Math.min(
            config.baseDelayMs * Math.pow(2, attempt) + Math.random() * 500,
            config.maxDelayMs
          );
          console.warn(
            `[callGeminiWithRetry] HTTP ${response.status} — ` +
            `retrying attempt ${attempt + 1}/${config.maxRetries} in ${Math.round(delay)}ms…`
          );
          await sleep(delay);
          continue;
        }

        throw new Error(errMessage);
      }

      const data    = await response.json();
      const rawText = data?.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined;

      if (!rawText) {
        const finishReason = data?.candidates?.[0]?.finishReason;
        if (finishReason === 'MAX_TOKENS') {
          throw new Error('Response cut off — token limit exceeded. Try shorter content.');
        }
        throw new Error('No response content from AI');
      }

      const finishReason = data?.candidates?.[0]?.finishReason;
      if (finishReason === 'MAX_TOKENS') {
        console.warn('[callGeminiWithRetry] Response hit MAX_TOKENS — attempting repair…');
      }

      const jsonStr = extractJSON(rawText);
      return safeParseJSON<T>(jsonStr);

    } catch (err: any) {
      lastError = err;

      if (attempt < config.maxRetries && err.name === 'TypeError') {
        const delay = config.baseDelayMs * Math.pow(2, attempt);
        console.warn(
          `[callGeminiWithRetry] Network error — ` +
          `retrying attempt ${attempt + 1}/${config.maxRetries}…`
        );
        await sleep(delay);
        continue;
      }

      throw err;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

// ============ SCHEMA DEFINITIONS ============

const flashCardSchema = {
  type: "OBJECT",
  properties: {
    question:   { type: "STRING" },
    answer:     { type: "STRING" },
    difficulty: { type: "STRING", enum: ["basic", "intermediate", "advanced"] }
  },
  required: ["question", "answer", "difficulty"]
};

const keyConceptSchema = {
  type: "OBJECT",
  properties: {
    term:        { type: "STRING" },
    explanation: { type: "STRING" }
  },
  required: ["term", "explanation"]
};

const simplifiedSectionSchema = {
  type: "OBJECT",
  properties: {
    heading:           { type: "STRING" },
    simpleExplanation: { type: "STRING" },
    keyPoints:         { type: "ARRAY", items: { type: "STRING" } },
    analogy:           { type: "STRING" },
    realWorldExample:  { type: "STRING" }
  },
  required: ["heading", "simpleExplanation", "keyPoints"]
};

const mergedSummaryBigPictureSchema = {
  type: "OBJECT",
  properties: {
    documentOverview:  { type: "STRING" },
    documentStructure: { type: "ARRAY", items: { type: "STRING" } },
    simplifiedSummary: {
      type: "OBJECT",
      properties: {
        title:           { type: "STRING" },
        oneLinerSummary: { type: "STRING" },
        whyItMatters:    { type: "STRING" },
        coreIdea:        { type: "STRING" },
        sections:        { type: "ARRAY", items: simplifiedSectionSchema },
        keyTakeaways:    { type: "ARRAY", items: { type: "STRING" } },
        quickRecap:      { type: "STRING" },
        glossary:        { type: "ARRAY", items: keyConceptSchema }
      },
      required: ["title", "oneLinerSummary", "whyItMatters", "coreIdea", "sections", "keyTakeaways", "quickRecap"]
    },
    bigPictureRecall: {
      type: "OBJECT",
      properties: {
        mainIdeas:            { type: "ARRAY", items: flashCardSchema },
        coreThemes:           { type: "ARRAY", items: flashCardSchema },
        purposeAndStructure:  { type: "ARRAY", items: flashCardSchema },
        sectionRelationships: { type: "ARRAY", items: flashCardSchema },
        summaryQuestions:     { type: "ARRAY", items: flashCardSchema }
      },
      required: ["mainIdeas", "coreThemes", "purposeAndStructure"]
    },
    crossSectionConnections: { type: "ARRAY", items: flashCardSchema },
    finalReviewQuestions:    { type: "ARRAY", items: flashCardSchema }
  },
  required: ["documentOverview", "documentStructure", "simplifiedSummary", "bigPictureRecall"]
};

const singleSectionRecallSchema = {
  type: "OBJECT",
  properties: {
    sectionTitle:     { type: "STRING" },
    sectionSummary:   { type: "STRING" },
    concepts:         { type: "ARRAY", items: keyConceptSchema },
    definitions:      { type: "ARRAY", items: flashCardSchema },
    processes:        { type: "ARRAY", items: flashCardSchema },
    examples:         { type: "ARRAY", items: flashCardSchema },
    comparisons:      { type: "ARRAY", items: flashCardSchema },
    applications:     { type: "ARRAY", items: flashCardSchema },
    criticalThinking: { type: "ARRAY", items: flashCardSchema }
  },
  required: ["sectionTitle", "sectionSummary"]
};

const sectionRecallResponseSchema = {
  type: "OBJECT",
  properties: {
    sectionRecall: singleSectionRecallSchema
  },
  required: ["sectionRecall"]
};

const quizQuestionSchema = {
  type: "OBJECT",
  properties: {
    id:            { type: "INTEGER" },
    type:          { type: "STRING", enum: ["mcq", "true-false", "short-answer"] },
    question:      { type: "STRING" },
    options:       { type: "ARRAY", items: { type: "STRING" } },
    correctAnswer: { type: "STRING" },
    explanation:   { type: "STRING" },
    section:       { type: "STRING" }
  },
  required: ["id", "type", "question", "correctAnswer", "explanation"]
};

const quizResponseSchema = {
  type: "OBJECT",
  properties: {
    questions: { type: "ARRAY", items: quizQuestionSchema }
  },
  required: ["questions"]
};

// ============ SYSTEM INSTRUCTIONS ============

// Shorter system prompts → fewer input tokens per request

const MERGED_SYSTEM_INSTRUCTION = `You are an expert educational content designer.

SUMMARY (Feynman technique): Explain as if teaching a 12-year-old. Use simple language, analogies, examples. Keep every field to 1-2 sentences max.

RECALL QUESTIONS: Cover main ideas, themes, structure. Each question needs difficulty ("basic"/"intermediate"/"advanced"). Answers: 1 sentence.

CRITICAL: Be extremely concise. Valid JSON only.`;

const SECTION_RECALL_SYSTEM_INSTRUCTION = `You are an active recall expert. Create focused recall questions for one section. Each needs difficulty ("basic"/"intermediate"/"advanced"). Answers: 1 sentence. Skip empty categories. Valid JSON only.`;

const QUIZ_SYSTEM_INSTRUCTION = `You are a quiz generator. Rules: mcq=4 options, true-false=["True","False"], short-answer=no options+1-3 word answer. Explanations: 1 sentence. Valid JSON only.`;

// ============ INPUT BUDGET CONSTANTS ============

/**
 * Maximum characters sent to Gemini per request type.
 *
 * Free-tier Gemini 2.5 Flash: 1M token context, but output is capped at
 * ~8192 tokens. Our real bottleneck is OUTPUT tokens + rate limits.
 * Smaller inputs = faster responses + less chance of truncation.
 */
const INPUT_LIMITS = {
  merged:  10000,   // summary + big picture
  section: 2000,    // single section recall
  quiz:    8000,    // quiz generation
} as const;

// ============ REQUEST BUILDERS ============

interface MergedResponse {
  documentOverview:         string;
  documentStructure:        string[];
  simplifiedSummary:        SimplifiedSummary;
  bigPictureRecall:         BigPictureRecall;
  crossSectionConnections?: FlashCard[];
  finalReviewQuestions?:    FlashCard[];
}

interface SectionRecallResponse {
  sectionRecall: SectionRecall;
}

interface QuizResponse {
  questions: QuizQuestion[];
}

function buildMergedSummaryBigPictureRequest(text: string) {
  return {
    systemInstruction: {
      parts: [{ text: MERGED_SYSTEM_INSTRUCTION }]
    },
    contents: [{
      parts: [{
        text: `Analyze and produce BOTH a simplified summary AND big-picture recall in one JSON.

SUMMARY:
- documentStructure: 3-4 section titles
- title, oneLinerSummary: 1 sentence each
- whyItMatters, coreIdea: 1 sentence each
- sections: MAX 3, each: simpleExplanation(1 sentence), 3 keyPoints(1 sentence each), analogy(1 sentence), realWorldExample(1 sentence)
- keyTakeaways: MAX 3 (1 sentence each)
- quickRecap: 1 sentence
- glossary: MAX 3 terms

RECALL (9 questions total, 1 sentence answers):
- mainIdeas:2, coreThemes:2, purposeAndStructure:1, sectionRelationships:1, summaryQuestions:1, crossSectionConnections:1, finalReviewQuestions:1

CONTENT:
"""
${text.substring(0, INPUT_LIMITS.merged)}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 3500,
      responseMimeType: "application/json",
      responseSchema: mergedSummaryBigPictureSchema
    }
  };
}

function buildSectionRecallRequest(sectionTitle: string, sectionContent: string) {
  return {
    systemInstruction: {
      parts: [{ text: SECTION_RECALL_SYSTEM_INSTRUCTION }]
    },
    contents: [{
      parts: [{
        text: `Section: "${sectionTitle}"

Limits (1 sentence answers, skip N/A):
- sectionSummary:1 sentence, concepts:max 2, definitions:max 1, processes:max 1, examples:max 1, comparisons:max 1, applications:max 1, criticalThinking:max 1
Total: max 7 questions.

Content:
"""
${sectionContent.substring(0, INPUT_LIMITS.section)}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 800,
      responseMimeType: "application/json",
      responseSchema: sectionRecallResponseSchema
    }
  };
}

function buildQuizRequest(text: string, questionType: QuizQuestionType, numQuestions: number) {
  const typeMap: Record<string, string> = {
    mixed:         'Mix of mcq, true-false, short-answer',
    mcq:           'Only mcq',
    'true-false':  'Only true-false',
    'short-answer':'Only short-answer'
  };

  const safeNum = Math.min(Math.max(numQuestions, 1), 10);

  return {
    systemInstruction: {
      parts: [{ text: QUIZ_SYSTEM_INSTRUCTION }]
    },
    contents: [{
      parts: [{
        text: `${safeNum} questions. ${typeMap[questionType] || typeMap.mixed}. Explanations: 1 sentence.

Content:
"""
${text.substring(0, INPUT_LIMITS.quiz)}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.4,
      topP: 0.9,
      maxOutputTokens: 1200,
      responseMimeType: "application/json",
      responseSchema: quizResponseSchema
    }
  };
}

// ============ SECTION CONTENT EXTRACTION ============

function extractSectionContent(
  fullText: string,
  sectionTitle: string,
  allSections: string[]
): string {
  const lowerText  = fullText.toLowerCase();
  const lowerTitle = sectionTitle.toLowerCase();

  let startIndex = lowerText.indexOf(lowerTitle);

  if (startIndex === -1) {
    const words = lowerTitle.split(' ').filter(w => w.length > 3);
    for (const word of words) {
      const idx = lowerText.indexOf(word);
      if (idx !== -1) { startIndex = idx; break; }
    }
  }

  if (startIndex === -1) {
    const sectionIndex = allSections.indexOf(sectionTitle);
    const chunkSize    = Math.floor(fullText.length / Math.max(allSections.length, 1));
    return fullText.substring(
      sectionIndex * chunkSize,
      (sectionIndex + 1) * chunkSize + 300
    );
  }

  let endIndex = fullText.length;
  const currentSectionIndex = allSections.indexOf(sectionTitle);

  for (let i = currentSectionIndex + 1; i < allSections.length; i++) {
    const nextSection = allSections[i].toLowerCase();
    const nextIdx     = lowerText.indexOf(nextSection, startIndex + lowerTitle.length);
    if (nextIdx !== -1 && nextIdx < endIndex) {
      endIndex = nextIdx;
      break;
    }
  }

  // Cap at INPUT_LIMITS.section to keep request small
  return fullText.substring(startIndex, Math.min(endIndex, startIndex + INPUT_LIMITS.section));
}

// ============ MAIN EXPORT FUNCTIONS ============

export async function generateRecallContent(apiKey: string, text: string): Promise<RecallResult> {
  const maxChars      = 25000;
  const truncatedText = text.length > maxChars
    ? text.substring(0, maxChars) + '\n\n[Content truncated...]'
    : text;

  const cacheKey = await buildCacheKey('recall-core', truncatedText);

  return deduplicatedRequest<RecallResult>(cacheKey, async () => {
    const cached = await getCached<RecallResult>(cacheKey);
    if (cached) {
      console.log('[generateRecallContent] Cache hit — skipping API call');
      return cached;
    }

    console.log('Generating summary + big picture recall (merged call)…');
    let merged: MergedResponse;

    try {
      merged = await callGeminiWithRetry<MergedResponse>(
        apiKey,
        buildMergedSummaryBigPictureRequest(truncatedText)
      );
    } catch (err: any) {
      console.error('Merged call failed:', err.message);
      throw new Error(`Failed to generate content: ${err.message}`);
    }

    const result: RecallResult = {
      documentOverview:        merged.documentOverview,
      documentStructure:       merged.documentStructure || [],
      simplifiedSummary:       merged.simplifiedSummary,
      bigPictureRecall:        merged.bigPictureRecall || createEmptyBigPictureRecall(),
      sectionRecalls:          [],
      crossSectionConnections: merged.crossSectionConnections || [],
      finalReviewQuestions:    merged.finalReviewQuestions    || [],
      totalCoverage:           calculateCoverage([], merged)
    };

    await setCache(cacheKey, result);
    return result;
  });
}

export async function generateSectionRecall(
  apiKey: string,
  fullText: string,
  sectionTitle: string,
  allSections: string[]
): Promise<SectionRecall> {
  const maxChars      = 25000;
  const truncatedText = fullText.length > maxChars
    ? fullText.substring(0, maxChars)
    : fullText;

  const sectionHash  = await sha256(normalizeTextForHashing(sectionTitle));
  const sectionShort = sectionHash.substring(0, 12);
  const cacheKey     = await buildCacheKey('section', truncatedText, sectionShort);

  return deduplicatedRequest<SectionRecall>(cacheKey, () =>
    // ── Enqueue through the jitter gate so rapid expands don't burst ──
    enqueueSectionRequest(async () => {
      const cached = await getCached<SectionRecall>(cacheKey);
      if (cached) {
        console.log(`[generateSectionRecall] Cache hit for "${sectionTitle}"`);
        return cached;
      }

      console.log(`Generating recall for section "${sectionTitle}"…`);

      try {
        const sectionContent  = extractSectionContent(truncatedText, sectionTitle, allSections);
        const response        = await callGeminiWithRetry<SectionRecallResponse>(
          apiKey,
          buildSectionRecallRequest(sectionTitle, sectionContent)
        );

        const sectionRecall = response.sectionRecall || createEmptySectionRecall(sectionTitle);
        await setCache(cacheKey, sectionRecall);
        return sectionRecall;

      } catch (err: any) {
        console.warn(`Section "${sectionTitle}" failed:`, err.message);
        return createEmptySectionRecall(sectionTitle);
      }
    })
  );
}

export async function generateQuiz(
  apiKey: string,
  text: string,
  questionType: QuizQuestionType,
  numQuestions: number = 5
): Promise<QuizQuestion[]> {
  const safeNum       = Math.min(Math.max(numQuestions, 1), 10);
  const maxChars      = 25000;
  const truncatedText = text.length > maxChars
    ? text.substring(0, maxChars) + '\n\n[Content truncated...]'
    : text;

  const cacheKey = await buildCacheKey('quiz', truncatedText, `${questionType}:${safeNum}`);

  return deduplicatedRequest<QuizQuestion[]>(cacheKey, async () => {
    const cached = await getCached<QuizQuestion[]>(cacheKey);
    if (cached) {
      console.log('[generateQuiz] Cache hit — skipping API call');
      return cached;
    }

    const response = await callGeminiWithRetry<QuizResponse>(
      apiKey,
      buildQuizRequest(truncatedText, questionType, safeNum)
    );

    const questions = (response.questions || []).map((q, i) => ({ ...q, id: i }));
    await setCache(cacheKey, questions);
    return questions;
  });
}

// ============ HELPER FUNCTIONS ============

function createEmptyBigPictureRecall(): BigPictureRecall {
  return {
    mainIdeas:            [],
    coreThemes:           [],
    purposeAndStructure:  [],
    sectionRelationships: [],
    summaryQuestions:     []
  };
}

function createEmptySectionRecall(sectionTitle: string): SectionRecall {
  return {
    sectionTitle,
    sectionSummary:   'Unable to generate recall for this section.',
    concepts:         [],
    definitions:      [],
    processes:        [],
    examples:         [],
    comparisons:      [],
    applications:     [],
    criticalThinking: []
  };
}

function calculateCoverage(
  sectionRecalls: SectionRecall[],
  merged: MergedResponse
): { sectionsIdentified: number; questionsGenerated: number; conceptsCovered: number } {
  let totalQuestions = 0;
  let totalConcepts  = 0;

  const bp = merged.bigPictureRecall;
  if (bp) {
    totalQuestions +=
      (bp.mainIdeas?.length            || 0) +
      (bp.coreThemes?.length           || 0) +
      (bp.purposeAndStructure?.length  || 0) +
      (bp.sectionRelationships?.length || 0) +
      (bp.summaryQuestions?.length     || 0);
  }

  for (const section of sectionRecalls) {
    totalConcepts  += (section.concepts?.length          || 0);
    totalQuestions +=
      (section.definitions?.length      || 0) +
      (section.processes?.length        || 0) +
      (section.examples?.length         || 0) +
      (section.comparisons?.length      || 0) +
      (section.applications?.length     || 0) +
      (section.criticalThinking?.length || 0);
  }

  totalQuestions +=
    (merged.crossSectionConnections?.length || 0) +
    (merged.finalReviewQuestions?.length    || 0);

  const summary = merged.simplifiedSummary;
  if (summary?.glossary) totalConcepts += summary.glossary.length;

  return {
    sectionsIdentified: merged.documentStructure?.length || 0,
    questionsGenerated: totalQuestions,
    conceptsCovered:    totalConcepts
  };
}