import { useState, useRef, useEffect } from 'react';
import ApiKeyInput from './ApiKeyInput';
import DictionaryTooltip from './DictionaryTooltip';
import { generateRecallContent } from '../services/ai';
import { createProjectFromText, updateProjectStatus, type Project } from '../services/db';
import { resolveApiKey } from '../services/apiKey';
import type { RecallResult, FlashCard, KeyConcept, SectionRecall, SimplifiedSection } from '../types';

interface RecallPageProps {
  apiKey: string;
  onApiKeyChange: (key: string) => void;
  onProjectUpdate?: () => void;
  activeProject?: Project | null;
  onClearProject?: () => void;
}

// Flashcard component with reveal functionality
function FlashCardItem({ card, index, globalIndex, revealedCards, onToggle }: {
  card: FlashCard;
  index: number;
  globalIndex: number;
  revealedCards: Set<number>;
  onToggle: (index: number) => void;
}) {
  const isRevealed = revealedCards.has(globalIndex);
  const difficultyColors: Record<string, string> = {
    basic: 'var(--success)',
    intermediate: 'var(--warning)',
    advanced: 'var(--error)'
  };

  return (
    <div className={`flashcard ${isRevealed ? 'revealed' : ''}`}>
      <div className="flashcard-prompt">
        <span className="q-label">Q{index + 1}</span>
        <span style={{ flex: 1 }}>{card.question}</span>
        {card.difficulty && (
          <span 
            className="difficulty-badge" 
            style={{ 
              background: `${difficultyColors[card.difficulty]}20`,
              color: difficultyColors[card.difficulty],
              border: `1px solid ${difficultyColors[card.difficulty]}40`
            }}
          >
            {card.difficulty}
          </span>
        )}
      </div>
      {!isRevealed ? (
        <div className="flashcard-actions">
          <button className="flashcard-reveal-btn" onClick={() => onToggle(globalIndex)}>
            👁️ Reveal Answer
          </button>
        </div>
      ) : (
        <div className="flashcard-answer" onClick={() => onToggle(globalIndex)}>
          <span className="a-label">A</span>
          <span>{card.answer}</span>
        </div>
      )}
    </div>
  );
}

// Concept item component
function ConceptItem({ concept }: { concept: KeyConcept }) {
  return (
    <div className="concept-item">
      <div className="concept-bullet" />
      <div>
        <strong>{concept.term}</strong>
        <p>{concept.explanation}</p>
      </div>
    </div>
  );
}

// Collapsible section component
function CollapsibleSection({ 
  title, 
  icon, 
  children, 
  defaultOpen = true,
  badge,
  className = ''
}: { 
  title: string; 
  icon: string; 
  children: React.ReactNode;
  defaultOpen?: boolean;
  badge?: string | number;
  className?: string;
}) {
  const [isOpen, setIsOpen] = useState(defaultOpen);
  
  return (
    <div className={`recall-section ${isOpen ? 'open' : 'collapsed'} ${className}`}>
      <div 
        className="recall-section-header clickable" 
        onClick={() => setIsOpen(!isOpen)}
      >
        <span className="section-icon">{icon}</span>
        <h3>{title}</h3>
        {badge !== undefined && (
          <span className="section-badge">{badge}</span>
        )}
        <span className={`section-chevron ${isOpen ? 'open' : ''}`}>▼</span>
      </div>
      {isOpen && (
        <div className="recall-section-body">
          {children}
        </div>
      )}
    </div>
  );
}

