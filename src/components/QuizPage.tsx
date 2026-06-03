import { useState, useRef, useCallback, useEffect } from 'react';
import ApiKeyInput from './ApiKeyInput';
import { generateQuiz } from '../services/ai';
import { parseFile, formatFileSize } from '../services/fileParser';
import { createProjectFromFile, updateProjectStatus, updateProjectParsedText, getFileFromProject, type Project } from '../services/db';
import { resolveApiKey } from '../services/apiKey';
import type { QuizQuestion, QuizQuestionType, QuizState, ProgressStep } from '../types';

interface QuizPageProps {
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onProjectUpdate?: () => void;
  activeProject?: Project | null;
  onClearProject?: () => void;
}

const questionTypes: { value: QuizQuestionType; label: string; icon: string }[] = [
  { value: 'mixed', label: 'Mixed', icon: '🎲' },
  { value: 'mcq', label: 'Multiple Choice', icon: '🔘' },
  { value: 'true-false', label: 'True / False', icon: '✅' },
  { value: 'short-answer', label: 'Short Answer', icon: '✏️' },
];

const numOptions = [5, 10, 15, 20];

// ============ TIMER HOOK ============
function useTimer() {
  const [seconds, setSeconds] = useState(0);
  const [running, setRunning] = useState(false);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (running) {
      intervalRef.current = setInterval(() => {
        setSeconds(s => s + 1);
      }, 1000);
    }
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [running]);

  const start = () => { setSeconds(0); setRunning(true); };
  const stop = () => { setRunning(false); };
  const reset = () => { setSeconds(0); setRunning(false); };

  return { seconds, running, start, stop, reset };
}

function formatTime(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.floor((totalSeconds % 3600) / 60);
  const s = totalSeconds % 60;
  const pad = (n: number) => n.toString().padStart(2, '0');
  if (h > 0) return `${h}:${pad(m)}:${pad(s)}`;
  return `${m}:${pad(s)}`;
}

// ============ GRADING ALGORITHM ============
interface GradeResult {
  grade: string;
  title: string;
  emoji: string;
  color: string;
  message: string;
  breakdown: { label: string; value: string; detail: string }[];
  tips: string[];
}

