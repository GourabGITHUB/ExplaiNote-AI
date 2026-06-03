import { useState, useEffect, useRef, useCallback } from 'react';

interface TooltipData {
  word: string;
  definition: string;
  partOfSpeech: string;
  phonetic: string;
  x: number;
  y: number;
  arrowX: number;
}

interface DictionaryTooltipProps {
  containerRef: React.RefObject<HTMLDivElement | null>;
}

export default function DictionaryTooltip({ containerRef }: DictionaryTooltipProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const tooltipRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  const dismiss = useCallback(() => {
    setTooltip(null);
    setLoading(false);
    setError('');
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
    }
  }, []);

  const fetchDefinition = useCallback(async (word: string, rect: DOMRect) => {
    const cleanWord = word.replace(/[^a-zA-Z'-]/g, '').toLowerCase();
    if (!cleanWord || cleanWord.length < 2 || cleanWord.length > 40) return;

    // Abort any previous fetch
    if (abortRef.current) abortRef.current.abort();
    abortRef.current = new AbortController();

    setLoading(true);
    setError('');

    // Calculate position relative to the page-container (our positioned parent)
    const pageContainer = containerRef.current;
    if (!pageContainer) return;

    const parentRect = pageContainer.getBoundingClientRect();

    // Word position relative to the page-container
    const wordCenterX = rect.left + rect.width / 2 - parentRect.left;
    const wordTopY = rect.top - parentRect.top;

    // Tooltip width — clamp X so it doesn't overflow the container
    const tooltipWidth = 320;
    const containerWidth = parentRect.width;
    let tooltipX = wordCenterX - tooltipWidth / 2;
    tooltipX = Math.max(4, Math.min(tooltipX, containerWidth - tooltipWidth - 4));

    // Arrow points to the word center
    const arrowX = Math.max(16, Math.min(wordCenterX - tooltipX, tooltipWidth - 16));

    // Set a preliminary tooltip to show loading state
    setTooltip({
      word: cleanWord,
      definition: '',
      partOfSpeech: '',
      phonetic: '',
      x: tooltipX,
      y: wordTopY,
      arrowX,
    });

    try {
      const res = await fetch(
        `https://api.dictionaryapi.dev/api/v2/entries/en/${cleanWord}`,
        { signal: abortRef.current.signal }
      );

      if (!res.ok) {
        setError('No definition found');
        setLoading(false);
        return;
      }

      const data = await res.json();
      const entry = data[0];
      const firstMeaning = entry?.meanings?.[0];
      const definition = firstMeaning?.definitions?.[0]?.definition;
      const partOfSpeech = firstMeaning?.partOfSpeech || '';
      const phonetic = entry?.phonetic || entry?.phonetics?.[0]?.text || '';

      if (!definition) {
        setError('No definition found');
        setLoading(false);
        return;
      }

      setTooltip({
        word: cleanWord,
        definition,
        partOfSpeech,
        phonetic,
        x: tooltipX,
        y: wordTopY,
        arrowX,
      });
      setLoading(false);
      setError('');
    } catch (err: any) {
      if (err.name === 'AbortError') return;
      setError('Failed to fetch definition');
      setLoading(false);
    }
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const handleDoubleClick = (e: MouseEvent) => {
      // Don't trigger on buttons, inputs, textareas
      const target = e.target as HTMLElement;
      if (
        target.tagName === 'BUTTON' ||
        target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.closest('button') ||
        target.closest('input') ||
        target.closest('textarea')
      ) {
        return;
      }

      // Get the selected word from browser selection
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) return;

      const selectedText = selection.toString().trim();
      // Only handle single words
      if (!selectedText || selectedText.includes(' ') || selectedText.length < 2) return;

      const range = selection.getRangeAt(0);
      const rect = range.getBoundingClientRect();

      fetchDefinition(selectedText, rect);
    };

    container.addEventListener('dblclick', handleDoubleClick);
    return () => container.removeEventListener('dblclick', handleDoubleClick);
  }, [containerRef, fetchDefinition]);

  // Dismiss on click outside or scroll
  useEffect(() => {
    if (!tooltip) return;

    const handleClickOutside = (e: MouseEvent) => {
      if (tooltipRef.current && !tooltipRef.current.contains(e.target as Node)) {
        dismiss();
      }
    };

    const handleScroll = () => dismiss();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };

    // Delay adding the click listener so the dblclick doesn't immediately dismiss
    const timer = setTimeout(() => {
      document.addEventListener('mousedown', handleClickOutside);
    }, 100);

    const scrollContainer = containerRef.current?.closest('.main-content');
    scrollContainer?.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('keydown', handleKey);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('mousedown', handleClickOutside);
      scrollContainer?.removeEventListener('scroll', handleScroll);
      document.removeEventListener('keydown', handleKey);
    };
  }, [tooltip, dismiss, containerRef]);

  if (!tooltip) return null;

  return (
    <div
      ref={tooltipRef}
      className="dict-tooltip"
      style={{
        left: tooltip.x,
        top: tooltip.y,
      }}
    >
      <div className="dict-tooltip-arrow" style={{ left: tooltip.arrowX }} />
      <div className="dict-tooltip-content">
        <div className="dict-tooltip-header">
          <span className="dict-tooltip-word">{tooltip.word}</span>
          {tooltip.phonetic && (
            <span className="dict-tooltip-phonetic">{tooltip.phonetic}</span>
          )}
          <button
            className="dict-tooltip-close"
            onClick={dismiss}
            aria-label="Close"
          >
            ×
          </button>
        </div>

        {loading && (
          <div className="dict-tooltip-loading">
            <span className="spinner" />
            <span>Looking up…</span>
          </div>
        )}

        {error && !loading && (
          <div className="dict-tooltip-error">
            {error}
          </div>
        )}

        {!loading && !error && tooltip.definition && (
          <div className="dict-tooltip-body">
            {tooltip.partOfSpeech && (
              <span className="dict-tooltip-pos">{tooltip.partOfSpeech}</span>
            )}
            <p className="dict-tooltip-def">{tooltip.definition}</p>
          </div>
        )}
      </div>
    </div>
  );
}
