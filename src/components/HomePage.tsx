// src/components/HomePage.tsx
import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom'; // Import Link component for SEO routing
import { createPortal } from 'react-dom'; 

const faqs = [
  {
    q: 'How does Active Recall work?',
    a: 'Paste any study content — lecture notes, articles, or textbook passages — and our AI creates a Feynman-style simplified summary, flashcards with difficulty levels, key concepts, retrieval prompts, and section-by-section recall questions. Everything is structured for maximum memory retention.',
  },
  {
    q: 'What file formats does Document Quiz support?',
    a: 'We support PDF (.pdf), Word documents (.docx), and plain text (.txt) files. The AI extracts and analyzes the full text, then generates a hierarchical quiz covering every major concept from your document.',
  },
  {
    q: 'What quiz formats are available?',
    a: 'Choose from Multiple Choice, True/False, Short Answer, or Mixed format. Questions progress from foundational concepts to advanced understanding, with detailed explanations for each answer.',
  },
  {
    q: 'Is my data private and secure?',
    a: 'Absolutely. Your content is sent directly to Google\'s Gemini API and is never stored on any server. Your API key stays in your browser session only and is never shared with any third party beyond Google.',
  },
  {
    q: 'How do I get a free Gemini API key?',
    a: 'Visit Google AI Studio at aistudio.google.com, sign in with your Google account, and generate a free API key. The free tier provides generous limits that are more than enough for studying.',
  },
];

export default function HomePage() {
  const [openFaq, setOpenFaq] = useState<number | null>(0);
const [bannerStatus, setBannerStatus] = useState<'visible' | 'fading' | 'hidden'>('hidden');

  useEffect(() => {
    const isBannerDismissed = localStorage.getItem('desktop_hint_dismissed');
    
    if (!isBannerDismissed) {
      setBannerStatus('visible');

      // Start the fade-out phase after 5 seconds
      const timer = setTimeout(() => {
        triggerFadeOut();
      }, 5000);

      return () => clearTimeout(timer);
    }
  }, []);

  const triggerFadeOut = () => {
    setBannerStatus('fading');
    // Wait 400ms for the CSS transition to complete before removing from DOM
    setTimeout(() => {
      setBannerStatus('hidden');
      localStorage.setItem('desktop_hint_dismissed', 'true');
    }, 400);
  };

    return (
    <div className="page-container">
      {/* Injecting media query to enforce desktop hidden rule dynamically */}
      <style>{`
        @media (min-width: 768px) {
          .desktop-hint-banner {
            display: none !important;
          }
        }
      `}</style>

  {/* Minimal Auto-Dismiss Mobile Banner rendered outside the page container */}
{/* Minimal Auto-Dismiss Mobile Banner rendered outside the page container */}
{bannerStatus !== 'hidden' && createPortal(
  <div 
    className="desktop-hint-banner"
    style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      backgroundColor: '#1e1e24', 
      color: '#ffffff',
      padding: '14px 16px',
      fontSize: '13px',
      fontWeight: '500',
      textAlign: 'center',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      gap: '8px',
      zIndex: 99999, 
      boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
      borderBottom: '1px solid rgba(255,255,255,0.1)',
      
      // Smooth Transition logic
      transition: 'opacity 400ms ease, transform 400ms ease',
      opacity: bannerStatus === 'visible' ? 1 : 0,
      transform: bannerStatus === 'visible' ? 'translateY(0)' : 'translateY(-10px)',
    }}
  >
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}>
      <rect x="2" y="3" width="20" height="14" rx="2" ry="2"/>
      <line x1="8" y1="21" x2="16" y2="21"/>
      <line x1="12" y1="17" x2="12" y2="21"/>
    </svg>
    <span style={{ paddingRight: '8px' }}>For the best experience, try ExplaiNote on desktop.</span>
    <button 
      onClick={triggerFadeOut} // Triggers the smooth exit animation
      style={{
        background: 'none',
        border: 'none',
        color: 'rgba(255,255,255,0.6)',
        fontSize: '18px',
        cursor: 'pointer',
        marginLeft: 'auto',
        padding: '0 4px',
        lineHeight: 1,
        flexShrink: 0
      }}
      aria-label="Dismiss banner"
    >
      ×
    </button>
  </div>,
  document.body
)}

    {/* Hero */}
      <div className="home-hero">
        <div className="home-hero-badge">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          AI-Powered Learning
        </div>
        <h1>Simplify. Recall.<br/>Master Anything.</h1>
        <p>
          Transform complex material into clear explanations, 
          smart flashcards, and adaptive quizzes — all powered by AI 
          that thinks like your best tutor.
        </p>
      </div>

      {/* Feature Cards converted to semantic Link elements */}
      <div className="home-features">
        <Link to="/recall" className="feature-card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="feature-card-icon recall">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/>
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/>
            </svg>
          </div>
          <h3>Active Recall</h3>
          <p>
            Paste any text and get AI-simplified summaries, layered flashcards, 
            and retrieval prompts designed with the Feynman technique.
          </p>
          <span className="feature-card-arrow">→</span>
        </Link>

        <Link to="/quiz" className="feature-card" style={{ textDecoration: 'none', color: 'inherit' }}>
          <div className="feature-card-icon quiz">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="16" y1="13" x2="8" y2="13"/>
              <line x1="16" y1="17" x2="8" y2="17"/>
              <polyline points="10 9 9 9 8 9"/>
            </svg>
          </div>
          <h3>Document Quiz</h3>
          <p>
            Upload a document and get an interactive quiz with multiple 
            formats — covering the entire content hierarchically.
          </p>
          <span className="feature-card-arrow">→</span>
        </Link>
      </div>

      {/* How it works */}
      <h2 className="section-title">
        <span className="title-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3"/>
            <path d="M12 1v4m0 14v4M4.22 4.22l2.83 2.83m9.9 9.9l2.83 2.83M1 12h4m14 0h4M4.22 19.78l2.83-2.83m9.9-9.9l2.83-2.83"/>
          </svg>
        </span>
        How It Works
      </h2>
      <div className="how-it-works">
        <div className="hiw-step">
          <div className="hiw-step-num">1</div>
          <h4>Input Content</h4>
          <p>Paste text or upload a document (PDF, DOCX, TXT)</p>
        </div>
        <div className="hiw-step">
          <div className="hiw-step-num">2</div>
          <h4>AI Analysis</h4>
          <p>Gemini AI simplifies and structures your content intelligently</p>
        </div>
        <div className="hiw-step">
          <div className="hiw-step-num">3</div>
          <h4>Study & Retain</h4>
          <p>Use generated materials to actively test and reinforce learning</p>
        </div>
      </div>

      {/* FAQ */}
      <h2 className="section-title">
        <span className="title-icon">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10"/>
            <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
        </span>
        Frequently Asked Questions
      </h2>
      <div className="faq-list">
        {faqs.map((faq, i) => (
          <div
            key={i}
            className={`faq-item ${openFaq === i ? 'open' : ''}`}
          >
            <button
              className="faq-question"
              onClick={() => setOpenFaq(openFaq === i ? null : i)}
              aria-expanded={openFaq === i}
            >
              <span>{faq.q}</span>

              <span className="faq-chevron">
                <svg
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </span>
            </button>

            <div className="faq-answer">
              {faq.a}
            </div>
          </div>
        ))}
      </div>
      {/* Footer */}
      <footer className="home-footer">
        <p>
          © 2026 ExplaiNote AI ·{' '}
          <Link to="/privacy">Privacy Policy</Link>
        </p>
      </footer>
    </div>
  );
}