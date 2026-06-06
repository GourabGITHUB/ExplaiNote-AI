import type { 
  RecallResult, 
  QuizQuestion, 
  QuizQuestionType, 
  SimplifiedSummary, 
  BigPictureRecall, 
  SectionRecall, 
  FlashCard
} from '../types';

// ============ API CONFIGURATION ============

const GEMINI_DIRECT_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';
const PROXY_ENDPOINT    = '/api/proxy';

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

const SECTION_JITTER_MS = 350;
let sectionQueueTail: Promise<void> = Promise.resolve();

function enqueueSectionRequest<T>(fn: () => Promise<T>): Promise<T> {
  const result = sectionQueueTail.then(async () => {
    await sleep(SECTION_JITTER_MS);
    return fn();
  });

  sectionQueueTail = sectionQueueTail
    .then(() => sleep(SECTION_JITTER_MS))
    .catch(() => {});

  return result;
}

// ============ SHA-256 HASHING ============

const CACHE_VERSION = 'v3';

function normalizeTextForHashing(text: string): string {
  return text
    .replace(/[\s\u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]+/g, ' ')
    .toLowerCase()
    .trim();
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

const DB_NAME      = 'ExplaiNoteCache';
const DB_VERSION   = 3;
const STORE_NAME   = 'gemini_responses';
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
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).put({ key, data, timestamp: Date.now() } as CacheEntry);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  } catch { /* silently ignore */ }
}

async function deleteCache(key: string): Promise<void> {
  try {
    const db = await openCacheDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror    = () => resolve();
    });
  } catch { /* silently ignore */ }
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
  } catch { /* silently ignore */ }
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
      result += char + text[i + 1]; i += 2; continue;
    }
    if (char === '"') { insideString = !insideString; result += char; i++; continue; }
    if (insideString) {
      if (char === '\n') { result += '\\n'; i++; continue; }
      if (char === '\r') { result += '\\r'; i++; continue; }
      if (char === '\t') { result += '\\t'; i++; continue; }
    }
    result += char; i++;
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
      result += char + text[i + 1]; i += 2; continue;
    }
    if (char === '"') {
      if (!insideString) { insideString = true; result += char; i++; continue; }
      const next = peekNextNonWhitespace(text, i + 1);
      const isClosing = next === ',' || next === '}' || next === ']' || next === ':' || next === '';
      if (isClosing) { insideString = false; result += char; }
      else { result += '\\"'; }
      i++; continue;
    }
    result += char; i++;
  }
  return result;
}

function peekNextNonWhitespace(text: string, fromIndex: number, maxLookahead = 64): string {
  const limit = Math.min(fromIndex + maxLookahead, text.length);
  for (let j = fromIndex; j < limit; j++) {
    if (!/\s/.test(text[j])) return text[j];
  }
  return '';
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

function extractBalanced(text: string, startIdx: number, openChar: string, closeChar: string): string | null {
  const MAX_SCAN = 500_000;
  let depth = 0, insideString = false, i = startIdx;
  const end = Math.min(text.length, startIdx + MAX_SCAN);
  while (i < end) {
    const char = text[i];
    if (char === '\\' && insideString) { if (i + 1 >= end) break; i += 2; continue; }
    if (char === '"') { insideString = !insideString; i++; continue; }
    if (!insideString) {
      if (char === openChar) depth++;
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
    if (char === '\\' && insideString && i + 1 < text.length) { i += 2; continue; }
    if (char === '"') { insideString = !insideString; i++; continue; }
    if (!insideString) {
      if (char === '{' || char === '[') stack.push(char);
      if (char === '}' || char === ']') stack.pop();
    }
    i++;
  }
  let repaired = text;
  if (insideString) repaired += '"';
  for (let j = stack.length - 1; j >= 0; j--) repaired += stack[j] === '{' ? '}' : ']';
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
  const stages: Array<{ name: string; transform: (s: string) => string }> = [
    { name: 'raw',                      transform: s => s },
    { name: 'strip-rogue-chars',        transform: s => stripRogueCharacters(s) },
    { name: '+ normalize-whitespace',   transform: s => normalizeLiteralWhitespace(s) },
    { name: '+ remove-trailing-commas', transform: s => removeTrailingCommas(s) },
    { name: '+ fix-unescaped-quotes',   transform: s => fixUnescapedQuotes(s) },
    { name: '+ truncation-repair',      transform: s => attemptTruncationRepair(s) },
  ];

  const errors: string[] = [];
  let current = text;

  for (const stage of stages) {
    current = stage.transform(current);
    try {
      const parsed = JSON.parse(current);
      if (stage.name !== 'raw') console.warn(`[safeParseJSON] Recovered at: "${stage.name}"`);
      return parsed as T;
    } catch (err: any) {
      errors.push(`  • [${stage.name}]: ${err.message}`);
    }
  }

  try {
    const alt = fixUnescapedQuotes(removeTrailingCommas(attemptTruncationRepair(
      normalizeLiteralWhitespace(stripRogueCharacters(text))
    )));
    const parsed = JSON.parse(alt);
    console.warn('[safeParseJSON] Recovered with alt pipeline');
    return parsed as T;
  } catch (err: any) {
    errors.push(`  • [alt-truncation-first]: ${err.message}`);
  }

  throw new Error(
    `[safeParseJSON] All strategies failed.\n${errors.join('\n')}\nInput (500 chars):\n${text.slice(0, 500)}`
  );
}

// ============ GEMINI FETCH ============

function resolveTargetUrl(userApiKey: string): { url: string; headers: Record<string, string> } {
  const trimmedKey = userApiKey.trim();
  return {
    url: PROXY_ENDPOINT,
    headers: {
      'Content-Type': 'application/json',
      'X-App-Client':  'ExplaiNote-SPA-Client',
      ...(trimmedKey ? { 'X-Gemini-Key': trimmedKey } : {}),
    },
  };
}

async function callGeminiWithRetry<T>(
  userApiKey: string,
  requestBody: object,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: Error | null = null;
  const { url: targetUrl, headers } = resolveTargetUrl(userApiKey);

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers,
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
          console.warn(`[callGemini] HTTP ${response.status} — retry ${attempt + 1}/${config.maxRetries} in ${Math.round(delay)}ms`);
          await sleep(delay);
          continue;
        }
        throw new Error(errMessage);
      }

      const data         = await response.json();
      const rawText      = data?.candidates?.[0]?.content?.parts?.[0]?.text as string | undefined;
      const finishReason = data?.candidates?.[0]?.finishReason;

      if (!rawText) {
        if (finishReason === 'MAX_TOKENS') throw new Error('Response cut off — token limit exceeded.');
        throw new Error('No response content from AI');
      }
      if (finishReason === 'MAX_TOKENS') console.warn('[callGemini] MAX_TOKENS hit — attempting repair…');

      return safeParseJSON<T>(extractJSON(rawText));

    } catch (err: any) {
      lastError = err;
      if (attempt < config.maxRetries && err.name === 'TypeError') {
        const delay = config.baseDelayMs * Math.pow(2, attempt);
        console.warn(`[callGemini] Network error — retry ${attempt + 1}/${config.maxRetries}`);
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

const summaryResponseSchema = {
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
      required: ["title", "oneLinerSummary", "whyItMatters", "coreIdea", "sections", "keyTakeaways", "quickRecap", "glossary"]
    }
  },
  required: ["documentOverview", "documentStructure", "simplifiedSummary"]
};

