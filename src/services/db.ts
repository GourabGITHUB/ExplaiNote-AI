// IndexedDB Service for persisting projects/documents

const DB_NAME = 'explainote-db';
const DB_VERSION = 2;
const STORE_NAME = 'projects';

export interface Project {
  id: string;
  name: string;
  type: 'document' | 'text';
  status: 'ready' | 'processing' | 'error' | 'pending';
  fileType?: string;
  fileSize?: number;
  textPreview?: string;
  createdAt: number;
  updatedAt: number;
  // For text projects: the raw pasted text
  content?: string;
  // For documents: file data as base64
  fileData?: string;
  // Parsed/extracted plain text from the document (avoids re-parsing)
  parsedText?: string;
}

let dbInstance: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    if (dbInstance) {
      resolve(dbInstance);
      return;
    }

    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onerror = () => {
      reject(new Error('Failed to open IndexedDB'));
    };

    request.onsuccess = () => {
      dbInstance = request.result;
      resolve(dbInstance);
    };

    request.onupgradeneeded = (event) => {
      const db = (event.target as IDBOpenDBRequest).result;

      if (!db.objectStoreNames.contains(STORE_NAME)) {
        const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
        store.createIndex('createdAt', 'createdAt', { unique: false });
        store.createIndex('type', 'type', { unique: false });
      }
      // v2 doesn't add new indexes — parsedText is just a new field on the object
    };
  });
}

export async function saveProject(project: Project): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.put(project);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Failed to save project'));
  });
}

export async function getProject(id: string): Promise<Project | null> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.get(id);

    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(new Error('Failed to get project'));
  });
}

export async function getAllProjects(): Promise<Project[]> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readonly');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.getAll();

    request.onsuccess = () => {
      const projects = request.result || [];
      projects.sort((a, b) => b.updatedAt - a.updatedAt);
      resolve(projects);
    };
    request.onerror = () => reject(new Error('Failed to get projects'));
  });
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.delete(id);

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Failed to delete project'));
  });
}

export async function updateProjectStatus(id: string, status: Project['status']): Promise<void> {
  const project = await getProject(id);
  if (project) {
    project.status = status;
    project.updatedAt = Date.now();
    await saveProject(project);
  }
}

export async function updateProjectParsedText(id: string, parsedText: string): Promise<void> {
  const project = await getProject(id);
  if (project) {
    project.parsedText = parsedText;
    project.updatedAt = Date.now();
    await saveProject(project);
  }
}

export async function clearAllProjects(): Promise<void> {
  const db = await openDB();

  return new Promise((resolve, reject) => {
    const transaction = db.transaction(STORE_NAME, 'readwrite');
    const store = transaction.objectStore(STORE_NAME);

    const request = store.clear();

    request.onsuccess = () => resolve();
    request.onerror = () => reject(new Error('Failed to clear projects'));
  });
}

export function generateId(): string {
  return `${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

// Create a project from a file (stores base64 data)
export async function createProjectFromFile(file: File): Promise<Project> {
  const id = generateId();
  const now = Date.now();

  const fileData = await new Promise<string>((resolve) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.readAsDataURL(file);
  });

  const project: Project = {
    id,
    name: file.name,
    type: 'document',
    status: 'pending',
    fileType: file.name.split('.').pop()?.toLowerCase(),
    fileSize: file.size,
    createdAt: now,
    updatedAt: now,
    fileData
  };

  await saveProject(project);
  return project;
}

// Create a project from pasted text
export async function createProjectFromText(text: string, title?: string): Promise<Project> {
  const id = generateId();
  const now = Date.now();

  const preview = text.substring(0, 100).replace(/\s+/g, ' ').trim();

  const project: Project = {
    id,
    name: title || `Text ${new Date().toLocaleDateString()}`,
    type: 'text',
    status: 'pending',
    textPreview: preview + (text.length > 100 ? '...' : ''),
    createdAt: now,
    updatedAt: now,
    content: text,
    // For text projects, parsedText is the same as content
    parsedText: text
  };

  await saveProject(project);
  return project;
}

// Restore a File object from stored project (for display purposes)
export async function getFileFromProject(project: Project): Promise<File | null> {
  if (project.type !== 'document' || !project.fileData) {
    return null;
  }

  try {
    const response = await fetch(project.fileData);
    const blob = await response.blob();
    return new File([blob], project.name, { type: blob.type });
  } catch {
    return null;
  }
}
