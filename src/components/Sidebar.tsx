import { useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom'; // Import NavLink and useNavigate
import type { Page } from '../types';
import type { Project } from '../services/db';

interface SidebarProps {
  isOpen: boolean;
  onClose: () => void;
  projects: Project[];
  onDeleteProject: (id: string) => void;
  onSelectProject: (project: Project) => void;
  activeProjectId: string | null;
}

// Notice the path field added to make routing clean
const navItems: { path: string; icon: string; label: string; desc: string; section: string }[] = [
  { path: '/', icon: '◈', label: 'Home', desc: 'Features & FAQ Overview', section: 'Main' },
  { path: '/recall', icon: '⟳', label: 'Active Recall', desc: 'Simplify & Memorize Content', section: 'Study Tools' },
  { path: '/quiz', icon: '✦', label: 'Document Quiz', desc: 'Upload & Test Your Knowledge', section: 'Study Tools' },
];

function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

function formatTimeAgo(timestamp: number): string {
  const seconds = Math.floor((Date.now() - timestamp) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  if (seconds < 604800) return `${Math.floor(seconds / 86400)}d ago`;
  return new Date(timestamp).toLocaleDateString();
}

function getStatusConfig(status: Project['status']): { label: string; color: string; icon: string } {
  switch (status) {
    case 'ready':
      return { label: 'Ready', color: 'var(--success)', icon: '✓' };
    case 'processing':
      return { label: 'Processing', color: 'var(--warning)', icon: '◐' };
    case 'error':
      return { label: 'Error', color: 'var(--error)', icon: '✗' };
    case 'pending':
    default:
      return { label: 'Pending', color: 'var(--text-muted)', icon: '○' };
  }
}

function getFileIcon(type: Project['type'], fileType?: string): string {
  if (type === 'text') return '📝';
  switch (fileType) {
    case 'pdf': return '📄';
    case 'docx': return '📃';
    case 'txt': return '📑';
    default: return '📁';
  }
}

export default function Sidebar({
  isOpen,
  onClose,
  projects,
  onDeleteProject,
  onSelectProject,
  activeProjectId
}: SidebarProps) {
  const [showAllProjects, setShowAllProjects] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const navigate = useNavigate(); // For programmatic navigation of local state project clicks

  const handleProjectClick = (project: Project) => {
    onSelectProject(project);
    onClose();
    
    // Programmatically push to the right tool viewport when loading an old project
    if (project.type === 'document') {
      navigate('/quiz');
    } else {
      navigate('/recall');
    }
  };

  const handleDelete = (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    if (confirmDelete === id) {
      onDeleteProject(id);
      setConfirmDelete(null);
    } else {
      setConfirmDelete(id);
      setTimeout(() => setConfirmDelete(null), 3000);
    }
  };

  const sections = navItems.reduce<Record<string, typeof navItems>>((acc, item) => {
    if (!acc[item.section]) acc[item.section] = [];
    acc[item.section].push(item);
    return acc;
  }, {});

  const displayedProjects = showAllProjects ? projects : projects.slice(0, 4);
  const hasMoreProjects = projects.length > 4;

  return (
    <>
      <div
        className={`sidebar-overlay ${isOpen ? 'visible' : ''}`}
        onClick={onClose}
      />
      <aside className={`sidebar ${isOpen ? 'open' : ''}`}>
        <div className="sidebar-header">
          <div className="sidebar-logo">
            <div className="sidebar-logo-icon">
              <svg xmlns="http://www.w3.org/2000/svg" width="30" height="30" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <path d="M10.8 12.8L12 10l1.2 2.8L16 14l-2.8 1.2L12 18l-1.2-2.8L8 14z"/>
              </svg>
            </div>
            <div className="sidebar-logo-text">
              <span className="sidebar-logo-brand">ExplaiNote AI</span>
              <span className="sidebar-logo-sub">Simplify · Recall · Master</span>
            </div>
          </div>
        </div>

        <nav className="sidebar-nav">
          {Object.entries(sections).map(([section, items]) => (
            <div key={section}>
              <div className="sidebar-section-label">{section}</div>
              {items.map((item) => (
                <NavLink
                  key={item.path}
                  to={item.path}
                  onClick={onClose}
                  // This cleanly merges your existing static active class name with React Router dynamic tracking
                  className={({ isActive }) => `sidebar-nav-item ${isActive ? 'active' : ''}`}
                >
                  <span className="nav-icon">{item.icon}</span>
                  <div className="nav-text">
                    <span className="nav-label">{item.label}</span>
                    <span className="nav-desc">{item.desc}</span>
                  </div>
                </NavLink>
              ))}
            </div>
          ))}

          {/* Projects Section */}
          <div className="sidebar-section-label">
            Recent Projects
            {projects.length > 0 && (
              <span className="projects-count">{projects.length}</span>
            )}
          </div>

          {projects.length === 0 ? (
            <div className="projects-empty">
              <span className="projects-empty-icon">📂</span>
              <span>No projects yet</span>
              <span className="projects-empty-hint">Upload a document or paste text to get started</span>
            </div>
          ) : (
            <div className="projects-list">
              {displayedProjects.map((project) => {
                const status = getStatusConfig(project.status);
                const icon = getFileIcon(project.type, project.fileType);
                const isActive = activeProjectId === project.id;

                return (
                  <div
                    key={project.id}
                    className={`project-item ${isActive ? 'active' : ''}`}
                    onClick={() => handleProjectClick(project)}
                    title={`Load "${project.name}"`}
                  >
                    <div className="project-icon">{icon}</div>
                    <div className="project-info">
                      <div className="project-name" title={project.name}>
                        {project.name}
                      </div>
                      <div className="project-meta">
                        {project.type === 'document' && project.fileSize && (
                          <span>{formatFileSize(project.fileSize)}</span>
                        )}
                        {project.type === 'text' && (
                          <span>Text</span>
                        )}
                        <span className="project-time">{formatTimeAgo(project.updatedAt)}</span>
                      </div>
                    </div>
                    <div className="project-status" style={{ color: status.color }} title={status.label}>
                      {status.icon}
                    </div>
                    <button
                      className={`project-delete ${confirmDelete === project.id ? 'confirm' : ''}`}
                      onClick={(e) => handleDelete(project.id, e)}
                      title={confirmDelete === project.id ? 'Click again to confirm' : 'Delete project'}
                    >
                      {confirmDelete === project.id ? '?' : '×'}
                    </button>
                  </div>
                );
              })}

              {hasMoreProjects && (
                <button
                  className="projects-toggle"
                  onClick={() => setShowAllProjects(!showAllProjects)}
                >
                  {showAllProjects
                    ? `Show less`
                    : `Show ${projects.length - 4} more`
                  }
                  <span className="toggle-chevron">{showAllProjects ? '▲' : '▼'}</span>
                </button>
              )}
            </div>
          )}
        </nav>

        <div className="sidebar-footer">
          <div className="sidebar-footer-info">
            <span>Powered by Gemini AI</span>
            <span className="pulse-dot-wrapper">
              <span className="pulse-dot" />
              <span className="pulse-ring" />
            </span>
          </div>
        </div>
      </aside>
    </>
  );
}