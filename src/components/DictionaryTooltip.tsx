import { useState, useEffect, useRef, useCallback, type RefObject } from 'react';

interface TooltipData {
  word: string;
  definition: string;
  partOfSpeech: string;
  phonetic: string;
  x: number;
  y: number;
  arrowX: number;
  width: number;
}

interface DictionaryTooltipProps {
  containerRef: RefObject<HTMLDivElement | null>;
}

interface TapRecord {
  time: number;
  x: number;
  y: number;
}

type CaretCapableDocument = Document & {
  caretPositionFromPoint?: (
    x: number,
    y: number
  ) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
};

// ── constants ──────────────────────────────────────────────────────────
const DOUBLE_TAP_MAX_DELAY = 400; // ms between two taps
const DOUBLE_TAP_MAX_DISTANCE = 25; // px drift tolerance between taps
const TAP_MAX_DURATION = 300; // ms – a single press must be shorter than this
const TAP_MAX_MOVE = 10; // px – movement within a single press

const INTERACTIVE_SELECTOR = [
  'button',
  'input',
  'textarea',
  'select',
  'option',
  'label',
  'a',
  'summary',
  '[role="button"]',
  '[role="link"]',
  '[contenteditable="true"]',
  '[contenteditable=""]',
  '[data-no-dictionary-tooltip="true"]',
].join(', ');

// ── helpers ────────────────────────────────────────────────────────────

function isIgnoredTarget(target: EventTarget | null): boolean {
  const el =
    target instanceof HTMLElement
      ? target
      : target instanceof Node
        ? target.parentElement
        : null;
  if (!el) return true;
  return !!el.closest(INTERACTIVE_SELECTOR);
}

