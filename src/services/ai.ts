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

const CACHE_VERSION = 'v1';

/**
 * Normalizes text for cache key generation.
 *
 * CRITICAL — must produce identical output regardless of:
 *  - Local dev vs Cloudflare edge (different V8 builds)
 *  - OS-level line ending differences (\r\n vs \n)
 *  - Unicode whitespace variants injected by PDF parsers, OCR, or
 *    edge request body normalization
 *
 * Steps:
 *  1. Strip ALL Unicode whitespace variants to a single ASCII space
 *     (covers \u00A0 NBSP, \u2000–\u200A typographic spaces,
 *      \u2028 line sep, \u2029 paragraph sep, \u202F narrow NBSP,
 *      \u205F medium math space, \u3000 ideographic space, \uFEFF BOM)
 *  2. Collapse consecutive spaces
 *  3. Lowercase
 *  4. Trim
 */
function normalizeTextForHashing(text: string): string {
  return text
    // Replace ALL Unicode whitespace with ASCII space
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
        next === ':' ||
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

/**
 * Peeks ahead past whitespace to find the next meaningful character.
 *
 * Safety: bounded by maxLookahead to prevent runaway scans on
 * truncated text where a quote lands at the very edge of the buffer.
 * Returns '' if nothing found within the window — callers treat
 * '' as "end of input / closing quote" which is the safe default.
 */
function peekNextNonWhitespace(
  text: string,
  fromIndex: number,
  maxLookahead: number = 64
): string {
  const limit = Math.min(fromIndex + maxLookahead, text.length);
  for (let j = fromIndex; j < limit; j++) {
    if (!/\s/.test(text[j])) return text[j];
  }
  return '';
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,(\s*[}\]])/g, '$1');
}

/**
 * Extracts balanced JSON from opening bracket to its matched closer.
 *
 * Safety: bounded by MAX_SCAN_LENGTH to prevent infinite loops on
 * pathologically malformed input. If the text is longer than the
 * limit, we scan up to the limit and return null (triggering
 * truncation repair downstream).
 */
