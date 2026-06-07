import mammoth from 'mammoth';
import * as pdfjsLib from 'pdfjs-dist';

// ✅ This is the correct way to reference the worker in Vite
// The file is served from /public folder as a static asset
const PDFJS_VERSION = pdfjsLib.version;

// ✅ Set worker ONCE at module level, not inside the function
pdfjsLib.GlobalWorkerOptions.workerSrc = `/pdf.worker.min.mjs`;

export async function parseFile(file: File): Promise<string> {
  const ext = file.name.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'txt':
      return await file.text();

    case 'docx':
      return await parseDocx(file);

    case 'pdf':
      return await parsePdf(file);

    default:
      throw new Error(
        `Unsupported file type: .${ext}. Please upload .txt, .docx, or .pdf files.`
      );
  }
}

async function parseDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });

  if (!result.value || result.value.trim().length === 0) {
    throw new Error(
      'Could not extract text from the DOCX file. The file might be empty or corrupted.'
    );
  }

  return result.value;
}

async function parsePdf(file: File): Promise<string> {
  try {
    const arrayBuffer = await file.arrayBuffer();

    const loadingTask = pdfjsLib.getDocument({
      data: new Uint8Array(arrayBuffer),
    });

    const pdf = await loadingTask.promise;
    const textParts: string[] = [];

    for (let i = 1; i <= pdf.numPages; i++) {
      const page = await pdf.getPage(i);
      const textContent = await page.getTextContent();

      const pageText = textContent.items
        .filter((item: any) => 'str' in item)
        .map((item: any) => item.str)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();

      if (pageText) {
        textParts.push(pageText);
      }
    }

    const fullText = textParts.join('\n\n');

    if (!fullText.trim()) {
      throw new Error(
        'Could not extract text from the PDF. It might be image-based or empty.'
      );
    }

    return fullText;

  } catch (error: any) {
    // Re-throw our own clean errors
    if (error.message?.includes('Could not extract')) {
      throw error;
    }

    if (error.name === 'InvalidPDFException') {
      throw new Error('The file appears to be an invalid or corrupted PDF.');
    }

    if (error.name === 'PasswordException') {
      throw new Error(
        'This PDF is password protected. Please remove the password and try again.'
      );
    }

    throw new Error(
      `Failed to parse PDF: ${error.message || 'Unknown error occurred'}`
    );
  }
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}