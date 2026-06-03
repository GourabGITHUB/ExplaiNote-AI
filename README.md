ExplaiNote AI
An elegant, privacy-first, Single Page Application (SPA) designed to transform complex study materials into clear explanations, interactive quizzes, and active-recall flashcards. Powered natively by Google Gemini AI directly inside the client layer.

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
