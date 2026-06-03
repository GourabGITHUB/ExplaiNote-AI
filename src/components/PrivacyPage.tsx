// src/components/PrivacyPage.tsx
export default function PrivacyPage() {
  return (
    <div className="page-container" style={{ maxWidth: '800px', margin: '0 auto', padding: '2rem' }}>
      <h1>Privacy Policy</h1>
      <p style={{ color: 'var(--text-muted)' }}>Last updated: June 2026</p>
      
      <hr style={{ border: '0', borderTop: '1px solid var(--border)', margin: '2rem 0' }} />

      <h2>1. Data Ownership & Storage</h2>
      <p>
        At ExplaiNote AI, your study materials belong entirely to you. Your uploaded documents, pasted notes, 
        and generated study materials (quizzes, flashcards, and summaries) are stored locally inside your own 
        browser using <strong>IndexedDB</strong>. We do not operate a database server, and your content is 
        never saved or retained by us.
      </p>

      <h2>2. Third-Party AI Processing</h2>
      <p>
        To generate summaries, flashcards, and quizzes, your content is transmitted directly to 
        <strong>Google Gemini AI API</strong>. This data transmission is governed by Google's AI Studio 
        Terms of Service. Your data is sent securely to Google's endpoints and is processed to return your 
        study outputs.
      </p>

      <h2>3. API Keys</h2>
      <p>
        Any API keys you provide to utilize the application are stored strictly within your browser's local session 
        memory. They are never sent to our servers, never shared with third parties, and are only transmitted 
        directly to Google to authorize your AI requests.
      </p>

      <h2>4. Cookies & Analytics</h2>
      <p>
        We may use minimal local storage tokens or basic analytics to monitor site uptime and performance. 
        No personally identifiable information is tracked or collected during this process.
      </p>

      <h2>5. Changes to This Policy</h2>
      <p>
        Because all application data lives entirely on your local browser, any future changes to this policy 
        will be updated directly on this page. If you have questions about how your data is handled, you can 
        reach out via our repository or support channels.
      </p>
    </div>
  );
}
