import { useState } from 'react';
import { hasEnvKey } from '../services/apiKey';

interface ApiKeyInputProps {
  apiKey: string;
  onApiKeyChange: (key: string) => void;
}

export default function ApiKeyInput({ apiKey, onApiKeyChange }: ApiKeyInputProps) {
  const [visible, setVisible] = useState(false);
  const envKeyAvailable = hasEnvKey();

  return (
    <div className="api-key-section">
      <label>
        🔑 Gemini API Key
        <span className="api-key-optional">optional</span>
      </label>
      <input
        type={visible ? 'text' : 'password'}
        autoComplete="new-password"
        className="api-key-input"
        placeholder={envKeyAvailable ? 'Using default key — override here...' : 'Enter your Gemini API key...'}
        value={apiKey}
        onChange={(e) => onApiKeyChange(e.target.value)}
      />
      <button
        className="btn btn-sm btn-secondary"
        onClick={() => setVisible(!visible)}
        type="button"
      >
        {visible ? '🙈 Hide' : '👁️ Show'}
      </button>
      {apiKey.trim() ? (
        <span className="api-key-status set">✓ Custom key</span>
      ) : envKeyAvailable ? (
        <span className="api-key-status env">✓ Default key</span>
      ) : (
        <span className="api-key-status unset">No key set</span>
      )}
    </div>
  );
}