const bigPictureResponseSchema = {
  type: "OBJECT",
  properties: {
    bigPictureRecall: {
      type: "OBJECT",
      properties: {
        mainIdeas:            { type: "ARRAY", items: flashCardSchema },
        coreThemes:           { type: "ARRAY", items: flashCardSchema },
        purposeAndStructure:  { type: "ARRAY", items: flashCardSchema },
        sectionRelationships: { type: "ARRAY", items: flashCardSchema },
        summaryQuestions:     { type: "ARRAY", items: flashCardSchema }
      },
      required: ["mainIdeas", "coreThemes", "purposeAndStructure", "sectionRelationships", "summaryQuestions"]
    },
    crossSectionConnections: { type: "ARRAY", items: flashCardSchema },
    finalReviewQuestions:    { type: "ARRAY", items: flashCardSchema }
  },
  required: ["bigPictureRecall", "crossSectionConnections", "finalReviewQuestions"]
};

const sectionRecallSchema = {
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
  required: ["sectionTitle", "sectionSummary", "concepts", "definitions"]
};

const quizQuestionSchema = {
  type: "OBJECT",
  properties: {
    id:            { type: "NUMBER" },
    type:          { type: "STRING", enum: ["mcq", "true-false", "short-answer"] },
    question:      { type: "STRING" },
    options:       { type: "ARRAY", items: { type: "STRING" } },
    correctAnswer: { type: "STRING" },
    explanation:   { type: "STRING" }
  },
  required: ["id", "type", "question", "options", "correctAnswer", "explanation"]
};

const quizResponseSchema = {
  type: "OBJECT",
  properties: {
    questions: { type: "ARRAY", items: quizQuestionSchema }
  },
  required: ["questions"]
};

// ============ SYSTEM INSTRUCTIONS ============

const SUMMARY_SYSTEM_INSTRUCTION = `You are an expert educational content designer using the Feynman technique.
Explain as if teaching a 12-year-old. Simple language, analogies, examples.
Keep every text field to 1-2 sentences max. Valid JSON only.`;

const BIGPICTURE_SYSTEM_INSTRUCTION = `You are an active recall expert.
Create big-picture recall questions covering main ideas, themes, structure, and connections.
Each question needs difficulty ("basic"/"intermediate"/"advanced"). Answers: 1 sentence.
EVERY array field must contain at least 1 item. Never return empty arrays.
Valid JSON only.`;

const SECTION_RECALL_SYSTEM_INSTRUCTION = `You are an active recall expert.
Create focused recall questions for one section.
Each question needs difficulty ("basic"/"intermediate"/"advanced"). Answers: 1-2 sentences.
You MUST generate: sectionSummary, at least 2 concepts, and at least 1 definition.
Never return empty arrays for concepts or definitions.
Valid JSON only.`;