function calculateGrade(
  correct: number,
  total: number,
  elapsedSeconds: number
): GradeResult {
  const pct = total > 0 ? (correct / total) * 100 : 0;
  const avgSecondsPerQuestion = total > 0 ? elapsedSeconds / total : 0;

  // --- Accuracy score (0–50 points) ---
  const accuracyScore = (pct / 100) * 50;

  // --- Speed score (0–30 points) ---
  // Ideal: ≤20s/question = full points; ≥90s/question = 0
  let speedScore: number;
  if (avgSecondsPerQuestion <= 20) {
    speedScore = 30;
  } else if (avgSecondsPerQuestion >= 90) {
    speedScore = 0;
  } else {
    speedScore = 30 * (1 - (avgSecondsPerQuestion - 20) / 70);
  }

  // --- Completion bonus (0–20 points) ---
  // Answering all = 20 pts. Scale by ratio answered.
  const answered = correct + (total - correct); // all answered if quiz finishes
  const completionScore = (answered / total) * 20;

  const rawScore = accuracyScore + speedScore + completionScore;
  const finalScore = Math.round(Math.min(100, Math.max(0, rawScore)));

  // Determine grade
  let grade: string, title: string, emoji: string, color: string, message: string;
  let tips: string[] = [];

  if (finalScore >= 90) {
    grade = 'A+'; title = 'Outstanding!'; emoji = '🏆'; color = 'var(--success)';
    message = "Incredible performance! You've truly mastered this material. Your speed and accuracy show deep understanding.";
    tips = [
      'Challenge yourself with harder material next time',
      'Try teaching this topic to someone else to cement your knowledge',
      'Consider exploring advanced topics in this area'
    ];
  } else if (finalScore >= 80) {
    grade = 'A'; title = 'Excellent Work!'; emoji = '🌟'; color = 'var(--success)';
    message = "You've demonstrated a strong grasp of the content. Just a few areas to polish and you'll be at the top.";
    tips = [
      'Review the questions you missed for any gaps',
      'Great pace — maintain this focus in future sessions',
      'Try the quiz again to aim for a perfect score'
    ];
  } else if (finalScore >= 70) {
    grade = 'B+'; title = 'Great Job!'; emoji = '💪'; color = 'var(--accent-light)';
    message = "Solid understanding of the material! You're well on your way to mastery — a bit more review will get you there.";
    tips = [
      'Focus on the sections where you made errors',
      'Try slowing down on tricky questions for better accuracy',
      'Re-read the source material for the topics you missed'
    ];
  } else if (finalScore >= 60) {
    grade = 'B'; title = 'Good Effort!'; emoji = '📖'; color = 'var(--accent-light)';
    message = "You have a decent foundation! With some targeted review, you can significantly improve.";
    tips = [
      'Review the Active Recall section for key concepts',
      'Take more time to think through each question carefully',
      'Focus on understanding WHY each answer is correct'
    ];
  } else if (finalScore >= 45) {
    grade = 'C'; title = 'Keep Going!'; emoji = '🌱'; color = 'var(--warning)';
    message = "You're building your understanding — every attempt makes you stronger. Focus on the fundamentals and try again.";
    tips = [
      'Re-read the document and use the Active Recall feature first',
      'Start with fewer questions to build confidence',
      'Focus on definitions and basic concepts before advancing'
    ];
  } else {
    grade = 'D'; title = "Don't Give Up!"; emoji = '🔥'; color = 'var(--warning)';
    message = "Learning is a journey, and every quiz gets you closer to mastery. Review the material and give it another shot — you've got this!";
    tips = [
      'Use the Simplified Summary to understand the material first',
      'Try a True/False quiz to start — it helps build familiarity',
      'Break the content into smaller sections and study each one',
      'Practice makes progress — retry this quiz after reviewing'
    ];
  }

  // --- Speed assessment ---
  let speedLabel: string;
  if (avgSecondsPerQuestion <= 15) speedLabel = 'Lightning Fast ⚡';
  else if (avgSecondsPerQuestion <= 30) speedLabel = 'Quick & Focused';
  else if (avgSecondsPerQuestion <= 60) speedLabel = 'Steady Pace';
  else speedLabel = 'Thoughtful & Careful';

  const breakdown = [
    {
      label: 'Accuracy',
      value: `${Math.round(pct)}%`,
      detail: `${correct} of ${total} correct`
    },
    {
      label: 'Speed',
      value: speedLabel,
      detail: `${Math.round(avgSecondsPerQuestion)}s avg per question`
    },
    {
      label: 'Total Time',
      value: formatTime(elapsedSeconds),
      detail: `${total} questions completed`
    },
    {
      label: 'Final Score',
      value: `${finalScore}/100`,
      detail: `Accuracy ${Math.round(accuracyScore)} + Speed ${Math.round(speedScore)} + Completion ${Math.round(completionScore)}`
    }
  ];

  return { grade, title, emoji, color, message, breakdown, tips };
}

