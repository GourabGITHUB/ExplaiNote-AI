import type { 
  RecallResult, 
  QuizQuestion, 
  QuizQuestionType, 
  SimplifiedSummary, 
  BigPictureRecall, 
  SectionRecall, 
  FlashCard
} from '../types';

// Gemini 2.5 Flash
const GEMINI_API_URL = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent';

// ============ RETRY & ERROR HANDLING ============

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

// ============ UPDATED RETRY & ERROR HANDLING ============

async function callGeminiWithRetry<T>(
  userApiKey: string, // Changed from general apiKey to explicit userApiKey
  requestBody: object,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): Promise<T> {
  let lastError: Error | null = null;
  
  const trimmedUserKey = userApiKey.trim();
  
  // Decide target URL: Use direct Google URL if user provided a key, otherwise use our proxy
  const targetUrl = trimmedUserKey 
    ? `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${trimmedUserKey}`
    : `/api/proxy`;

  for (let attempt = 0; attempt <= config.maxRetries; attempt++) {
    try {
      const response = await fetch(targetUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json',
        'X-App-Client': 'ExplaiNote-SPA-Client' }, //custom identifier
        body: JSON.stringify(requestBody), // The proxy receives this exact format
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        const errMessage = errData?.error?.message || `API error: ${response.status}`;
        
        if (isRetryableError(response.status) && attempt < config.maxRetries) {
          const delay = Math.min(
            config.baseDelayMs * Math.pow(2, attempt) + Math.random() * 500,
            config.maxDelayMs
          );
          console.log(`Rate limited (${response.status}). Retrying... (attempt ${attempt + 1}/${config.maxRetries})`);
          await sleep(delay);
          continue;
        }
        
        throw new Error(errMessage);
      }

      const data = await response.json();
      const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
      
      if (!text) {
        throw new Error('No response content from AI');
      }

      const jsonStr = extractJSON(text);
      return JSON.parse(jsonStr) as T;
      
    } catch (err: any) {
      lastError = err;
      
      if (attempt < config.maxRetries && (err.name === 'TypeError' || err.message.includes('JSON'))) {
        const delay = config.baseDelayMs * Math.pow(2, attempt);
        await sleep(delay);
        continue;
      }
      
      throw err;
    }
  }

  throw lastError || new Error('Max retries exceeded');
}

function extractJSON(text: string): string {
  const codeBlockMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (codeBlockMatch) return codeBlockMatch[1].trim();

  const jsonMatch = text.match(/[\[{][\s\S]*[\]}]/);
  if (jsonMatch) return jsonMatch[0];

  return text;
}

// ============ SCHEMA DEFINITIONS ============

// Difficulty is now REQUIRED to prevent TypeScript issues
const flashCardSchema = {
  type: "OBJECT",
  properties: {
    question: { type: "STRING" },
    answer: { type: "STRING" },
    difficulty: { type: "STRING", enum: ["basic", "intermediate", "advanced"] }
  },
  required: ["question", "answer", "difficulty"]
};

const keyConceptSchema = {
  type: "OBJECT",
  properties: {
    term: { type: "STRING" },
    explanation: { type: "STRING" }
  },
  required: ["term", "explanation"]
};

const simplifiedSectionSchema = {
  type: "OBJECT",
  properties: {
    heading: { type: "STRING" },
    simpleExplanation: { type: "STRING" },
    keyPoints: { type: "ARRAY", items: { type: "STRING" } },
    analogy: { type: "STRING" },
    commonMisconceptions: { type: "ARRAY", items: { type: "STRING" } },
    realWorldExample: { type: "STRING" }
  },
  required: ["heading", "simpleExplanation", "keyPoints"]
};

// Schema for Call 1: Simplified Summary
const simplifiedSummaryResponseSchema = {
  type: "OBJECT",
  properties: {
    documentOverview: { type: "STRING" },
    documentStructure: { type: "ARRAY", items: { type: "STRING" } },
    simplifiedSummary: {
      type: "OBJECT",
      properties: {
        title: { type: "STRING" },
        oneLinerSummary: { type: "STRING" },
        whyItMatters: { type: "STRING" },
        coreIdea: { type: "STRING" },
        sections: { type: "ARRAY", items: simplifiedSectionSchema },
        keyTakeaways: { type: "ARRAY", items: { type: "STRING" } },
        quickRecap: { type: "STRING" },
        glossary: { type: "ARRAY", items: keyConceptSchema }
      },
      required: ["title", "oneLinerSummary", "whyItMatters", "coreIdea", "sections", "keyTakeaways", "quickRecap"]
    }
  },
  required: ["documentOverview", "documentStructure", "simplifiedSummary"]
};