const QUIZ_SYSTEM_INSTRUCTION = `You are a quiz generator. STRICT RULES:

EVERY question MUST have ALL fields: id, type, question, options, correctAnswer, explanation.

TYPE RULES:
- "mcq": "options" = EXACTLY 4 strings. "correctAnswer" MUST exactly match one option.
- "true-false": "options" = ["True", "False"]. "correctAnswer" = "True" or "False" (factually correct).
- "short-answer": "options" = []. "correctAnswer" = 1-3 words.

CRITICAL:
- correctAnswer must NEVER be empty.
- correctAnswer must be FACTUALLY CORRECT.
- Generate EXACTLY the requested number of questions.
Valid JSON only.`;

// ============ INPUT LIMITS ============

const INPUT_LIMITS = {
  summary:    10000,
  bigPicture: 8000,
  section:    3000,
  quiz:       8000,
} as const;

// ============ CACHE HEALTH THRESHOLDS ============

const QUIZ_CACHE_HEALTH_RATIO    = 0.6;
const QUIZ_CACHE_MIN_ABSOLUTE    = 2;
const SECTION_CACHE_MIN_ITEMS    = 1;
const MIN_SECTIONS_FOR_BIGPICTURE = 1;

// ============ RESPONSE INTERFACES ============

interface SummaryResponse {
  documentOverview:  string;
  documentStructure: string[];
  simplifiedSummary: SimplifiedSummary;
}

interface BigPictureResponse {
  bigPictureRecall:        BigPictureRecall;
  crossSectionConnections: FlashCard[];
  finalReviewQuestions:    FlashCard[];
}

interface QuizResponse {
  questions: QuizQuestion[];
}

// ============ COVERAGE TYPES ============

export interface CoverageMetrics {
  sectionsIdentified: number;
  sectionsLoaded:     number;
  questionsGenerated: number;
  conceptsCovered:    number;
  expectedQuestions:  number;
}

// ============ SAFE UNWRAP UTILITIES ============

function unwrapSectionRecall(response: any, fallbackTitle: string): SectionRecall {
  if (!response || typeof response !== 'object') return createEmptySectionRecall(fallbackTitle);
  const inner = response.sectionRecall || response;
  return {
    sectionTitle:     inner.sectionTitle     || fallbackTitle,
    sectionSummary:   inner.sectionSummary   || '',
    concepts:         Array.isArray(inner.concepts)         ? inner.concepts         : [],
    definitions:      Array.isArray(inner.definitions)      ? inner.definitions      : [],
    processes:        Array.isArray(inner.processes)        ? inner.processes        : [],
    examples:         Array.isArray(inner.examples)         ? inner.examples         : [],
    comparisons:      Array.isArray(inner.comparisons)      ? inner.comparisons      : [],
    applications:     Array.isArray(inner.applications)     ? inner.applications     : [],
    criticalThinking: Array.isArray(inner.criticalThinking) ? inner.criticalThinking : [],
  };
}

function unwrapBigPicture(response: any): BigPictureResponse {
  if (!response || typeof response !== 'object') {
    return { bigPictureRecall: createEmptyBigPictureRecall(), crossSectionConnections: [], finalReviewQuestions: [] };
  }
  const bp = response.bigPictureRecall || {};
  return {
    bigPictureRecall: {
      mainIdeas:            Array.isArray(bp.mainIdeas)            ? bp.mainIdeas            : [],
      coreThemes:           Array.isArray(bp.coreThemes)           ? bp.coreThemes           : [],
      purposeAndStructure:  Array.isArray(bp.purposeAndStructure)  ? bp.purposeAndStructure  : [],
      sectionRelationships: Array.isArray(bp.sectionRelationships) ? bp.sectionRelationships : [],
      summaryQuestions:     Array.isArray(bp.summaryQuestions)     ? bp.summaryQuestions     : [],
    },
    crossSectionConnections: Array.isArray(response.crossSectionConnections) ? response.crossSectionConnections : [],
    finalReviewQuestions:    Array.isArray(response.finalReviewQuestions)    ? response.finalReviewQuestions    : [],
  };
}

/**
 * Unwraps and validates a summary response.
 *
 * After unwrapping, if documentStructure is empty, attempts to recover
 * section titles from simplifiedSummary.sections[].heading — Gemini
 * almost always populates sections even when documentStructure is blank.
 * This prevents the downstream "Document sections: " schema violation
 * without requiring a full retry.
 */