function isWordChar(ch: string): boolean {
  return /[A-Za-z'-]/.test(ch);
}

function findTextNode(node: Node, backward = false): Text | null {
  if (node.nodeType === Node.TEXT_NODE) return node as Text;
  const kids = Array.from(node.childNodes);
  if (backward) kids.reverse();
  for (const child of kids) {
    const found = findTextNode(child, backward);
    if (found) return found;
  }
  return null;
}

function resolveTextPosition(
  node: Node,
  offset: number
): { node: Text; offset: number } | null {
  if (node.nodeType === Node.TEXT_NODE) {
    const len = node.textContent?.length ?? 0;
    return { node: node as Text, offset: Math.max(0, Math.min(offset, len)) };
  }

  const kids = node.childNodes;
  if (!kids.length) return null;

  const idx = Math.max(0, Math.min(offset, kids.length - 1));
  const next = findTextNode(kids[idx], false);
  if (next) return { node: next, offset: 0 };

  const prev = findTextNode(kids[Math.max(0, idx - 1)], true);
  if (prev) return { node: prev, offset: prev.textContent?.length ?? 0 };

  const any = findTextNode(node, false);
  return any ? { node: any, offset: 0 } : null;
}

function getWordBounds(
  text: string,
  rawOffset: number
): { word: string; start: number; end: number } | null {
  if (!text) return null;
  let off = rawOffset;
  if (off >= text.length) off = text.length - 1;
  if (off < 0) return null;

  if (!isWordChar(text[off])) {
    if (off > 0 && isWordChar(text[off - 1])) off -= 1;
    else return null;
  }

  let start = off;
  let end = off + 1;
  while (start > 0 && isWordChar(text[start - 1])) start--;
  while (end < text.length && isWordChar(text[end])) end++;

  const word = text.slice(start, end).trim();
  return word ? { word, start, end } : null;
}

function getWordAtPoint(
  clientX: number,
  clientY: number
): { word: string; rect: DOMRect } | null {
  const doc = document as CaretCapableDocument;

  let caretNode: Node | null = null;
  let caretOffset = 0;

  const pos = doc.caretPositionFromPoint?.(clientX, clientY);
  if (pos) {
    caretNode = pos.offsetNode;
    caretOffset = pos.offset;
  } else {
    const range = doc.caretRangeFromPoint?.(clientX, clientY);
    if (range) {
      caretNode = range.startContainer;
      caretOffset = range.startOffset;
    }
  }

  if (!caretNode) return null;

  const resolved = resolveTextPosition(caretNode, caretOffset);
  if (!resolved) return null;

  const text = resolved.node.textContent ?? '';
  const bounds = getWordBounds(text, resolved.offset);
  if (!bounds) return null;

  const range = document.createRange();
  range.setStart(resolved.node, bounds.start);
  range.setEnd(resolved.node, bounds.end);

  const rect = range.getBoundingClientRect();
  if (!rect || (rect.width === 0 && rect.height === 0)) return null;

  return { word: bounds.word, rect };
}

// ── component ──────────────────────────────────────────────────────────

export default function DictionaryTooltip({ containerRef }: DictionaryTooltipProps) {
  const [tooltip, setTooltip] = useState<TooltipData | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const tooltipRef = useRef<HTMLDivElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  // double-tap state kept in refs so the pointer handler never goes stale
  const lastTapRef = useRef<TapRecord | null>(null);
  const pressStartRef = useRef<{
    time: number;
    x: number;
    y: number;
    pointerId: number;
    moved: boolean;
  } | null>(null);

  // ── dismiss ──────────────────────────────────────────────────────────
  const dismiss = useCallback(() => {
    setTooltip(null);
    setLoading(false);
    setError('');
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  // ── fetch ────────────────────────────────────────────────────────────
  const fetchDefinition = useCallback(
    async (word: string, rect: DOMRect) => {
      const page = containerRef.current;
      if (!page) return;

      const clean = word.replace(/[^a-zA-Z'-]/g, '').toLowerCase();
      if (!clean || clean.length < 2 || clean.length > 40) return;

      abortRef.current?.abort();
      const controller = new AbortController();
      abortRef.current = controller;

      setLoading(true);
      setError('');

      const parentRect = page.getBoundingClientRect();
      const pad = 4;
      const available = parentRect.width - pad * 2;
      if (available <= 0) {
        setLoading(false);
        return;
      }

      const tipW = Math.min(320, available);
      const wordCX = rect.left + rect.width / 2 - parentRect.left;
      const wordTY = rect.top - parentRect.top;

      let tipX = wordCX - tipW / 2;
      tipX = Math.max(pad, Math.min(tipX, parentRect.width - tipW - pad));

      const arrowPad = Math.min(16, Math.max(8, tipW / 2));
      const arrowX = Math.max(
        arrowPad,
        Math.min(wordCX - tipX, tipW - arrowPad)
      );

      setTooltip({
        word: clean,
        definition: '',
        partOfSpeech: '',
        phonetic: '',
        x: tipX,
        y: wordTY,
        arrowX,
        width: tipW,
      });

      try {
        const res = await fetch(
          `https://api.dictionaryapi.dev/api/v2/entries/en/${clean}`,
          { signal: controller.signal }
        );

        if (!res.ok) {
          setError('No definition found');
          setLoading(false);
          return;
        }

        const data = await res.json();
        const entry = data?.[0];
        const meaning = entry?.meanings?.[0];
        const definition = meaning?.definitions?.[0]?.definition;
        const partOfSpeech = meaning?.partOfSpeech || '';
        const phonetic = entry?.phonetic || entry?.phonetics?.[0]?.text || '';

        if (!definition) {
          setError('No definition found');
          setLoading(false);
          return;
        }

        setTooltip({
          word: clean,
          definition,
          partOfSpeech,
          phonetic,
          x: tipX,
          y: wordTY,
          arrowX,
          width: tipW,
        });
        setLoading(false);
        setError('');
      } catch (err: any) {
        if (err?.name === 'AbortError') return;
        setError('Failed to fetch definition');
        setLoading(false);
      } finally {
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [containerRef]
  );

  // ── cleanup abort on unmount ─────────────────────────────────────────
  useEffect(() => () => abortRef.current?.abort(), []);

  // ── unified pointer-based double-tap detector ────────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const onPointerDown = (e: PointerEvent) => {
      if (isIgnoredTarget(e.target)) return;
      if (tooltipRef.current?.contains(e.target as Node)) return;

      pressStartRef.current = {
        time: Date.now(),
        x: e.clientX,
        y: e.clientY,
        pointerId: e.pointerId,
        moved: false,
      };
    };

    const onPointerMove = (e: PointerEvent) => {
      const start = pressStartRef.current;
      if (!start || start.pointerId !== e.pointerId) return;

      const dx = Math.abs(e.clientX - start.x);
      const dy = Math.abs(e.clientY - start.y);
      if (dx > TAP_MAX_MOVE || dy > TAP_MAX_MOVE) {
        start.moved = true;
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const start = pressStartRef.current;
      if (!start || start.pointerId !== e.pointerId) return;
      pressStartRef.current = null;

      // Was this press short and stationary enough to count as a "tap"?
      const duration = Date.now() - start.time;
      if (start.moved || duration > TAP_MAX_DURATION) {
        // Not a tap → reset the double-tap chain
        lastTapRef.current = null;
        return;
      }

      const thisTap: TapRecord = {
        time: Date.now(),
        x: e.clientX,
        y: e.clientY,
      };

      const prev = lastTapRef.current;

      if (prev) {
        const dt = thisTap.time - prev.time;
        const dist = Math.hypot(thisTap.x - prev.x, thisTap.y - prev.y);

        if (dt <= DOUBLE_TAP_MAX_DELAY && dist <= DOUBLE_TAP_MAX_DISTANCE) {
          // ✅ double-tap detected
          lastTapRef.current = null; // reset so triple-tap doesn't re-fire

          // Attempt to get the word at the pointer location
          const result = getWordAtPoint(e.clientX, e.clientY);
          if (result) {
            fetchDefinition(result.word, result.rect);
          }
          return;
        }
      }

      // First tap (or previous tap was too old / too far) — record it
      lastTapRef.current = thisTap;
    };

    const onPointerCancel = () => {
      pressStartRef.current = null;
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    container.addEventListener('pointercancel', onPointerCancel);

    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
      container.removeEventListener('pointercancel', onPointerCancel);
    };
  }, [containerRef, fetchDefinition]);

  // ── dismiss on outside interaction / scroll / resize / escape ────────
  useEffect(() => {
    if (!tooltip) return;

    const handleOutside = (e: Event) => {
      const target = e.target;
      if (!(target instanceof Node)) return;
      if (tooltipRef.current?.contains(target)) return;
      dismiss();
    };

    const handleScroll = () => dismiss();
    const handleResize = () => dismiss();
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };

    const scrollEl = containerRef.current?.closest('.main-content');

    // Small delay so the pointer-up that opened the tooltip doesn't
    // immediately close it via the outside-click listener
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', handleOutside);
    }, 150);

    scrollEl?.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('scroll', handleScroll, { passive: true });
    window.addEventListener('resize', handleResize, { passive: true });
    document.addEventListener('keydown', handleKey);

    return () => {
      clearTimeout(timer);
      document.removeEventListener('pointerdown', handleOutside);
      scrollEl?.removeEventListener('scroll', handleScroll);
      window.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleResize);
      document.removeEventListener('keydown', handleKey);
    };
  }, [tooltip, dismiss, containerRef]);

  // ── render ───────────────────────────────────────────────────────────
  if (!tooltip) return null;

  return (
    <div
      ref={tooltipRef}
      className="dict-tooltip"
      style={{
        left: tooltip.x,
        top: tooltip.y,
        width: tooltip.width,
        maxWidth: 'calc(100% - 6px)',
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
            type="button"
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
          <div className="dict-tooltip-error">{error}</div>
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