// Schema for Big Picture Recall (separate call)
const bigPictureRecallSchema = {
  type: "OBJECT",
  properties: {
    mainIdeas: { type: "ARRAY", items: flashCardSchema },
    coreThemes: { type: "ARRAY", items: flashCardSchema },
    purposeAndStructure: { type: "ARRAY", items: flashCardSchema },
    sectionRelationships: { type: "ARRAY", items: flashCardSchema },
    summaryQuestions: { type: "ARRAY", items: flashCardSchema }
  },
  required: ["mainIdeas", "coreThemes", "purposeAndStructure"]
};

const bigPictureResponseSchema = {
  type: "OBJECT",
  properties: {
    bigPictureRecall: bigPictureRecallSchema,
    crossSectionConnections: { type: "ARRAY", items: flashCardSchema },
    finalReviewQuestions: { type: "ARRAY", items: flashCardSchema }
  },
  required: ["bigPictureRecall"]
};

// Schema for Single Section Recall (per-section call)
const singleSectionRecallSchema = {
  type: "OBJECT",
  properties: {
    sectionTitle: { type: "STRING" },
    sectionSummary: { type: "STRING" },
    concepts: { type: "ARRAY", items: keyConceptSchema },
    definitions: { type: "ARRAY", items: flashCardSchema },
    processes: { type: "ARRAY", items: flashCardSchema },
    examples: { type: "ARRAY", items: flashCardSchema },
    comparisons: { type: "ARRAY", items: flashCardSchema },
    applications: { type: "ARRAY", items: flashCardSchema },
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

// Quiz schema
const quizQuestionSchema = {
  type: "OBJECT",
  properties: {
    id: { type: "INTEGER" },
    type: { type: "STRING", enum: ["mcq", "true-false", "short-answer"] },
    question: { type: "STRING" },
    options: { type: "ARRAY", items: { type: "STRING" } },
    correctAnswer: { type: "STRING" },
    explanation: { type: "STRING" },
    section: { type: "STRING" }
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

const FEYNMAN_SYSTEM_INSTRUCTION = `You are an expert educational content designer specializing in the Feynman technique.

CORE PRINCIPLES:
- Explain complex concepts as if teaching a 12-year-old
- Use simple, everyday language — avoid jargon
- Include relatable analogies and real-world examples
- Break down information into clear, logical sections
- Highlight what's truly important

WRITING STYLE:
- Use phrases like "Think of it like...", "Imagine..."
- Replace jargon: "utilize" → "use"
- Use concrete examples everyone can relate to
- Always explain WHY something matters

OUTPUT: Respond with valid JSON matching the schema exactly. Keep responses concise.`;

const ACTIVE_RECALL_SYSTEM_INSTRUCTION = `You are an expert in creating active recall study materials.

CORE PRINCIPLES:
- Create layered questions: basic, intermediate, advanced
- Cover definitions, processes, examples, comparisons, applications
- Questions should test understanding, not just memorization
- Keep answers concise but complete

DIFFICULTY LEVELS (always specify one):
- "basic": Direct recall of facts and definitions
- "intermediate": Understanding relationships and processes  
- "advanced": Application and critical thinking

OUTPUT: Respond with valid JSON matching the schema exactly. Be concise.`;

const QUIZ_SYSTEM_INSTRUCTION = `You are an expert quiz generator for educational content.

RULES:
- For "mcq": exactly 4 options, correctAnswer matches one option exactly
- For "true-false": options are ["True", "False"]
- For "short-answer": no options, correctAnswer is 1-3 words
- Progress from foundational to advanced concepts
- Explanations should be educational

OUTPUT: Respond with valid JSON matching the schema exactly.`;

// ============ REQUEST BUILDERS ============

interface SimplifiedSummaryResponse {
  documentOverview: string;
  documentStructure: string[];
  simplifiedSummary: SimplifiedSummary;
}

interface BigPictureResponse {
  bigPictureRecall: BigPictureRecall;
  crossSectionConnections?: FlashCard[];
  finalReviewQuestions?: FlashCard[];
}

interface SectionRecallResponse {
  sectionRecall: SectionRecall;
}

interface QuizResponse {
  questions: QuizQuestion[];
}

function buildSimplifiedSummaryRequest(text: string) {
  return {
    systemInstruction: {
      parts: [{ text: FEYNMAN_SYSTEM_INSTRUCTION }]
    },
    contents: [{
      parts: [{
        text: `Analyze this content and create a simplified summary using the Feynman technique.

REQUIREMENTS:
- Identify the main sections/topics in the document (list them in documentStructure)
- Create a clear title and one-liner summary
- Explain why this topic matters
- For each section: simple explanation, 3 key points, an analogy, real-world example
- Include 3-5 key takeaways and a quick recap
- Create a glossary of technical terms (maximum 8 terms)

Keep the simplified summary sections to a MAXIMUM of 5 sections.

CONTENT:
"""
${text}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 3500,
      responseMimeType: "application/json",
      responseSchema: simplifiedSummaryResponseSchema
    }
  };
}

function buildBigPictureRecallRequest(text: string, documentStructure: string[]) {
  const structureList = documentStructure.slice(0, 5).join(', ');
  
  return {
    systemInstruction: {
      parts: [{ text: ACTIVE_RECALL_SYSTEM_INSTRUCTION }]
    },
    contents: [{
      parts: [{
        text: `Create big-picture recall questions for this content.

Document sections: ${structureList}

REQUIREMENTS (strict limits):
- mainIdeas: 2 questions about the central thesis
- coreThemes: 2 questions about recurring themes
- purposeAndStructure: 1-2 questions about the author's purpose
- sectionRelationships: 2 questions linking different sections
- summaryQuestions: 1 comprehensive question
- crossSectionConnections: 2 questions connecting concepts across sections
- finalReviewQuestions: 2 comprehensive review questions

TOTAL: Maximum 14 questions. Each must have difficulty: "basic", "intermediate", or "advanced".

CONTENT SUMMARY:
"""
${text.substring(0, 8000)}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2500,
      responseMimeType: "application/json",
      responseSchema: bigPictureResponseSchema
    }
  };
}

function buildSectionRecallRequest(sectionTitle: string, sectionContent: string) {
  return {
    systemInstruction: {
      parts: [{ text: ACTIVE_RECALL_SYSTEM_INSTRUCTION }]
    },
    contents: [{
      parts: [{
        text: `Create recall questions for this specific section.

SECTION: "${sectionTitle}"

REQUIREMENTS (strict limits - generate ONLY what's relevant):
- sectionSummary: 1-2 sentence summary
- concepts: Maximum 2 key concepts with explanations
- definitions: Maximum 2 definition questions (basic difficulty)
- processes: Maximum 1 process question if applicable (intermediate)
- examples: Maximum 1 example question if applicable (basic/intermediate)
- comparisons: Maximum 1 comparison if applicable (intermediate)
- applications: Maximum 1 application question (advanced)
- criticalThinking: Maximum 1 critical thinking question (advanced)

TOTAL: Maximum 10 questions per section. Each must have difficulty field.
Skip categories that don't apply to this section.

SECTION CONTENT:
"""
${sectionContent.substring(0, 4000)}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 1800,
      responseMimeType: "application/json",
      responseSchema: sectionRecallResponseSchema
    }
  };
}

function buildQuizRequest(text: string, questionType: QuizQuestionType, numQuestions: number) {
  const typeInstruction = questionType === 'mixed'
    ? 'Use a mix of "mcq", "true-false", and "short-answer" types'
    : `Use only "${questionType}" type questions`;

  // Cap at reasonable limit
  const safeNumQuestions = Math.min(numQuestions, 15);

  return {
    systemInstruction: {
      parts: [{ text: QUIZ_SYSTEM_INSTRUCTION }]
    },
    contents: [{
      parts: [{
        text: `Create a quiz with exactly ${safeNumQuestions} questions.

${typeInstruction}

Cover the material from foundational to advanced concepts.
Each question tests a different aspect.

CONTENT:
"""
${text.substring(0, 20000)}
"""`
      }]
    }],
    generationConfig: {
      temperature: 0.7,
      maxOutputTokens: 2500,
      responseMimeType: "application/json",
      responseSchema: quizResponseSchema
    }
  };
}

// ============ SECTION CONTENT EXTRACTION ============

function extractSectionContent(fullText: string, sectionTitle: string, allSections: string[]): string {
  const lowerText = fullText.toLowerCase();
  const lowerTitle = sectionTitle.toLowerCase();
  
  // Try to find the section in the text
  let startIndex = lowerText.indexOf(lowerTitle);
  if (startIndex === -1) {
    // Try partial match
    const words = lowerTitle.split(' ').filter(w => w.length > 3);
    for (const word of words) {
      const idx = lowerText.indexOf(word);
      if (idx !== -1) {
        startIndex = idx;
        break;
      }
    }
  }
  
  if (startIndex === -1) {
    // Return a chunk of the full text as fallback
    const sectionIndex = allSections.indexOf(sectionTitle);
    const chunkSize = Math.floor(fullText.length / Math.max(allSections.length, 1));
    return fullText.substring(sectionIndex * chunkSize, (sectionIndex + 1) * chunkSize + 500);
  }

  // Find the next section start or end of document
  let endIndex = fullText.length;
  const currentSectionIndex = allSections.indexOf(sectionTitle);
  
  for (let i = currentSectionIndex + 1; i < allSections.length; i++) {
    const nextSection = allSections[i].toLowerCase();
    const nextIdx = lowerText.indexOf(nextSection, startIndex + lowerTitle.length);
    if (nextIdx !== -1 && nextIdx < endIndex) {
      endIndex = nextIdx;
      break;
    }
  }

  return fullText.substring(startIndex, Math.min(endIndex, startIndex + 5000));
}

// ============ MAIN EXPORT FUNCTIONS ============

export async function generateRecallContent(apiKey: string, text: string): Promise<RecallResult> {
  // Truncate text if too long
  const maxChars = 40000;
  const truncatedText = text.length > maxChars 
    ? text.substring(0, maxChars) + '\n\n[Content truncated...]'
    : text;

  // === CALL 1: Generate simplified summary ===
  console.log('Call 1: Generating simplified summary...');
  let summaryResponse: SimplifiedSummaryResponse;
  
  try {
    summaryResponse = await callGeminiWithRetry<SimplifiedSummaryResponse>(
      apiKey,
      buildSimplifiedSummaryRequest(truncatedText)
    );
  } catch (err: any) {
    console.error('Call 1 failed:', err.message);
    throw new Error(`Failed to generate summary: ${err.message}`);
  }

  const documentStructure = summaryResponse.documentStructure || [];
  const sectionsToProcess = documentStructure.slice(0, 4); // Limit to 4 sections max

  // === CALL 2: Generate big picture recall ===
  console.log('Call 2: Generating big picture recall...');
  let bigPictureResponse: BigPictureResponse;
  
  try {
    bigPictureResponse = await callGeminiWithRetry<BigPictureResponse>(
      apiKey,
      buildBigPictureRecallRequest(truncatedText, sectionsToProcess)
    );
  } catch (err: any) {
    console.error('Call 2 failed:', err.message);
    // Return partial result with just summary
    return createPartialResult(summaryResponse);
  }

  // === CALLS 3+: Generate section-by-section recall ===
  const sectionRecalls: SectionRecall[] = [];
  
  for (let i = 0; i < sectionsToProcess.length; i++) {
    const sectionTitle = sectionsToProcess[i];
    console.log(`Call ${3 + i}: Generating recall for section "${sectionTitle}"...`);
    
    // Add delay between section calls to avoid rate limiting
    if (i > 0) {
      await sleep(1000);
    }
    
    try {
      const sectionContent = extractSectionContent(truncatedText, sectionTitle, sectionsToProcess);
      const sectionResponse = await callGeminiWithRetry<SectionRecallResponse>(
        apiKey,
        buildSectionRecallRequest(sectionTitle, sectionContent)
      );
      
      if (sectionResponse.sectionRecall) {
        sectionRecalls.push(sectionResponse.sectionRecall);
      }
    } catch (err: any) {
      console.warn(`Section "${sectionTitle}" failed:`, err.message);
      // Continue with other sections even if one fails
      sectionRecalls.push({
        sectionTitle,
        sectionSummary: 'Unable to generate recall for this section.',
        concepts: [],
        definitions: [],
        processes: [],
        examples: [],
        comparisons: [],
        applications: [],
        criticalThinking: []
      });
    }
  }

  // === Combine all results ===
  const result: RecallResult = {
    documentOverview: summaryResponse.documentOverview,
    documentStructure: documentStructure,
    simplifiedSummary: summaryResponse.simplifiedSummary,
    bigPictureRecall: bigPictureResponse.bigPictureRecall || createEmptyBigPictureRecall(),
    sectionRecalls: sectionRecalls,
    crossSectionConnections: bigPictureResponse.crossSectionConnections || [],
    finalReviewQuestions: bigPictureResponse.finalReviewQuestions || [],
    totalCoverage: calculateCoverage(sectionRecalls, bigPictureResponse, summaryResponse.simplifiedSummary)
  };

  return result;
}

export async function generateQuiz(
  apiKey: string,
  text: string,
  questionType: QuizQuestionType,
  numQuestions: number = 10
): Promise<QuizQuestion[]> {
  const maxChars = 40000;
  const truncatedText = text.length > maxChars 
    ? text.substring(0, maxChars) + '\n\n[Content truncated...]'
    : text;

  const response = await callGeminiWithRetry<QuizResponse>(
    apiKey,
    buildQuizRequest(truncatedText, questionType, numQuestions)
  );

  return (response.questions || []).map((q, i) => ({ ...q, id: i }));
}

// ============ HELPER FUNCTIONS ============

function createEmptyBigPictureRecall(): BigPictureRecall {
  return {
    mainIdeas: [],
    coreThemes: [],
    purposeAndStructure: [],
    sectionRelationships: [],
    summaryQuestions: []
  };
}

function createPartialResult(summaryResponse: SimplifiedSummaryResponse): RecallResult {
  return {
    documentOverview: summaryResponse.documentOverview,
    documentStructure: summaryResponse.documentStructure || [],
    simplifiedSummary: summaryResponse.simplifiedSummary,
    bigPictureRecall: createEmptyBigPictureRecall(),
    sectionRecalls: [],
    crossSectionConnections: [],
    finalReviewQuestions: [],
    totalCoverage: {
      sectionsIdentified: summaryResponse.simplifiedSummary?.sections?.length || 0,
      questionsGenerated: 0,
      conceptsCovered: summaryResponse.simplifiedSummary?.glossary?.length || 0
    }
  };
}

function calculateCoverage(
  sectionRecalls: SectionRecall[],
  bigPictureResponse: BigPictureResponse,
  summary: SimplifiedSummary
): { sectionsIdentified: number; questionsGenerated: number; conceptsCovered: number } {
  let totalQuestions = 0;
  let totalConcepts = 0;

  // Count big picture questions
  const bp = bigPictureResponse.bigPictureRecall;
  if (bp) {
    totalQuestions += (bp.mainIdeas?.length || 0);
    totalQuestions += (bp.coreThemes?.length || 0);
    totalQuestions += (bp.purposeAndStructure?.length || 0);
    totalQuestions += (bp.sectionRelationships?.length || 0);
    totalQuestions += (bp.summaryQuestions?.length || 0);
  }

  // Count section questions
  for (const section of sectionRecalls) {
    totalConcepts += (section.concepts?.length || 0);
    totalQuestions += (section.definitions?.length || 0);
    totalQuestions += (section.processes?.length || 0);
    totalQuestions += (section.examples?.length || 0);
    totalQuestions += (section.comparisons?.length || 0);
    totalQuestions += (section.applications?.length || 0);
    totalQuestions += (section.criticalThinking?.length || 0);
  }

  // Add cross-section and final questions
  totalQuestions += (bigPictureResponse.crossSectionConnections?.length || 0);
  totalQuestions += (bigPictureResponse.finalReviewQuestions?.length || 0);

  // Add glossary terms
  if (summary?.glossary) {
    totalConcepts += summary.glossary.length;
  }

  return {
    sectionsIdentified: sectionRecalls.length,
    questionsGenerated: totalQuestions,
    conceptsCovered: totalConcepts
  };
}