function unwrapSummary(response: any): SummaryResponse {
  if (!response || typeof response !== 'object') {
    return {
      documentOverview:  '',
      documentStructure: [],
      simplifiedSummary: {
        title: '', oneLinerSummary: '', whyItMatters: '', coreIdea: '',
        sections: [], keyTakeaways: [], quickRecap: '', glossary: [],
      } as SimplifiedSummary,
    };
  }

  const ss = response.simplifiedSummary || {};

  // Parse documentStructure — filter out any non-string or blank entries
  let documentStructure: string[] = Array.isArray(response.documentStructure)
    ? response.documentStructure.filter(
        (s: any) => typeof s === 'string' && s.trim().length > 0
      )
    : [];

  // Validate that each entry is substantive (more than 2 chars)
  documentStructure = documentStructure.filter(s => s.trim().length > 2);

  return {
    documentOverview:  typeof response.documentOverview === 'string' ? response.documentOverview : '',
    documentStructure,
    simplifiedSummary: {
      title:           typeof ss.title           === 'string' ? ss.title           : '',
      oneLinerSummary: typeof ss.oneLinerSummary === 'string' ? ss.oneLinerSummary : '',
      whyItMatters:    typeof ss.whyItMatters    === 'string' ? ss.whyItMatters    : '',
      coreIdea:        typeof ss.coreIdea        === 'string' ? ss.coreIdea        : '',
      sections:        Array.isArray(ss.sections)     ? ss.sections     : [],
      keyTakeaways:    Array.isArray(ss.keyTakeaways) ? ss.keyTakeaways : [],
      quickRecap:      typeof ss.quickRecap === 'string' ? ss.quickRecap : '',
      glossary:        Array.isArray(ss.glossary) ? ss.glossary : [],
    } as SimplifiedSummary,
  };
}

// ============ REQUEST BUILDERS ============

