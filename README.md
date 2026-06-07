ExplaiNote AI 🧠

An intelligent active-recall and study-optimization platform that transforms dense learning material into structured summaries, interactive quizzes, and automated flashcards using Gemini 2.5 Flash.

🔗 https://explainote-ai.pages.dev

🚀 Key Features
Active Recall Studio: Input text passages to generate Feynman-style simplified summaries, key concepts, retrieval prompts, and layered flashcards.

Hierarchical Document Quiz: Upload documents (.pdf, .docx, .txt) to generate comprehensive, progressive quizzes (Multiple Choice, Short Answer, True/False).

Privacy-First Architecture: Your API key and content are processed in-session or stored locally on your device—no external app database server required.

Edge SEO Optimized: Uses serverless routing and dynamic meta-tag re-injection at the CDN layer for instantaneous search engine discoverability.

🛠️ The Tech Stack
Frontend Ecosystem: React 18, TypeScript, Vite

Client Navigation: React Router DOM (Declarative URL-based paths)

Local Storage Layer: IndexedDB (via native helper services)

AI Engine: Google Gemini API

Hosting & Serverless: Cloudflare Pages & Cloudflare Workers (HTMLRewriter middleware).


### Brief Architecture Breakdown

* **State & Routing:** Uses a single-page architecture built with **React, TypeScript, and Vite**, utilizing structural semantic elements (`<Link>`, `<button>`, `<svg>`) to ensure clean accessibility and optimized performance.
* **The AI Engine (`ai.ts`):** Orchestrates direct context extraction using **Gemini 2.5 Flash** models with aggressive failure mitigation including automated JSON repair string transforms (`stripRogueCharacters`, `fixUnescapedQuotes`), deduplication checks, and throttled queue streaming.
* **Storage Framework:** Integrates standard IndexedDB transactional layers to cache heavy structural JSON payloads client-side with a strict 24-hour expiration mechanism.
* **Target Cloud Environment:** Designed to map to Cloudflare Pages via atomic edge assets (`dist/`), consuming keys locally to eliminate standard relational databases or heavy middleware backends.

🛠️ Local Development

git clone https://github.com/gourabGITHUB/explainote-ai.git
cd explainote-ai

npm install

Create a .dev.vars file in the root directory for local backend testing:
VITE_GEMINI_API_KEY=your_api_key_here

# Terminal 1: Build & Watch
npm run build -- --watch

# Terminal 2: Edge Emulator
npx wrangler pages dev dist