// Simplified section component
function SimplifiedSectionBlock({ section, index }: { section: SimplifiedSection; index: number }) {
  return (
    <div className="simplified-section-block">
      <div className="simplified-section-header">
        <span className="simplified-section-number">{index + 1}</span>
        <h4>{section.heading}</h4>
      </div>
      
      <div className="simplified-section-content">
        <p className="simple-explanation">{section.simpleExplanation}</p>
        
        {section.keyPoints && section.keyPoints.length > 0 && (
          <div className="key-points-box">
            <div className="key-points-title">📌 Key Points</div>
            <ul>
              {section.keyPoints.map((point, i) => (
                <li key={i}>{point}</li>
              ))}
            </ul>
          </div>
        )}
        
        {section.analogy && (
          <div className="analogy-box">
            <span className="analogy-icon">💡</span>
            <div>
              <strong>Think of it like...</strong>
              <p>{section.analogy}</p>
            </div>
          </div>
        )}
        
        {section.realWorldExample && (
          <div className="example-box">
            <span className="example-icon">🌍</span>
            <div>
              <strong>Real-World Example</strong>
              <p>{section.realWorldExample}</p>
            </div>
          </div>
        )}
        
        {section.commonMisconceptions && section.commonMisconceptions.length > 0 && (
          <div className="misconceptions-box">
            <div className="misconceptions-title">⚠️ Common Misconceptions</div>
            <ul>
              {section.commonMisconceptions.map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </div>
  );
}

// Section recall component
function SectionRecallBlock({ 
  section, 
  sectionIndex,
  globalIndexStart,
  revealedCards, 
  onToggle 
}: {
  section: SectionRecall;
  sectionIndex: number;
  globalIndexStart: number;
  revealedCards: Set<number>;
  onToggle: (index: number) => void;
}) {
  let currentIndex = globalIndexStart;
  
  const renderFlashcards = (cards: FlashCard[] | undefined, categoryTitle: string, categoryIcon: string) => {
    if (!cards || cards.length === 0) return null;
    const startIdx = currentIndex;
    currentIndex += cards.length;
    
    return (
      <div className="category-block">
        <div className="category-header">
          <span>{categoryIcon}</span>
          <span>{categoryTitle}</span>
          <span className="category-count">{cards.length}</span>
        </div>
        <div className="flashcard-grid">
          {cards.map((card, i) => (
            <FlashCardItem
              key={i}
              card={card}
              index={i}
              globalIndex={startIdx + i}
              revealedCards={revealedCards}
              onToggle={onToggle}
            />
          ))}
        </div>
      </div>
    );
  };

  const totalQuestions = 
    (section.definitions?.length || 0) +
    (section.processes?.length || 0) +
    (section.examples?.length || 0) +
    (section.comparisons?.length || 0) +
    (section.applications?.length || 0) +
    (section.criticalThinking?.length || 0);

  return (
    <CollapsibleSection 
      title={`Section ${sectionIndex + 1}: ${section.sectionTitle}`}
      icon="📑"
      badge={`${totalQuestions} Q`}
      defaultOpen={sectionIndex === 0}
    >
      {section.sectionSummary && (
        <p className="section-summary-text">{section.sectionSummary}</p>
      )}
      
      {section.concepts && section.concepts.length > 0 && (
        <div className="category-block">
          <div className="category-header">
            <span>💡</span>
            <span>Key Concepts</span>
            <span className="category-count">{section.concepts.length}</span>
          </div>
          <div className="concept-list">
            {section.concepts.map((concept, i) => (
              <ConceptItem key={i} concept={concept} />
            ))}
          </div>
        </div>
      )}
      
      {renderFlashcards(section.definitions, 'Definitions', '📖')}
      {renderFlashcards(section.processes, 'Processes & Steps', '⚙️')}
      {renderFlashcards(section.examples, 'Examples', '💡')}
      {renderFlashcards(section.comparisons, 'Comparisons', '⚖️')}
      {renderFlashcards(section.applications, 'Applications', '🎯')}
      {renderFlashcards(section.criticalThinking, 'Critical Thinking', '🧠')}
    </CollapsibleSection>
  );
}

export default function RecallPage({ apiKey, onApiKeyChange, onProjectUpdate, activeProject, onClearProject }: RecallPageProps) {
  const [text, setText] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState<RecallResult | null>(null);
  const [revealedCards, setRevealedCards] = useState<Set<number>>(new Set());
  const [activeTab, setActiveTab] = useState<'summary' | 'bigpicture' | 'sections' | 'review'>('summary');
  const [loadedProjectId, setLoadedProjectId] = useState<string | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);

  // Load text from a selected project
  useEffect(() => {
    if (activeProject && activeProject.type === 'text' && activeProject.id !== loadedProjectId) {
      const loadedText = activeProject.parsedText || activeProject.content || '';
      if (loadedText) {
        setText(loadedText);
        setResult(null);
        setRevealedCards(new Set());
        setError('');
        setActiveTab('summary');
        setLoadedProjectId(activeProject.id);
      }
    }
  }, [activeProject, loadedProjectId]);

  const handleGenerate = async () => {
    const effectiveKey = resolveApiKey(apiKey);
    
    // 1. Removed the blocking "No API key available" check.
    // The underlying ai.ts service will now gracefully route to /api/proxy if effectiveKey is empty.

    if (text.trim().length < 50) {
      setError('Please enter at least 50 characters of text for meaningful analysis.');
      return;
    }

    setLoading(true);
    setError('');
    setResult(null);
    setRevealedCards(new Set());

    let projectId: string | null = null;

    try {
      // Create project entry
      const project = await createProjectFromText(text);
      projectId = project.id;
      await updateProjectStatus(projectId, 'processing');
      onProjectUpdate?.();

      // 2. This safely passes the effectiveKey (which might be "") right along to generateRecallContent
      const data = await generateRecallContent(effectiveKey, text);
      setResult(data);

      // Update project status to ready
      await updateProjectStatus(projectId, 'ready');
      onProjectUpdate?.();
    } catch (err: any) {
      setError(err.message || 'Failed to generate recall content. Please try again.');
      // Update project status to error
      if (projectId) {
        await updateProjectStatus(projectId, 'error');
        onProjectUpdate?.();
      }
    } finally {
      setLoading(false);
    }
  };
  
  const toggleCard = (index: number) => {
    setRevealedCards((prev) => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  const handleReset = () => {
    setResult(null);
    setRevealedCards(new Set());
    setError('');
    setActiveTab('summary');
    setLoadedProjectId(null);
    onClearProject?.();
  };

  const revealAll = () => {
    if (!result) return;
    const allIndices = new Set<number>();
    let idx = 0;
    
    // Big picture
    const bp = result.bigPictureRecall;
    if (bp) {
      idx += (bp.mainIdeas?.length || 0);
      idx += (bp.coreThemes?.length || 0);
      idx += (bp.purposeAndStructure?.length || 0);
      idx += (bp.sectionRelationships?.length || 0);
      idx += (bp.summaryQuestions?.length || 0);
    }
    
    // Sections
    if (result.sectionRecalls) {
      for (const section of result.sectionRecalls) {
        idx += (section.definitions?.length || 0);
        idx += (section.processes?.length || 0);
        idx += (section.examples?.length || 0);
        idx += (section.comparisons?.length || 0);
        idx += (section.applications?.length || 0);
        idx += (section.criticalThinking?.length || 0);
      }
    }
    
    // Cross-section and final
    idx += (result.crossSectionConnections?.length || 0);
    idx += (result.finalReviewQuestions?.length || 0);
    
    for (let i = 0; i < idx; i++) {
      allIndices.add(i);
    }
    
    setRevealedCards(allIndices);
  };

  const hideAll = () => {
    setRevealedCards(new Set());
  };

  // Calculate global index for flashcards
  const getGlobalIndexForBigPicture = () => {
    return 0;
  };

  const getGlobalIndexForSection = (sectionIndex: number) => {
    if (!result) return 0;
    let idx = 0;
    
    // Count big picture questions
    const bp = result.bigPictureRecall;
    if (bp) {
      idx += (bp.mainIdeas?.length || 0);
      idx += (bp.coreThemes?.length || 0);
      idx += (bp.purposeAndStructure?.length || 0);
      idx += (bp.sectionRelationships?.length || 0);
      idx += (bp.summaryQuestions?.length || 0);
    }
    
    // Count previous sections
    for (let i = 0; i < sectionIndex; i++) {
      const section = result.sectionRecalls[i];
      if (section) {
        idx += (section.definitions?.length || 0);
        idx += (section.processes?.length || 0);
        idx += (section.examples?.length || 0);
        idx += (section.comparisons?.length || 0);
        idx += (section.applications?.length || 0);
        idx += (section.criticalThinking?.length || 0);
      }
    }
    
    return idx;
  };

  const getGlobalIndexForReview = () => {
    if (!result) return 0;
    let idx = 0;
    
    // Count big picture
    const bp = result.bigPictureRecall;
    if (bp) {
      idx += (bp.mainIdeas?.length || 0);
      idx += (bp.coreThemes?.length || 0);
      idx += (bp.purposeAndStructure?.length || 0);
      idx += (bp.sectionRelationships?.length || 0);
      idx += (bp.summaryQuestions?.length || 0);
    }
    
    // Count all sections
    if (result.sectionRecalls) {
      for (const section of result.sectionRecalls) {
        idx += (section.definitions?.length || 0);
        idx += (section.processes?.length || 0);
        idx += (section.examples?.length || 0);
        idx += (section.comparisons?.length || 0);
        idx += (section.applications?.length || 0);
        idx += (section.criticalThinking?.length || 0);
      }
    }
    
    return idx;
  };

  const renderBigPictureFlashcards = (cards: FlashCard[] | undefined, title: string, icon: string, startIndex: number) => {
    if (!cards || cards.length === 0) return null;
    
    return (
      <div className="category-block">
        <div className="category-header">
          <span>{icon}</span>
          <span>{title}</span>
          <span className="category-count">{cards.length}</span>
        </div>
        <div className="flashcard-grid">
          {cards.map((card, i) => (
            <FlashCardItem
              key={i}
              card={card}
              index={i}
              globalIndex={startIndex + i}
              revealedCards={revealedCards}
              onToggle={toggleCard}
            />
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="page-container" ref={pageRef} style={{ position: 'relative' }}>
      <DictionaryTooltip containerRef={pageRef} />

      <div className="page-header">
        <h1>Active Recall Studio</h1>
        <p>Paste your study material and let AI create simplified summaries and comprehensive recall exercises.</p>
      </div>

      <div className="dict-hint">
        <svg className="dict-hint-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
          <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
        </svg>
        Double-click any word to see its definition
      </div>

      <ApiKeyInput apiKey={apiKey} onApiKeyChange={onApiKeyChange} />

      {!result && (
        <>
          <textarea
            className="text-input-area"
            placeholder="Paste your study material here — lecture notes, textbook passages, articles, or any content you want to learn and retain. The AI will create a simplified summary (Feynman technique) plus comprehensive recall questions..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            disabled={loading}
          />
          <div className="action-bar">
            <span className="char-count">{text.length} characters</span>
            <button
              className="btn btn-primary"
              onClick={handleGenerate}
              disabled={loading || !text.trim()}
            >
              {loading ? (
                <>
                  <span className="spinner" /> Analyzing...
                </>
              ) : (
                <>
                  <span className="btn-icon">🧠</span> Generate Study Materials
                </>
              )}
            </button>
          </div>
        </>
      )}

      {error && (
        <div className="error-msg">
          <span>⚠️</span> {error}
        </div>
      )}

      {loading && (
        <div className="loading-state">
          <div className="spinner spinner-lg" />
          <p>AI is analyzing your content...</p>
          <div className="loading-steps">
            <div className="loading-step">
              <span className="loading-step-icon">📝</span>
              <span>Step 1: Simplified summary (Feynman technique)</span>
            </div>
            <div className="loading-step">
              <span className="loading-step-icon">🎯</span>
              <span>Step 2: Big picture recall questions</span>
            </div>
            <div className="loading-step">
              <span className="loading-step-icon">📑</span>
              <span>Step 3: Section-by-section recall (per section)</span>
            </div>
          </div>
          <p style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 12 }}>
            Processing multiple API calls — this may take 15-30 seconds
          </p>
        </div>
      )}

      {result && (
        <div className="recall-results">
          {/* Action Bar */}
          <div className="recall-action-bar">
            <div className="recall-stats">
              <span className="stat-pill">
                📑 {result.totalCoverage?.sectionsIdentified || result.sectionRecalls?.length || 0} Sections
              </span>
              <span className="stat-pill">
                ❓ {result.totalCoverage?.questionsGenerated || 0} Questions
              </span>
              <span className="stat-pill">
                💡 {result.totalCoverage?.conceptsCovered || 0} Concepts
              </span>
            </div>
            <div className="recall-actions">
              <button className="btn btn-sm btn-secondary" onClick={revealAll}>
                👁️ Reveal All
              </button>
              <button className="btn btn-sm btn-secondary" onClick={hideAll}>
                🙈 Hide All
              </button>
              <button className="btn btn-sm btn-outline" onClick={handleReset}>
                ← New Content
              </button>
            </div>
          </div>

          {/* Tab Navigation */}
          <div className="recall-tabs">
            <button 
              className={`recall-tab ${activeTab === 'summary' ? 'active' : ''}`}
              onClick={() => setActiveTab('summary')}
            >
              📝 Simplified Summary
            </button>
            <button 
              className={`recall-tab ${activeTab === 'bigpicture' ? 'active' : ''}`}
              onClick={() => setActiveTab('bigpicture')}
            >
              🎯 Big Picture
            </button>
            <button 
              className={`recall-tab ${activeTab === 'sections' ? 'active' : ''}`}
              onClick={() => setActiveTab('sections')}
            >
              📑 Section Recall
            </button>
            <button 
              className={`recall-tab ${activeTab === 'review' ? 'active' : ''}`}
              onClick={() => setActiveTab('review')}
            >
              🔗 Review
            </button>
          </div>

          {/* Simplified Summary Tab */}
          {activeTab === 'summary' && result.simplifiedSummary && (
            <div className="tab-content">
              {/* Hero Summary Card */}
              <div className="summary-hero-card">
                <h2 className="summary-title">{result.simplifiedSummary.title}</h2>
                <p className="one-liner">{result.simplifiedSummary.oneLinerSummary}</p>
              </div>

              {/* Why It Matters */}
              <div className="why-matters-card">
                <div className="why-matters-icon">🎯</div>
                <div>
                  <h4>Why This Matters</h4>
                  <p>{result.simplifiedSummary.whyItMatters}</p>
                </div>
              </div>

              {/* Core Idea */}
              <CollapsibleSection title="The Core Idea" icon="💡" defaultOpen={true} className="core-idea-section">
                <p className="core-idea-text">{result.simplifiedSummary.coreIdea}</p>
              </CollapsibleSection>

              {/* Section-by-Section Simplified Explanations */}
              {result.simplifiedSummary.sections && result.simplifiedSummary.sections.length > 0 && (
                <CollapsibleSection 
                  title="Explained Simply" 
                  icon="📚" 
                  defaultOpen={true}
                  badge={`${result.simplifiedSummary.sections.length} sections`}
                >
                  <div className="simplified-sections-list">
                    {result.simplifiedSummary.sections.map((section, i) => (
                      <SimplifiedSectionBlock key={i} section={section} index={i} />
                    ))}
                  </div>
                </CollapsibleSection>
              )}

              {/* Key Takeaways */}
              {result.simplifiedSummary.keyTakeaways && result.simplifiedSummary.keyTakeaways.length > 0 && (
                <CollapsibleSection title="Key Takeaways" icon="🏆" defaultOpen={true}>
                  <div className="takeaways-list">
                    {result.simplifiedSummary.keyTakeaways.map((takeaway, i) => (
                      <div key={i} className="takeaway-item">
                        <span className="takeaway-number">{i + 1}</span>
                        <span>{takeaway}</span>
                      </div>
                    ))}
                  </div>
                </CollapsibleSection>
              )}

              {/* Quick Recap */}
              {result.simplifiedSummary.quickRecap && (
                <div className="quick-recap-card">
                  <div className="quick-recap-header">
                    <span>⚡</span>
                    <strong>Quick Recap</strong>
                  </div>
                  <p>{result.simplifiedSummary.quickRecap}</p>
                </div>
              )}

              {/* Glossary */}
              {result.simplifiedSummary.glossary && result.simplifiedSummary.glossary.length > 0 && (
                <CollapsibleSection 
                  title="Glossary" 
                  icon="📖" 
                  defaultOpen={false}
                  badge={`${result.simplifiedSummary.glossary.length} terms`}
                >
                  <div className="glossary-grid">
                    {result.simplifiedSummary.glossary.map((item, i) => (
                      <div key={i} className="glossary-item">
                        <dt>{item.term}</dt>
                        <dd>{item.explanation}</dd>
                      </div>
                    ))}
                  </div>
                </CollapsibleSection>
              )}
            </div>
          )}

          {/* Big Picture Tab */}
          {activeTab === 'bigpicture' && result.bigPictureRecall && (
            <div className="tab-content">
              {/* Document Overview */}
              <CollapsibleSection title="Document Overview" icon="📋" defaultOpen={true}>
                <p className="overview-text">{result.documentOverview}</p>
                {result.documentStructure && result.documentStructure.length > 0 && (
                  <div className="structure-list">
                    <strong>Content Structure:</strong>
                    <ul>
                      {result.documentStructure.map((item, i) => (
                        <li key={i}>{item}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </CollapsibleSection>

              {(() => {
                let idx = getGlobalIndexForBigPicture();
                const bp = result.bigPictureRecall;
                
                const mainIdeasStart = idx;
                idx += (bp.mainIdeas?.length || 0);
                
                const coreThemesStart = idx;
                idx += (bp.coreThemes?.length || 0);
                
                const purposeStart = idx;
                idx += (bp.purposeAndStructure?.length || 0);
                
                const relationshipsStart = idx;
                idx += (bp.sectionRelationships?.length || 0);
                
                const summaryStart = idx;
                
                return (
                  <>
                    {renderBigPictureFlashcards(bp.mainIdeas, 'Main Ideas & Arguments', '🎯', mainIdeasStart)}
                    {renderBigPictureFlashcards(bp.coreThemes, 'Core Themes', '🌟', coreThemesStart)}
                    {renderBigPictureFlashcards(bp.purposeAndStructure, 'Purpose & Structure', '📐', purposeStart)}
                    {renderBigPictureFlashcards(bp.sectionRelationships, 'Section Relationships', '🔗', relationshipsStart)}
                    {renderBigPictureFlashcards(bp.summaryQuestions, 'Summary-Level Understanding', '📝', summaryStart)}
                  </>
                );
              })()}
            </div>
          )}

          {/* Sections Tab */}
          {activeTab === 'sections' && result.sectionRecalls && (
            <div className="tab-content">
              {result.sectionRecalls.map((section, i) => (
                <SectionRecallBlock
                  key={i}
                  section={section}
                  sectionIndex={i}
                  globalIndexStart={getGlobalIndexForSection(i)}
                  revealedCards={revealedCards}
                  onToggle={toggleCard}
                />
              ))}
            </div>
          )}

          {/* Review Tab */}
          {activeTab === 'review' && (
            <div className="tab-content">
              {result.crossSectionConnections && result.crossSectionConnections.length > 0 && (
                <CollapsibleSection title="Cross-Section Connections" icon="🔗" defaultOpen={true}>
                  <div className="flashcard-grid">
                    {result.crossSectionConnections.map((card, i) => (
                      <FlashCardItem
                        key={i}
                        card={card}
                        index={i}
                        globalIndex={getGlobalIndexForReview() + i}
                        revealedCards={revealedCards}
                        onToggle={toggleCard}
                      />
                    ))}
                  </div>
                </CollapsibleSection>
              )}

              {result.finalReviewQuestions && result.finalReviewQuestions.length > 0 && (
                <CollapsibleSection title="Final Review Questions" icon="🏁" defaultOpen={true}>
                  <div className="flashcard-grid">
                    {result.finalReviewQuestions.map((card, i) => (
                      <FlashCardItem
                        key={i}
                        card={card}
                        index={i}
                        globalIndex={getGlobalIndexForReview() + (result.crossSectionConnections?.length || 0) + i}
                        revealedCards={revealedCards}
                        onToggle={toggleCard}
                      />
                    ))}
                  </div>
                </CollapsibleSection>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