function buildSummaryRequest(text: string) {
  return {
    systemInstruction: { parts: [{ text: SUMMARY_SYSTEM_INSTRUCTION }] },
    contents: [{
      parts: [{
        text: `Create a simplified summary using the Feynman technique.

- documentStructure: 3-4 section titles found in the document
- title, oneLinerSummary: 1 sentence each
- whyItMatters, coreIdea: 1 sentence each
- sections: MAX 3, each with: simpleExplanation (1 sentence), 3 keyPoints, analogy, realWorldExample
- keyTakeaways: MAX 3 items
- quickRecap: 1 sentence
- glossary: MAX 3 terms

CONTENT:
"""
${text.substring(0, INPUT_LIMITS.summary)}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      topP: 0.85,
      maxOutputTokens: 2500,
      responseMimeType: "application/json",
      responseSchema: summaryResponseSchema
    }
  };
}

function buildBigPictureRequest(text: string, documentStructure: string[]) {
  // documentStructure is guaranteed non-empty by the call-site guard
  const sections = documentStructure.slice(0, 4).join(', ');
  return {
    systemInstruction: { parts: [{ text: BIGPICTURE_SYSTEM_INSTRUCTION }] },
    contents: [{
      parts: [{
        text: `Create big-picture recall questions for a document with these sections: ${sections}

Generate ALL of these (1 sentence answers each):
- mainIdeas: 2 questions about the central thesis
- coreThemes: 2 questions about recurring themes
- purposeAndStructure: 1 question about the author's purpose
- sectionRelationships: 1 question linking the sections above
- summaryQuestions: 1 comprehensive question
- crossSectionConnections: 1 question connecting concepts across sections
- finalReviewQuestions: 1 final review question

TOTAL: exactly 9 questions. EVERY array must have at least 1 item.

CONTENT:
"""
${text.substring(0, INPUT_LIMITS.bigPicture)}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      topP: 0.85,
      maxOutputTokens: 1500,
      responseMimeType: "application/json",
      responseSchema: bigPictureResponseSchema
    }
  };
}

function buildSectionRecallRequest(sectionTitle: string, sectionContent: string) {
  return {
    systemInstruction: { parts: [{ text: SECTION_RECALL_SYSTEM_INSTRUCTION }] },
    contents: [{
      parts: [{
        text: `Create recall questions for this section.

SECTION: "${sectionTitle}"

REQUIREMENTS (1-2 sentence answers):
- sectionSummary: 1-2 sentences (REQUIRED)
- concepts: 2 key concepts with explanations (REQUIRED)
- definitions: 1-2 definition questions, basic difficulty (REQUIRED)
- processes: 1 question if applicable (intermediate)
- examples: 1 question if applicable (intermediate)
- applications: 1 question (advanced)
Minimum: sectionSummary + 2 concepts + 1 definition.

CONTENT:
"""
${sectionContent}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      topP: 0.85,
      maxOutputTokens: 1000,
      responseMimeType: "application/json",
      responseSchema: sectionRecallSchema
    }
  };
}

function buildQuizRequest(text: string, questionType: QuizQuestionType, numQuestions: number) {
  const safeNum = Math.min(Math.max(numQuestions, 1), 10);

  const typeInstructions: Record<string, string> = {
    mcq:            `All ${safeNum} questions MUST be "mcq". Each MUST have "options" with EXACTLY 4 strings. "correctAnswer" MUST exactly match one option.`,
    'true-false':   `All ${safeNum} questions MUST be "true-false". Each MUST have "options": ["True", "False"]. "correctAnswer" must be the FACTUALLY CORRECT one.`,
    'short-answer': `All ${safeNum} questions MUST be "short-answer". Each MUST have "options": []. "correctAnswer" = 1-3 words.`,
    mixed:          `Mix of mcq, true-false, short-answer. MCQ: exactly 4 options. True-false: ["True","False"]. Short-answer: []. ALL must have non-empty correctAnswer.`
  };

  return {
    systemInstruction: { parts: [{ text: QUIZ_SYSTEM_INSTRUCTION }] },
    contents: [{
      parts: [{
        text: `Create EXACTLY ${safeNum} questions. Not ${safeNum - 1}, not ${safeNum + 1}. Exactly ${safeNum}.

${typeInstructions[questionType] || typeInstructions.mixed}

CRITICAL: Generate exactly ${safeNum} complete questions. Every correctAnswer must be factually correct and non-empty.

Content:
"""
${text.substring(0, INPUT_LIMITS.quiz)}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.3,
      topP: 0.85,
      maxOutputTokens: 3000, // Increased from 1500 — handles 10 MCQ questions comfortably
      responseMimeType: "application/json",
      responseSchema: quizResponseSchema
    }
  };
}

// ============ SECTION CONTENT EXTRACTION ============

function extractSectionContent(fullText: string, sectionTitle: string, allSections: string[]): string {
  const lowerText  = fullText.toLowerCase();
  const lowerTitle = sectionTitle.toLowerCase().trim();

  let startIndex = lowerText.indexOf(lowerTitle);

  if (startIndex === -1) {
    const cleanTitle = lowerTitle.replace(/["""''()\[\]{}&:;,.\-–—]/g, '').replace(/\s+/g, ' ').trim();
    if (cleanTitle.length > 5) startIndex = lowerText.indexOf(cleanTitle);
  }

  if (startIndex === -1) {
    const words = lowerTitle.split(/\s+/).filter(w => w.length > 3).sort((a, b) => b.length - a.length);
    for (let w = 0; w < words.length - 1 && startIndex === -1; w++) {
      const idx = lowerText.indexOf(words[w] + ' ' + words[w + 1]);
      if (idx !== -1) startIndex = idx;
    }
    if (startIndex === -1) {
      for (const word of words) {
        const idx = lowerText.indexOf(word);
        if (idx !== -1) { startIndex = idx; break; }
      }
    }
  }

  if (startIndex === -1) {
    const sectionIndex = Math.max(0, allSections.indexOf(sectionTitle));
    const chunkSize    = Math.floor(fullText.length / Math.max(allSections.length, 1));
    const chunkStart   = Math.max(0, sectionIndex * chunkSize);
    console.warn(`[extractSection] Positional fallback for "${sectionTitle}"`);
    return fullText.substring(chunkStart, Math.min(fullText.length, chunkStart + INPUT_LIMITS.section));
  }

  let endIndex = fullText.length;
  const currentIdx = allSections.indexOf(sectionTitle);

  if (currentIdx !== -1) {
    for (let i = currentIdx + 1; i < allSections.length; i++) {
      const nextTitle = allSections[i].toLowerCase().trim();
      let nextIdx = lowerText.indexOf(nextTitle, startIndex + lowerTitle.length);
      if (nextIdx === -1) {
        const cleanNext = nextTitle.replace(/["""''()\[\]{}&:;,.\-–—]/g, '').replace(/\s+/g, ' ').trim();
        if (cleanNext.length > 5) nextIdx = lowerText.indexOf(cleanNext, startIndex + lowerTitle.length);
      }
      if (nextIdx !== -1 && nextIdx < endIndex) { endIndex = nextIdx; break; }
    }
  }

  const contextStart = Math.max(0, startIndex - 200);
  const maxEnd       = Math.min(endIndex, startIndex + INPUT_LIMITS.section);
  const content      = fullText.substring(contextStart, maxEnd);

  if (content.length < 300 && fullText.length > 300) {
    return fullText.substring(contextStart, Math.min(fullText.length, contextStart + INPUT_LIMITS.section));
  }

  return content;
}

// ============ QUIZ POST-PROCESSING ============

function validateAndRepairQuiz(
  questions: QuizQuestion[],
  requestedCount: number
): { questions: QuizQuestion[]; isHealthy: boolean } {

  if (!Array.isArray(questions) || questions.length === 0) {
    return { questions: [], isHealthy: false };
  }

  const repaired = questions.map((q, i) => {
    const fixed = { ...q, id: i };
    const rawQ  = q as any;

    // Normalize type
    if (!fixed.type || !['mcq', 'true-false', 'short-answer'].includes(fixed.type)) {
      if (Array.isArray(fixed.options) && fixed.options.length === 4) fixed.type = 'mcq' as any;
      else if (Array.isArray(fixed.options) && fixed.options.length === 2 &&
        fixed.options.some(o => typeof o === 'string' && o.toLowerCase() === 'true'))
        fixed.type = 'true-false' as any;
      else fixed.type = 'short-answer' as any;
    }

    // Rescue correctAnswer — never guess
    if (!fixed.correctAnswer?.trim()) {
      let rescued = false;
      if (rawQ.answer?.trim()) { fixed.correctAnswer = rawQ.answer.trim(); rescued = true; }
      if (!rescued && rawQ.correct_answer?.trim()) { fixed.correctAnswer = rawQ.correct_answer.trim(); rescued = true; }
      if (!rescued && fixed.explanation) {
        const patterns = [
          /(?:answer|correct)\s+(?:is|was)\s+[""']([^""']+)[""']/i,
          /(?:answer|correct)\s+(?:is|was)\s+(\S+)/i,
        ];
        for (const p of patterns) {
          const m = fixed.explanation.match(p);
          if (m?.[1]?.trim()) { fixed.correctAnswer = m[1].trim(); rescued = true; break; }
        }
      }
      if (!rescued) fixed.correctAnswer = '';
    }

    // MCQ repairs
    if (fixed.type === 'mcq') {
      if (!Array.isArray(fixed.options)) fixed.options = [];
      if (fixed.options.length > 0 && fixed.correctAnswer && !fixed.options.includes(fixed.correctAnswer)) {
        const caseIdx = fixed.options.findIndex(
          o => typeof o === 'string' && o.toLowerCase().trim() === fixed.correctAnswer.toLowerCase().trim()
        );
        if (caseIdx !== -1) fixed.correctAnswer = fixed.options[caseIdx];
        else fixed.options[fixed.options.length - 1] = fixed.correctAnswer;
      }
      while (fixed.options.length < 4) fixed.options.push(`Option ${String.fromCharCode(65 + fixed.options.length)}`);
      if (fixed.options.length > 4) {
        const idx  = fixed.options.indexOf(fixed.correctAnswer);
        const kept = fixed.options.slice(0, 4);
        if (idx >= 4 && fixed.correctAnswer) kept[3] = fixed.correctAnswer;
        fixed.options = kept;
      }
      if (fixed.correctAnswer && !fixed.options.includes(fixed.correctAnswer)) fixed.options[3] = fixed.correctAnswer;
    }

    // True/False — normalize only, never guess
    if (fixed.type === 'true-false') {
      fixed.options = ['True', 'False'];
      if (fixed.correctAnswer) {
        const lower = fixed.correctAnswer.toLowerCase().trim();
        if (['true', 't', 'yes'].includes(lower))        fixed.correctAnswer = 'True';
        else if (['false', 'f', 'no'].includes(lower))   fixed.correctAnswer = 'False';
      }
    }

    if (fixed.type === 'short-answer') fixed.options = [] as any;

    if (!fixed.explanation?.trim()) {
      fixed.explanation = fixed.correctAnswer
        ? `The correct answer is "${fixed.correctAnswer}".`
        : 'No explanation provided.';
    }

    return fixed;
  });

  const valid = repaired.filter(q => Boolean(q.question?.trim()));

  valid.forEach(q => {
    if (!q.correctAnswer?.trim()) {
      q.correctAnswer    = '(answer unavailable)';
      q.explanation      = 'The AI did not provide an answer for this question.';
      (q as any)._unreliable = true;
    }
  });

  valid.forEach((q, i) => { q.id = i; });

  const reliableCount = valid.filter(q => !(q as any)._unreliable).length;
  const ratio         = reliableCount / requestedCount;
  const isHealthy     = reliableCount >= QUIZ_CACHE_MIN_ABSOLUTE && ratio >= QUIZ_CACHE_HEALTH_RATIO;

  if (valid.length < requestedCount || reliableCount < valid.length) {
    console.warn(
      `[quiz-repair] Requested ${requestedCount}, got ${valid.length} (${reliableCount} reliable) — ${isHealthy ? 'HEALTHY' : 'UNHEALTHY'}`
    );
  }

  return { questions: valid, isHealthy };
}

function validateCachedQuiz(questions: QuizQuestion[], requestedCount: number): { isHealthy: boolean } {
  if (!Array.isArray(questions)) return { isHealthy: false };
  const reliable = questions.filter(q =>
    q.question?.trim() && q.correctAnswer?.trim() &&
    q.correctAnswer !== '(answer unavailable)' && !(q as any)._unreliable
  ).length;
  return { isHealthy: reliable >= QUIZ_CACHE_MIN_ABSOLUTE && (reliable / requestedCount) >= QUIZ_CACHE_HEALTH_RATIO };
}

// ============ SECTION RECALL VALIDATION ============

function isSectionRecallHealthy(recall: SectionRecall): boolean {
  let count = 0;
  if (recall.concepts?.length)         count++;
  if (recall.definitions?.length)      count++;
  if (recall.processes?.length)        count++;
  if (recall.examples?.length)         count++;
  if (recall.comparisons?.length)      count++;
  if (recall.applications?.length)     count++;
  if (recall.criticalThinking?.length) count++;
  return count >= SECTION_CACHE_MIN_ITEMS;
}

function countSectionRecallItems(recall: SectionRecall): number {
  return (
    (recall.concepts?.length         || 0) + (recall.definitions?.length  || 0) +
    (recall.processes?.length        || 0) + (recall.examples?.length     || 0) +
    (recall.comparisons?.length      || 0) + (recall.applications?.length || 0) +
    (recall.criticalThinking?.length || 0)
  );
}

// ============ COVERAGE CALCULATION ============

function calculateCoverage(
  sectionRecalls: SectionRecall[],
  bigPicture: BigPictureResponse,
  summary: SimplifiedSummary,
  totalSections: number
): CoverageMetrics {
  let questionsGenerated = 0;
  let conceptsCovered    = 0;

  const bp = bigPicture.bigPictureRecall;
  if (bp) {
    questionsGenerated +=
      (bp.mainIdeas?.length || 0) + (bp.coreThemes?.length || 0) +
      (bp.purposeAndStructure?.length || 0) + (bp.sectionRelationships?.length || 0) +
      (bp.summaryQuestions?.length || 0);
  }
  questionsGenerated += (bigPicture.crossSectionConnections?.length || 0);
  questionsGenerated += (bigPicture.finalReviewQuestions?.length    || 0);

  for (const s of sectionRecalls) {
    conceptsCovered    += (s.concepts?.length || 0);
    questionsGenerated +=
      (s.definitions?.length || 0) + (s.processes?.length   || 0) +
      (s.examples?.length    || 0) + (s.comparisons?.length || 0) +
      (s.applications?.length || 0) + (s.criticalThinking?.length || 0);
  }

  if (summary?.glossary) conceptsCovered += summary.glossary.length;

  const avgQPerSection    = sectionRecalls.length > 0
    ? Math.round(questionsGenerated / Math.max(sectionRecalls.length, 1))
    : 7;
  const remainingSections = Math.max(0, totalSections - sectionRecalls.length);
  const expectedQuestions = questionsGenerated + (remainingSections * avgQPerSection);

  return {
    sectionsIdentified: totalSections,
    sectionsLoaded:     sectionRecalls.length,
    questionsGenerated,
    conceptsCovered,
    expectedQuestions,
  };
}

export function computeCoverageFromResult(
  result: RecallResult,
  loadedSections: SectionRecall[]
): CoverageMetrics {
  return calculateCoverage(
    loadedSections,
    {
      bigPictureRecall:        result.bigPictureRecall,
      crossSectionConnections: result.crossSectionConnections || [],
      finalReviewQuestions:    result.finalReviewQuestions    || [],
    },
    result.simplifiedSummary,
    result.documentStructure?.length || 0
  );
}

// ============ MAIN EXPORT FUNCTIONS ============

/**
 * Generates recall content: summary (Call 1) + big picture (Call 2).
 *
 * STRUCTURAL FALLBACK CHAIN (after Call 1):
 *
 *   Level 1 — documentStructure is populated normally → proceed to Call 2
 *
 *   Level 2 — documentStructure is empty BUT simplifiedSummary.sections
 *             has headings → recover section titles from headings,
 *             proceed to Call 2 with recovered titles
 *
 *   Level 3 — Both documentStructure AND sections are empty → document
 *             is too sparse/illegible. Skip Call 2 entirely, return
 *             partial result (not cached so retry gets a fresh attempt).
 *
 * This prevents "Document sections: " being sent to Gemini (Level 3),
 * while maximizing recovery for borderline documents (Level 2).
 */
export async function generateRecallContent(apiKey: string, text: string): Promise<RecallResult> {
  const maxChars      = 25000;
  const truncatedText = text.length > maxChars
    ? text.substring(0, maxChars) + '\n\n[Content truncated...]'
    : text;

  const cacheKey = await buildCacheKey('recall-core', truncatedText);

  return deduplicatedRequest<RecallResult>(cacheKey, async () => {
    const cached = await getCached<RecallResult>(cacheKey);
    if (cached) {
      if (cached.simplifiedSummary && cached.bigPictureRecall) {
        console.log('[generateRecallContent] Cache hit');
        return cached;
      }
      console.warn('[generateRecallContent] Incomplete cache — evicting');
      await deleteCache(cacheKey);
    }

    // ── Call 1: Summary ──
    console.log('Call 1: Generating summary…');
    let summaryData: SummaryResponse;

    try {
      const rawSummary = await callGeminiWithRetry<any>(apiKey, buildSummaryRequest(truncatedText));
      summaryData = unwrapSummary(rawSummary);
    } catch (err: any) {
      console.error('Summary call failed:', err.message);
      throw new Error(`Failed to generate summary: ${err.message}`);
    }

    let documentStructure = summaryData.documentStructure;

    // ── LEVEL 2 FALLBACK: Recover from simplifiedSummary.sections ──
    //
    // If documentStructure is empty but the simplified summary has
    // sections with headings, extract those headings as section titles.
    // This handles documents where Gemini populated sections correctly
    // but failed to mirror them into documentStructure.
    if (documentStructure.length < MIN_SECTIONS_FOR_BIGPICTURE) {
      const inferredSections = (summaryData.simplifiedSummary?.sections ?? [])
        .map(s => s.heading?.trim())
        .filter((h): h is string => typeof h === 'string' && h.length > 2);

      if (inferredSections.length >= MIN_SECTIONS_FOR_BIGPICTURE) {
        console.warn(
          `[generateRecallContent] documentStructure was empty — ` +
          `recovered ${inferredSections.length} section titles from simplifiedSummary.sections`
        );
        documentStructure = inferredSections;
        // Patch the summaryData so the result is consistent
        summaryData = { ...summaryData, documentStructure: inferredSections };
      }
    }

    // ── LEVEL 3 FALLBACK: Both sources empty — document too sparse ──
    if (documentStructure.length < MIN_SECTIONS_FOR_BIGPICTURE) {
      console.warn(
        `[generateRecallContent] documentStructure is empty AND no section headings found. ` +
        `Document may be too sparse or illegible. ` +
        `Skipping big picture call. Returning partial result (not cached).`
      );

      // Return partial result — intentionally NOT cached so a retry
      // attempts fresh generation rather than serving this empty result.
      return {
        documentOverview:        summaryData.documentOverview || '',
        documentStructure:       [],
        simplifiedSummary:       summaryData.simplifiedSummary,
        bigPictureRecall:        createEmptyBigPictureRecall(),
        sectionRecalls:          [],
        crossSectionConnections: [],
        finalReviewQuestions:    [],
        totalCoverage:           calculateCoverage(
          [],
          { bigPictureRecall: createEmptyBigPictureRecall(), crossSectionConnections: [], finalReviewQuestions: [] },
          summaryData.simplifiedSummary,
          0
        ),
      };
    }

    // ── Call 2: Big Picture Recall ──
    console.log(`Call 2: Generating big picture recall (${documentStructure.length} sections)…`);
    let bigPictureData: BigPictureResponse;

    try {
      await sleep(500);
      const rawBigPicture = await callGeminiWithRetry<any>(
        apiKey,
        buildBigPictureRequest(truncatedText, documentStructure)
      );
      bigPictureData = unwrapBigPicture(rawBigPicture);
    } catch (err: any) {
      console.warn('Big picture call failed:', err.message, '— returning partial result');
      bigPictureData = {
        bigPictureRecall:        createEmptyBigPictureRecall(),
        crossSectionConnections: [],
        finalReviewQuestions:    [],
      };
    }

    const result: RecallResult = {
      documentOverview:        summaryData.documentOverview        || '',
      documentStructure,
      simplifiedSummary:       summaryData.simplifiedSummary,
      bigPictureRecall:        bigPictureData.bigPictureRecall     || createEmptyBigPictureRecall(),
      sectionRecalls:          [],
      crossSectionConnections: bigPictureData.crossSectionConnections || [],
      finalReviewQuestions:    bigPictureData.finalReviewQuestions    || [],
      totalCoverage:           calculateCoverage(
        [],
        bigPictureData,
        summaryData.simplifiedSummary,
        documentStructure.length
      ),
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
  const truncatedText = fullText.length > maxChars ? fullText.substring(0, maxChars) : fullText;

  const sectionHash  = await sha256(normalizeTextForHashing(sectionTitle));
  const sectionShort = sectionHash.substring(0, 12);
  const cacheKey     = await buildCacheKey('section', truncatedText, sectionShort);

  return deduplicatedRequest<SectionRecall>(cacheKey, () =>
    enqueueSectionRequest(async () => {
      const cached = await getCached<SectionRecall>(cacheKey);
      if (cached && isSectionRecallHealthy(cached)) {
        console.log(`[generateSectionRecall] Cache hit for "${sectionTitle}"`);
        return cached;
      }
      if (cached) {
        console.warn(`[generateSectionRecall] Unhealthy cache for "${sectionTitle}" — evicting`);
        await deleteCache(cacheKey);
      }

      console.log(`Generating recall for "${sectionTitle}"…`);

      try {
        const sectionContent = extractSectionContent(truncatedText, sectionTitle, allSections);
        console.log(`[extractSection] ${sectionContent.length} chars for "${sectionTitle}"`);

        if (sectionContent.length < 50) {
          console.warn(`[generateSectionRecall] Content too short — skipping API call`);
          return createEmptySectionRecall(sectionTitle);
        }

        const rawResponse   = await callGeminiWithRetry<any>(
          apiKey,
          buildSectionRecallRequest(sectionTitle, sectionContent)
        );
        const sectionRecall = unwrapSectionRecall(rawResponse, sectionTitle);
        const itemCount     = countSectionRecallItems(sectionRecall);
        const healthy       = isSectionRecallHealthy(sectionRecall);

        console.log(`[sectionRecall] "${sectionTitle}": ${itemCount} items — ${healthy ? 'HEALTHY' : 'UNHEALTHY'}`);

        if (healthy) await setCache(cacheKey, sectionRecall);
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
      const { isHealthy } = validateCachedQuiz(cached, safeNum);
      if (isHealthy) { console.log('[generateQuiz] Cache hit (healthy)'); return cached; }
      console.warn('[generateQuiz] Unhealthy cache — evicting');
      await deleteCache(cacheKey);
    }

    const response = await callGeminiWithRetry<QuizResponse>(
      apiKey,
      buildQuizRequest(truncatedText, questionType, safeNum)
    );

    const { questions, isHealthy } = validateAndRepairQuiz(response.questions || [], safeNum);

    if (isHealthy) {
      await setCache(cacheKey, questions);
      console.log(`[generateQuiz] Cached ${questions.length} questions`);
    } else {
      console.warn(`[generateQuiz] NOT caching — ${questions.length}/${safeNum} reliable`);
    }

    return questions;
  });
}

// ============ HELPERS ============

function createEmptyBigPictureRecall(): BigPictureRecall {
  return {
    mainIdeas: [], coreThemes: [], purposeAndStructure: [],
    sectionRelationships: [], summaryQuestions: []
  };
}

function createEmptySectionRecall(sectionTitle: string): SectionRecall {
  return {
    sectionTitle,
    sectionSummary:   'Unable to generate recall for this section.',
    concepts: [], definitions: [], processes: [], examples: [],
    comparisons: [], applications: [], criticalThinking: []
  };
}