import mammoth from 'mammoth';

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
      throw new Error(`Unsupported file type: .${ext}. Please upload .txt, .docx, or .pdf files.`);
  }
}

async function parseDocx(file: File): Promise<string> {
  const arrayBuffer = await file.arrayBuffer();
  const result = await mammoth.extractRawText({ arrayBuffer });
  if (!result.value || result.value.trim().length === 0) {
    throw new Error('Could not extract text from the DOCX file. The file might be empty or corrupted.');
  }
  return result.value;
}

async function parsePdf(file: File): Promise<string> {
  const pdfjsLib = await import('pdfjs-dist');

  // Set worker source
  pdfjsLib.GlobalWorkerOptions.workerSrc = `https://cdnjs.cloudflare.com/ajax/libs/pdf.js/${pdfjsLib.version}/pdf.worker.min.mjs`;

  const arrayBuffer = await file.arrayBuffer();
  const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

  const textParts: string[] = [];

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .map((item: any) => item.str)
      .join(' ');
    textParts.push(pageText);
  }

  const fullText = textParts.join('\n\n');
  if (!fullText.trim()) {
    throw new Error('Could not extract text from the PDF. It might be image-based or empty.');
  }
  return fullText;
}

export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
