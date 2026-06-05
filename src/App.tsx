// src/App.tsx
import { useState, useEffect, useCallback } from 'react';
import { BrowserRouter, Routes, Route, useLocation } from 'react-router-dom';
import Sidebar from './components/Sidebar';
import HomePage from './components/HomePage';
import RecallPage from './components/RecallPage';
import QuizPage from './components/QuizPage';
import PrivacyPage from './components/PrivacyPage';
import { getAllProjects, deleteProject, getProject, type Project } from './services/db';
import TallyFeedbackButton from "./components/FeedBackBtn";

function AppContent() {
  const location = useLocation();
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [apiKey, setApiKey] = useState('');
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProjectId, setActiveProjectId] = useState<string | null>(null);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
const showFeedback = location.pathname == "/";
  const loadProjects = useCallback(async () => {
    try {
      const loadedProjects = await getAllProjects();
      setProjects(loadedProjects);
    } catch (err) {
      console.error('Failed to load projects:', err);
    }
  }, []);

  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Reset active project context if the user drops back to the Home dashboard
  useEffect(() => {
    if (location.pathname === '/') {
      setActiveProjectId(null);
    }
  }, [location.pathname]);

  // When activeProjectId changes, load the full project
  useEffect(() => {
    if (!activeProjectId) {
      setActiveProject(null);
      return;
    }
    (async () => {
      try {
        const p = await getProject(activeProjectId);
        setActiveProject(p);
      } catch {
        setActiveProject(null);
      }
    })();
  }, [activeProjectId]);

  const handleDeleteProject = async (id: string) => {
    try {
      await deleteProject(id);
      setProjects(prev => prev.filter(p => p.id !== id));
      if (activeProjectId === id) {
        setActiveProjectId(null);
      }
    } catch (err) {
      console.error('Failed to delete project:', err);
    }
  };

  const handleSelectProject = (project: Project) => {
    setActiveProjectId(project.id);
    setSidebarOpen(false);
  };

  return (
    <div className="app-layout">
      <Sidebar
        isOpen={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        projects={projects}
        onDeleteProject={handleDeleteProject}
        onSelectProject={handleSelectProject}
        activeProjectId={activeProjectId}
      />

      <div className="mobile-header">
        <button className="hamburger-btn" onClick={() => setSidebarOpen(true)}>
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="3" y1="6" x2="21" y2="6"/>
            <line x1="3" y1="12" x2="17" y2="12"/>
            <line x1="3" y1="18" x2="21" y2="18"/>
          </svg>
        </button>
        <span className="mobile-logo">ExplaiNote AI</span>
      </div>

      <main className="main-content">
        <Routes>
          <Route path="/" element={<HomePage />} />
          <Route
            path="/recall"
            element={
              <RecallPage
                apiKey={apiKey}
                onApiKeyChange={setApiKey}
                onProjectUpdate={loadProjects}
                activeProject={activeProject}
                onClearProject={() => setActiveProjectId(null)}
              />
            }
          />
          <Route
            path="/quiz"
            element={
              <QuizPage
                apiKey={apiKey}
                onApiKeyChange={setApiKey}
                onProjectUpdate={loadProjects}
                activeProject={activeProject}
                onClearProject={() => setActiveProjectId(null)}
              />
            }
          />
          {/* Fallback configuration */}
          <Route path="*" element={<HomePage />} />

{/* Add this inside your <Routes> stack in App.tsx */}
<Route path="/privacy" element={<PrivacyPage />} />
        </Routes>
      </main>
      {showFeedback && (
  <TallyFeedbackButton formId="dWzxAK" />
)}

    </div>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppContent />
    </BrowserRouter>
  );
}