function extractBalanced(
  text: string,
  startIdx: number,
  openChar: string,
  closeChar: string
): string | null {
  const MAX_SCAN_LENGTH = 500_000; // 500KB — well above any realistic response
  let depth = 0;
  let insideString = false;
  let i = startIdx;
  const end = Math.min(text.length, startIdx + MAX_SCAN_LENGTH);

  while (i < end) {
    const char = text[i];
    if (char === '\\' && insideString) {
      // Safety: if escape char is at the very last position, break
      if (i + 1 >= end) break;
      i += 2;
      continue;
    }
    if (char === '"') { insideString = !insideString; i++; continue; }
    if (!insideString) {
      if (char === openChar)  depth++;
      if (char === closeChar) depth--;
      if (depth === 0) return text.slice(startIdx, i + 1);
    }
    i++;
  }

  return null; // unbalanced or exceeded scan limit — triggers truncation repair
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

/**
 * Sequential cascading JSON repair pipeline.
 *
 * Each stage feeds its output into the next, so a response with
 * multiple issues (raw newlines + trailing commas + rogue quotes)
 * gets all fixes applied cumulatively.
 *
 * We try JSON.parse after EVERY stage so clean responses exit early.
 * An alt pipeline (truncation-first) runs as a final fallback for
 * responses truncated mid-string.
 */
function safeParseJSON<T>(text: string): T {
  const stages: Array<{
    name: string;
    transform: (input: string) => string;
  }> = [
    { name: 'raw',                      transform: (s) => s                           },
    { name: 'strip-rogue-chars',        transform: (s) => stripRogueCharacters(s)     },
    { name: '+ normalize-whitespace',   transform: (s) => normalizeLiteralWhitespace(s) },
    { name: '+ remove-trailing-commas', transform: (s) => removeTrailingCommas(s)     },
    { name: '+ fix-unescaped-quotes',   transform: (s) => fixUnescapedQuotes(s)       },
    { name: '+ truncation-repair',      transform: (s) => attemptTruncationRepair(s)  },
  ];

  const errors: string[] = [];
  let current = text;

  for (const stage of stages) {
    current = stage.transform(current);

    try {
      const parsed = JSON.parse(current);
      if (stage.name !== 'raw') {
        console.warn(`[safeParseJSON] Recovered at stage: "${stage.name}"`);
      }
      return parsed as T;
    } catch (err: any) {
      errors.push(`  • [${stage.name}]: ${err.message}`);
    }
  }

  // Alt pipeline: truncation repair BEFORE quote fixing
  try {
    const alt = fixUnescapedQuotes(
      removeTrailingCommas(
        attemptTruncationRepair(
          normalizeLiteralWhitespace(
            stripRogueCharacters(text)
          )
        )
      )
    );
    const parsed = JSON.parse(alt);
    console.warn('[safeParseJSON] Recovered with alt pipeline (truncation-first)');
    return parsed as T;
  } catch (err: any) {
    errors.push(`  • [alt-truncation-first]: ${err.message}`);
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

// ── QUIZ SCHEMAS: ONE UNIFIED SCHEMA FOR ALL TYPES ──
//
// The previous approach used anyOf for mixed quizzes, which caused
// Gemini to silently drop the options field on MCQ questions. The
// result: validateAndRepairQuiz would filter them out, and users
// got fewer questions than they asked for.
//
// NEW APPROACH: One single schema with options ALWAYS required.
// The prompt controls which types are generated.
// validateAndRepairQuiz handles cleanup (e.g. stripping dummy
// options from short-answer, normalizing true-false options).

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
  // options IS required in the schema — Gemini will ALWAYS return it.
  // For short-answer, the prompt says to use an empty array [].
  // validateAndRepairQuiz strips it post-parse.
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

const MERGED_SYSTEM_INSTRUCTION = `You are an expert educational content designer.

SUMMARY (Feynman technique): Explain as if teaching a 12-year-old. Use simple language, analogies, examples. Keep every field to 1-2 sentences max.

RECALL QUESTIONS: Cover main ideas, themes, structure. Each question needs difficulty ("basic"/"intermediate"/"advanced"). Answers: 1 sentence.

CRITICAL: Be extremely concise. Valid JSON only.`;

const SECTION_RECALL_SYSTEM_INSTRUCTION = `You are an active recall expert. Create focused recall questions for one section. Each needs difficulty ("basic"/"intermediate"/"advanced"). Answers: 1 sentence. Skip empty categories. Valid JSON only.`;

const QUIZ_SYSTEM_INSTRUCTION = `You are a quiz generator. STRICT RULES:
- "mcq": "options" must have EXACTLY 4 strings. correctAnswer must match one option exactly.
- "true-false": "options" must be ["True", "False"]. correctAnswer must be "True" or "False".
- "short-answer": "options" must be an empty array []. correctAnswer is 1-3 words.
- EVERY question MUST have the "options" field (array).
- Explanations: 1 sentence max.
Valid JSON only.`;

// ============ INPUT BUDGET CONSTANTS ============

const INPUT_LIMITS = {
  merged:  10000,
  section: 2000,
  quiz:    8000,
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
  const safeNum = Math.min(Math.max(numQuestions, 1), 10);

  const typeInstructions: Record<string, string> = {
    mcq:            `All ${safeNum} questions MUST be "mcq". Each MUST have "options" with EXACTLY 4 strings. correctAnswer must match one option exactly.`,
    'true-false':   `All ${safeNum} questions MUST be "true-false". Each MUST have "options": ["True", "False"]. correctAnswer must be "True" or "False".`,
    'short-answer': `All ${safeNum} questions MUST be "short-answer". Each MUST have "options": [] (empty array). correctAnswer is 1-3 words.`,
    mixed:          `Mix of "mcq", "true-false", and "short-answer". EVERY question MUST have the "options" field. MCQ: exactly 4 option strings. True-false: ["True", "False"]. Short-answer: [] (empty array).`
  };

  return {
    systemInstruction: {
      parts: [{ text: QUIZ_SYSTEM_INSTRUCTION }]
    },
    contents: [{
      parts: [{
        text: `Create exactly ${safeNum} questions.

${typeInstructions[questionType] || typeInstructions.mixed}

IMPORTANT: Every question object MUST include the "options" field.
Explanations: 1 sentence max.

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

// ============ QUIZ POST-PROCESSING ============

/**
 * Validates, repairs, and backfills quiz questions after parsing.
 *
 * DESIGN PRINCIPLE: Never silently drop questions. Repair first,
 * filter only as an absolute last resort (missing question text
 * or correctAnswer entirely). Logs every repair for debugging.
 *
 * @param questions - Raw parsed questions from Gemini
 * @param requestedCount - How many the user asked for (used to log shortfall)
 * @returns Repaired and validated questions
 */
function validateAndRepairQuiz(
  questions: QuizQuestion[],
  requestedCount: number
): QuizQuestion[] {
  const repaired = questions.map((q, i) => {
    const fixed = { ...q, id: i };

    // ── Normalize type field ──
    if (!fixed.type || !['mcq', 'true-false', 'short-answer'].includes(fixed.type)) {
      // Infer type from structure
      if (Array.isArray(fixed.options) && fixed.options.length === 4) {
        fixed.type = 'mcq' as any;
      } else if (
        Array.isArray(fixed.options) &&
        fixed.options.length === 2 &&
        fixed.options.some(o => o.toLowerCase() === 'true')
      ) {
        fixed.type = 'true-false' as any;
      } else {
        fixed.type = 'short-answer' as any;
      }
      console.warn(`[quiz-repair] Q${i}: inferred type "${fixed.type}" from structure`);
    }

    // ── MCQ repairs ──
    if (fixed.type === 'mcq') {
      if (!Array.isArray(fixed.options)) {
        fixed.options = [];
        console.warn(`[quiz-repair] Q${i}: MCQ missing options — created empty array`);
      }

      // Ensure correctAnswer is in options
      if (fixed.options.length > 0 && fixed.correctAnswer && !fixed.options.includes(fixed.correctAnswer)) {
        // Try case-insensitive match first
        const caseMatch = fixed.options.findIndex(
          o => o.toLowerCase().trim() === fixed.correctAnswer.toLowerCase().trim()
        );
        if (caseMatch !== -1) {
          fixed.correctAnswer = fixed.options[caseMatch];
          console.warn(`[quiz-repair] Q${i}: corrected answer case to match option`);
        } else {
          fixed.options[fixed.options.length - 1] = fixed.correctAnswer;
          console.warn(`[quiz-repair] Q${i}: replaced last option with correctAnswer`);
        }
      }

      // Pad to 4 options
      while (fixed.options.length < 4) {
        fixed.options.push(`Option ${String.fromCharCode(65 + fixed.options.length)}`);
        console.warn(`[quiz-repair] Q${i}: padded to ${fixed.options.length} options`);
      }

      // Trim to 4 options (keep correctAnswer)
      if (fixed.options.length > 4) {
        const correctIdx = fixed.options.indexOf(fixed.correctAnswer);
        const kept = fixed.options.slice(0, 4);
        if (correctIdx >= 4) {
          kept[3] = fixed.correctAnswer;
        }
        fixed.options = kept;
      }

      // Final safety: correctAnswer must be in the final options array
      if (!fixed.options.includes(fixed.correctAnswer)) {
        fixed.options[3] = fixed.correctAnswer;
      }
    }

    // ── True/False repairs ──
    if (fixed.type === 'true-false') {
      fixed.options = ['True', 'False'];
      const lower = (fixed.correctAnswer || '').toLowerCase().trim();
      fixed.correctAnswer = lower === 'true' || lower === 't' ? 'True' : 'False';
    }

    // ── Short-answer repairs ──
    if (fixed.type === 'short-answer') {
      // Strip any stray options Gemini included
      fixed.options = [] as any;
    }

    // ── Ensure explanation exists ──
    if (!fixed.explanation) {
      fixed.explanation = 'No explanation provided.';
    }

    return fixed;
  });

  // ── Only filter questions missing absolutely critical fields ──
  const valid = repaired.filter(q => {
    if (!q.question?.trim()) {
      console.warn(`[quiz-repair] Dropping Q${q.id}: no question text`);
      return false;
    }
    if (!q.correctAnswer?.trim()) {
      console.warn(`[quiz-repair] Dropping Q${q.id}: no correctAnswer`);
      return false;
    }
    return true;
  });

  // Re-index after any drops
  valid.forEach((q, i) => { q.id = i; });

  // Log shortfall for debugging (but never throw)
  if (valid.length < requestedCount) {
    console.warn(
      `[quiz-repair] Requested ${requestedCount} questions, ` +
      `got ${valid.length} after validation`
    );
  }

  return valid;
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

    const questions = validateAndRepairQuiz(response.questions || [], safeNum);

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