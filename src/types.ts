export type Page = 'home' | 'recall' | 'quiz';

export interface FlashCard {
  question: string;
  answer: string;
  difficulty?: 'basic' | 'intermediate' | 'advanced';
}

export interface KeyConcept {
  term: string;
  explanation: string;
}

// Big Picture Recall types
export interface BigPictureRecall {
  mainIdeas: FlashCard[];
  coreThemes: FlashCard[];
  purposeAndStructure: FlashCard[];
  sectionRelationships: FlashCard[];
  summaryQuestions: FlashCard[];
}

// Section-by-section recall types
export interface SectionRecall {
  sectionTitle: string;
  sectionSummary: string;
  concepts: KeyConcept[];
  definitions: FlashCard[];
  processes: FlashCard[];
  examples: FlashCard[];
  comparisons: FlashCard[];
  applications: FlashCard[];
  criticalThinking: FlashCard[];
}

// Simplified Summary types (Feynman technique)
export interface SimplifiedSection {
  heading: string;
  simpleExplanation: string;
  keyPoints: string[];
  analogy?: string;
  commonMisconceptions?: string[];
  realWorldExample?: string;
}

export interface SimplifiedSummary {
  title: string;
  oneLinerSummary: string;
  whyItMatters: string;
  coreIdea: string;
  sections: SimplifiedSection[];
  keyTakeaways: string[];
  quickRecap: string;
  glossary: KeyConcept[];
}

// Enhanced Recall Result
export interface RecallResult {
  documentOverview: string;
  documentStructure: string[];
  simplifiedSummary: SimplifiedSummary;
  bigPictureRecall: BigPictureRecall;
  sectionRecalls: SectionRecall[];
  crossSectionConnections: FlashCard[];
  finalReviewQuestions: FlashCard[];
  totalCoverage: {
    sectionsIdentified: number;
    questionsGenerated: number;
    conceptsCovered: number;
  };
}

export type QuizQuestionType = 'mcq' | 'true-false' | 'short-answer' | 'mixed';

export interface QuizQuestion {
  id: number;
  type: 'mcq' | 'true-false' | 'short-answer';
  question: string;
  options?: string[];
  correctAnswer: string;
  explanation: string;
  section?: string;
}

export interface QuizState {
  questions: QuizQuestion[];
  currentIndex: number;
  answers: Record<number, string>;
  revealed: Record<number, boolean>;
  score: { correct: number; incorrect: number };
}

export interface ProgressStep {
  label: string;
  status: 'pending' | 'active' | 'completed';
}