// ============ MAIN COMPONENT ============
export default function QuizPage({ apiKey, onApiKeyChange, onProjectUpdate, activeProject, onClearProject }: QuizPageProps) {
  const [file, setFile] = useState<File | null>(null);
  const [dragover, setDragover] = useState(false);
  const [selectedType, setSelectedType] = useState<QuizQuestionType>('mixed');
  const [numQuestions, setNumQuestions] = useState(10);
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState(0);
  const [progressSteps, setProgressSteps] = useState<ProgressStep[]>([]);
  const [error, setError] = useState('');
  const [quizState, setQuizState] = useState<QuizState | null>(null);
  const [userInput, setUserInput] = useState('');
  const [showSummary, setShowSummary] = useState(false);
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  // Cached parsed text from a loaded project (avoids re-parsing)
  const [cachedParsedText, setCachedParsedText] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const timer = useTimer();

  // Load a saved project when clicked in sidebar
  useEffect(() => {
    if (activeProject && activeProject.type === 'document' && activeProject.id !== loadedProjectId) {
      // Reset quiz state for new project
      setQuizState(null);
      setShowSummary(false);
      setError('');
      timer.reset();

      // If we have parsed text cached in the project, use it directly
      if (activeProject.parsedText) {
        setCachedParsedText(activeProject.parsedText);
      } else {
        setCachedParsedText(null);
      }

      // Restore the file object for display purposes
      (async () => {
        const restoredFile = await getFileFromProject(activeProject);
        if (restoredFile) {
          setFile(restoredFile);
        }
      })();

      setLoadedProjectId(activeProject.id);
    }
  }, [activeProject, loadedProjectId]);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    if (f) {
      setFile(f);
      setCachedParsedText(null); // New file upload, no cache
      setLoadedProjectId(null);
      onClearProject?.();
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragover(true);
  };

  const handleDragLeave = () => setDragover(false);

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragover(false);
    const f = e.dataTransfer.files?.[0];
    if (f) {
      setFile(f);
      setCachedParsedText(null);
      setLoadedProjectId(null);
      onClearProject?.();
    }
  };

  const removeFile = () => {
    setFile(null);
    setCachedParsedText(null);
    setLoadedProjectId(null);
    onClearProject?.();
    if (fileInputRef.current) fileInputRef.current.value = '';
  };

  const updateSteps = (steps: ProgressStep[]) => setProgressSteps([...steps]);

  const handleGenerate = async () => {
    const effectiveKey = resolveApiKey(apiKey);
    
    if (!file && !cachedParsedText) {
      setError('Please upload a document first.');
      return;
    }

    setLoading(true);
    setError('');
    setQuizState(null);
    setShowSummary(false);
    timer.reset();

    // Determine if we can skip parsing
    const hasCachedText = !!cachedParsedText;

    const steps: ProgressStep[] = hasCachedText
      ? [
          { label: 'Loading saved document', status: 'active' },
          { label: 'Analyzing with AI', status: 'pending' },
          { label: 'Building quiz', status: 'pending' },
        ]
      : [
          { label: 'Reading document', status: 'active' },
          { label: 'Extracting text content', status: 'pending' },
          { label: 'Analyzing with AI', status: 'pending' },
          { label: 'Building quiz', status: 'pending' },
        ];
    updateSteps(steps);
    setProgress(10);

    let projectId: string | null = loadedProjectId;

    try {
      let text: string;

      if (hasCachedText) {
        // FAST PATH: use cached parsed text from IndexedDB
        text = cachedParsedText!;
        await new Promise((r) => setTimeout(r, 200));
        steps[0].status = 'completed';
        steps[1].status = 'active';
        updateSteps(steps);
        setProgress(50);
      } else {
        // STANDARD PATH: create project + parse file
        if (file) {
          const project = await createProjectFromFile(file);
          projectId = project.id;
          await updateProjectStatus(projectId, 'processing');
          onProjectUpdate?.();
        }

        await new Promise((r) => setTimeout(r, 400));
        steps[0].status = 'completed';
        steps[1].status = 'active';
        updateSteps(steps);
        setProgress(25);

        text = await parseFile(file!);

        // Cache the parsed text so we never re-parse this doc
        if (projectId) {
          await updateProjectParsedText(projectId, text);
          setCachedParsedText(text);
          setLoadedProjectId(projectId);
        }

        await new Promise((r) => setTimeout(r, 200));
        steps[1].status = 'completed';
        steps[2].status = 'active';
        updateSteps(steps);
        setProgress(45);
      }

      if (text.trim().length < 50) {
        throw new Error('The document does not contain enough text content (minimum 50 characters).');
      }

      // AI generation step
      const aiStepIndex = hasCachedText ? 1 : 2;
      const buildStepIndex = hasCachedText ? 2 : 3;

      setUserInput(''); // Clean up the raw text input box state for short answers

      setProgress(55);
      
      // Call your service safely routing through the proxy handler 
      const questions = await generateQuiz(effectiveKey, text, selectedType, numQuestions);
      
      steps[aiStepIndex].status = 'completed';
      steps[buildStepIndex].status = 'active';
      updateSteps(steps);
      setProgress(85);

      await new Promise((r) => setTimeout(r, 400));
      steps[buildStepIndex].status = 'completed';
      updateSteps(steps);
      setProgress(100);

      await new Promise((r) => setTimeout(r, 400));

      setQuizState({
        questions,
        currentIndex: 0,
        answers: {},
        revealed: {},
        score: { correct: 0, incorrect: 0 },
      });
      timer.start();

      if (projectId) {
        await updateProjectStatus(projectId, 'ready');
        onProjectUpdate?.();
      }
    } catch (err: any) {
      setError(err.message || 'Failed to generate quiz. Please try again.');
      if (projectId) {
        await updateProjectStatus(projectId, 'error');
        onProjectUpdate?.();
      }
    } finally {
      setLoading(false);
      setProgress(0);
      setProgressSteps([]);
    }
  };

  const currentQuestion = quizState?.questions[quizState.currentIndex];
  const isAnswered = quizState ? quizState.revealed[quizState.currentIndex] === true : false;
  const totalQuestions = quizState?.questions.length || 0;

  const checkShortAnswer = (userAns: string, correctAns: string): boolean => {
    const normalize = (s: string) => s.toLowerCase().trim().replace(/[.,!?;:'"]/g, '').replace(/\s+/g, ' ');
    const u = normalize(userAns);
    const c = normalize(correctAns);
    if (u === c) return true;
    if (c.includes(u) || u.includes(c)) return true;
    const uWords = new Set(u.split(' '));
    const cWords = c.split(' ');
    if (cWords.length > 0) {
      const overlap = cWords.filter(w => uWords.has(w)).length;
      if (overlap / cWords.length >= 0.6) return true;
    }
    return false;
  };

  const handleSelectAnswer = useCallback((answer: string) => {
    if (!quizState || isAnswered) return;

    const q = quizState.questions[quizState.currentIndex];
    const isCorrect = q.type === 'short-answer'
      ? checkShortAnswer(answer, q.correctAnswer)
      : answer.toLowerCase().trim() === q.correctAnswer.toLowerCase().trim();

    setQuizState((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        answers: { ...prev.answers, [prev.currentIndex]: answer },
        revealed: { ...prev.revealed, [prev.currentIndex]: true },
        score: {
          correct: prev.score.correct + (isCorrect ? 1 : 0),
          incorrect: prev.score.incorrect + (isCorrect ? 0 : 1),
        },
      };
    });
  }, [quizState, isAnswered]);

  const handleShortAnswerSubmit = () => {
    if (userInput.trim()) {
      handleSelectAnswer(userInput.trim());
    }
  };

  const goNext = () => {
    if (!quizState) return;
    if (quizState.currentIndex < totalQuestions - 1) {
      setQuizState((prev) => prev ? { ...prev, currentIndex: prev.currentIndex + 1 } : prev);
      setUserInput('');
    } else {
      timer.stop();
      setShowSummary(true);
    }
  };

  const goPrev = () => {
    if (!quizState || quizState.currentIndex <= 0) return;
    setQuizState((prev) => prev ? { ...prev, currentIndex: prev.currentIndex - 1 } : prev);
    setUserInput('');
  };

  const handleRestart = () => {
    setQuizState(null);
    setShowSummary(false);
    setUserInput('');
    setError('');
    timer.reset();
  };

  const handleRetry = () => {
    if (!quizState) return;
    setQuizState({
      ...quizState,
      currentIndex: 0,
      answers: {},
      revealed: {},
      score: { correct: 0, incorrect: 0 },
    });
    setShowSummary(false);
    setUserInput('');
    timer.start();
  };

  const getFileIcon = (name: string) => {
    const ext = name.split('.').pop()?.toLowerCase();
    if (ext === 'pdf') return '📄';
    if (ext === 'docx') return '📃';
    return '📝';
  };

  const getOptionClass = (option: string, q: QuizQuestion, idx: number) => {
    const answered = quizState?.revealed[idx];
    const selected = quizState?.answers[idx];
    if (!answered) {
      return selected === option ? 'quiz-option selected' : 'quiz-option';
    }
    let cls = 'quiz-option disabled';
    if (option === q.correctAnswer) cls += ' correct';
    else if (option === selected) cls += ' incorrect';
    else cls += ' faded';
    return cls;
  };

  const getTfClass = (value: string, q: QuizQuestion, idx: number) => {
    const answered = quizState?.revealed[idx];
    const selected = quizState?.answers[idx];
    if (!answered) {
      return selected === value ? 'tf-option selected' : 'tf-option';
    }
    let cls = 'tf-option disabled';
    if (value === q.correctAnswer) cls += ' correct';
    else if (value === selected) cls += ' incorrect';
    return cls;
  };

  // ============ QUIZ SUMMARY VIEW ============
  if (showSummary && quizState) {
    const gradeResult = calculateGrade(
      quizState.score.correct,
      totalQuestions,
      timer.seconds
    );

    return (
      <div className="page-container">
        <div className="quiz-summary">
          <div className="quiz-summary-icon">{gradeResult.emoji}</div>
          <h2>{gradeResult.title}</h2>
          <p>{gradeResult.message}</p>

          {/* Grade Badge */}
          <div className="grade-badge" style={{ borderColor: gradeResult.color }}>
            <span className="grade-letter" style={{ color: gradeResult.color }}>{gradeResult.grade}</span>
          </div>

          {/* Breakdown Grid */}
          <div className="grade-breakdown">
            {gradeResult.breakdown.map((item, i) => (
              <div key={i} className="breakdown-item">
                <div className="breakdown-label">{item.label}</div>
                <div className="breakdown-value">{item.value}</div>
                <div className="breakdown-detail">{item.detail}</div>
              </div>
            ))}
          </div>

          {/* Stats Row */}
          <div className="quiz-summary-stats">
            <div className="stat-item">
              <div className="stat-value correct-val">{quizState.score.correct}</div>
              <div className="stat-label">Correct</div>
            </div>
            <div className="stat-item">
              <div className="stat-value incorrect-val">{quizState.score.incorrect}</div>
              <div className="stat-label">Incorrect</div>
            </div>
            <div className="stat-item">
              <div className="stat-value total-val">{totalQuestions}</div>
              <div className="stat-label">Total</div>
            </div>
            <div className="stat-item">
              <div className="stat-value" style={{ color: 'var(--info)' }}>{formatTime(timer.seconds)}</div>
              <div className="stat-label">Time</div>
            </div>
          </div>

          {/* Tips */}
          {gradeResult.tips.length > 0 && (
            <div className="grade-tips">
              <div className="grade-tips-title">💡 What to do next</div>
              {gradeResult.tips.map((tip, i) => (
                <div key={i} className="grade-tip-item">
                  <span className="grade-tip-bullet">{i + 1}</span>
                  <span>{tip}</span>
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', flexWrap: 'wrap', marginTop: 28 }}>
            <button className="btn btn-primary" onClick={handleRetry}>
              🔄 Retry Quiz
            </button>
            <button className="btn btn-secondary" onClick={handleRestart}>
              📂 New Document
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ============ QUIZ IN PROGRESS VIEW ============
  if (quizState && currentQuestion) {
    const idx = quizState.currentIndex;
    const answered = quizState.revealed[idx] === true;
    const selected = quizState.answers[idx];
    const isCorrect = selected ? (
      currentQuestion.type === 'short-answer'
        ? checkShortAnswer(selected, currentQuestion.correctAnswer)
        : selected.toLowerCase().trim() === currentQuestion.correctAnswer.toLowerCase().trim()
    ) : false;

    return (
      <div className="page-container">
        <div className="page-header">
          <h1>Document Quiz</h1>
        </div>

        <div className="quiz-interface">
          <div className="quiz-progress-header">
            <span className="quiz-progress-text">
              Question <span>{idx + 1}</span> of <span>{totalQuestions}</span>
            </span>
            <div className="quiz-header-right">
              <div className="quiz-timer" title="Elapsed time">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <circle cx="12" cy="12" r="10"/>
                  <polyline points="12 6 12 12 16 14"/>
                </svg>
                <span>{formatTime(timer.seconds)}</span>
              </div>
              <div className="quiz-score">
                <span className="score-correct">✓ {quizState.score.correct}</span>
                <span className="score-incorrect">✗ {quizState.score.incorrect}</span>
              </div>
            </div>
          </div>

          <div className="progress-bar-wrapper" style={{ marginBottom: 24 }}>
            <div
              className="progress-bar-fill"
              style={{ width: `${((idx + 1) / totalQuestions) * 100}%` }}
            />
          </div>

          <div className="quiz-question-card">
            <span className="quiz-question-type-badge">
              {currentQuestion.type === 'mcq' ? '🔘 Multiple Choice' :
                currentQuestion.type === 'true-false' ? '✅ True / False' : '✏️ Short Answer'}
            </span>
            {currentQuestion.section && (
              <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 10 }}>
                📂 {currentQuestion.section}
              </div>
            )}
            <div className="quiz-question-text">{currentQuestion.question}</div>

            {/* MCQ */}
            {currentQuestion.type === 'mcq' && currentQuestion.options && (
              <div className="quiz-options">
                {currentQuestion.options.map((option, oi) => (
                  <div
                    key={oi}
                    className={getOptionClass(option, currentQuestion, idx)}
                    onClick={() => !answered && handleSelectAnswer(option)}
                  >
                    <span className="option-letter">
                      {String.fromCharCode(65 + oi)}
                    </span>
                    <span>{option}</span>
                  </div>
                ))}
              </div>
            )}

            {/* True/False */}
            {currentQuestion.type === 'true-false' && (
              <div className="tf-options">
                {['True', 'False'].map((val) => (
                  <div
                    key={val}
                    className={getTfClass(val, currentQuestion, idx)}
                    onClick={() => !answered && handleSelectAnswer(val)}
                  >
                    {val === 'True' ? '✓' : '✗'} {val}
                  </div>
                ))}
              </div>
            )}

            {/* Short Answer */}
            {currentQuestion.type === 'short-answer' && (
              <div>
                <input
                  type="text"
                  className="short-answer-input"
                  placeholder="Type your answer..."
                  value={answered ? (selected || '') : userInput}
                  onChange={(e) => setUserInput(e.target.value)}
                  disabled={answered}
                  onKeyDown={(e) => e.key === 'Enter' && handleShortAnswerSubmit()}
                />
                {!answered && (
                  <div style={{ marginTop: 12 }}>
                    <button
                      className="btn btn-sm btn-primary"
                      onClick={handleShortAnswerSubmit}
                      disabled={!userInput.trim()}
                    >
                      Submit Answer
                    </button>
                  </div>
                )}
              </div>
            )}

            {/* Feedback */}
            {answered && (
              <div className={`quiz-feedback ${isCorrect ? 'correct' : 'incorrect'}`}>
                <span className="feedback-icon">{isCorrect ? '✅' : '❌'}</span>
                <div>
                  <strong>{isCorrect ? 'Correct!' : `Incorrect. Answer: ${currentQuestion.correctAnswer}`}</strong>
                  <br />
                  {currentQuestion.explanation}
                </div>
              </div>
            )}
          </div>

          <div className="quiz-nav">
            <button
              className="btn btn-secondary"
              onClick={goPrev}
              disabled={idx === 0}
            >
              ← Previous
            </button>
            <button
              className="btn btn-primary"
              onClick={goNext}
              disabled={!answered}
            >
              {idx === totalQuestions - 1 ? 'Finish Quiz →' : 'Next →'}
            </button>
          </div>
        </div>
      </div>
    );
  }

  // ============ UPLOAD & CONFIG VIEW ============
  return (
    <div className="page-container">
      <div className="page-header">
        <h1>Document Quiz Generator</h1>
        <p>Upload a document and get an AI-generated interactive quiz to test your knowledge.</p>
      </div>

      <ApiKeyInput apiKey={apiKey} onApiKeyChange={onApiKeyChange} />

      {/* Upload Zone */}
      <div
        className={`upload-zone ${dragover ? 'dragover' : ''}`}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
      >
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileSelect}
          accept=".pdf,.docx,.txt"
        />
        <span className="upload-zone-icon">📂</span>
        <h3>Drop your document here</h3>
        <p>or click here to browse — supports PDF, DOCX, TXT</p>
      </div>

      {file && (
        <div className="file-info">
          <span className="file-info-icon">{getFileIcon(file.name)}</span>
          <div className="file-info-details">
            <div className="file-info-name">{file.name}</div>
            <div className="file-info-size">{formatFileSize(file.size)}</div>
          </div>
          <button className="file-info-remove" onClick={removeFile}>✕</button>
        </div>
      )}

      {/* Quiz Config */}
      <div className="quiz-config">
        <h3>⚙️ Quiz Settings</h3>

        <div className="config-group">
          <label className="config-label">Question Type</label>
          <div className="config-options">
            {questionTypes.map((qt) => (
              <button
                key={qt.value}
                className={`config-option ${selectedType === qt.value ? 'selected' : ''}`}
                onClick={() => setSelectedType(qt.value)}
              >
                {qt.icon} {qt.label}
              </button>
            ))}
          </div>
        </div>

        <div className="config-group">
          <label className="config-label">Number of Questions</label>
          <div className="config-options">
            {numOptions.map((n) => (
              <button
                key={n}
                className={`config-option ${numQuestions === n ? 'selected' : ''}`}
                onClick={() => setNumQuestions(n)}
              >
                {n} questions
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Generate Button */}
      <div className="quiz-action-bar" style={{ marginTop: 24, display: 'flex', justifyContent: 'flex-end' }}>
        <button
          className="btn btn-primary"
          onClick={handleGenerate}
          disabled={loading || !file}
        >
          {loading ? (
            <>
              <span className="spinner" /> Generating...
            </>
          ) : (
            <>
              <span className="btn-icon">🚀</span> Generate Quiz
            </>
          )}
        </button>
      </div>

      {/* Progress */}
      {loading && (
        <div className="progress-container">
          <div className="progress-bar-wrapper">
            <div className="progress-bar-fill" style={{ width: `${progress}%` }} />
          </div>
          <div className="progress-info">
            <span>Processing document...</span>
            <span>{progress}%</span>
          </div>
          <div style={{ marginTop: 16 }}>
            {progressSteps.map((step, i) => (
              <div key={i} className={`progress-step ${step.status}`}>
                <span className="step-icon">
                  {step.status === 'completed' ? '✅' :
                    step.status === 'active' ? <span className="spinner" /> :
                      '○'}
                </span>
                <span>{step.label}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {error && (
        <div className="error-msg">
          <span>⚠️</span> {error}
        </div>
      )}
    </div>
  );
}
