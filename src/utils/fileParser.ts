import * as pdfjsLib from 'pdfjs-dist';

// Import the worker as a URL to avoid build issues
// @ts-ignore
import pdfjsWorker from 'pdfjs-dist/build/pdf.worker.min?url';

// Configure worker for pdfjs
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfjsWorker;

export interface ParsedFile {
  content: string;
  success: boolean;
  error?: string;
}

/**
 * Parse a file and extract its text content
 * Supports PDF, TXT, MD, CSV and other text formats
 */
export async function parseFile(file: File): Promise<ParsedFile> {
  const fileExtension = file.name.split('.').pop()?.toLowerCase();

  try {
    switch (fileExtension) {
      case 'pdf':
        return await parsePDF(file);

      case 'txt':
      case 'md':
      case 'markdown':
      case 'csv':
      case 'json':
      case 'xml':
      case 'html':
      case 'htm':
      case 'yaml':
      case 'yml':
      case 'log':
      case 'rtf':
        return await parseText(file);

      default:
        // Try to parse as text for unknown formats
        const result = await parseText(file);
        if (result.success && result.content.trim()) {
          return result;
        }
        return {
          content: '',
          success: false,
          error: `Unsupported file format: .${fileExtension}`
        };
    }
  } catch (error) {
    return {
      content: '',
      success: false,
      error: error instanceof Error ? error.message : 'Failed to parse file'
    };
  }
}

/**
 * Parse PDF file and extract text content
 */
async function parsePDF(file: File): Promise<ParsedFile> {
  try {
    const arrayBuffer = await file.arrayBuffer();
    const pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;

    let fullText = '';
    const numPages = pdf.numPages;

    // Extract text from each page
    for (let pageNum = 1; pageNum <= numPages; pageNum++) {
      const page = await pdf.getPage(pageNum);
      const textContent = await page.getTextContent();

      // Concatenate text items with proper spacing
      const pageText = textContent.items
        .map((item: any) => item.str)
        .join(' ');

      fullText += pageText + '\n\n';
    }

    // Clean up excessive whitespace
    fullText = fullText
      .replace(/\s+/g, ' ')  // Replace multiple spaces with single space
      .replace(/\n{3,}/g, '\n\n')  // Replace multiple newlines with double newline
      .trim();

    return {
      content: fullText,
      success: true
    };
  } catch (error) {
    console.error('PDF parsing error:', error);
    return {
      content: '',
      success: false,
      error: `Failed to parse PDF: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Parse text-based files
 */
async function parseText(file: File): Promise<ParsedFile> {
  try {
    const content = await file.text();

    // Basic validation to ensure we got readable text
    if (!content || content.length === 0) {
      return {
        content: '',
        success: false,
        error: 'File appears to be empty'
      };
    }

    // Check if content appears to be binary (high percentage of non-printable characters)
    const nonPrintableCount = (content.match(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g) || []).length;
    const isProbablyBinary = (nonPrintableCount / content.length) > 0.1;

    if (isProbablyBinary) {
      return {
        content: '',
        success: false,
        error: 'File appears to contain binary data and cannot be parsed as text'
      };
    }

    return {
      content: content,
      success: true
    };
  } catch (error) {
    return {
      content: '',
      success: false,
      error: `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`
    };
  }
}

/**
 * Get a user-friendly file type description
 */
export function getFileTypeDescription(filename: string): string {
  const extension = filename.split('.').pop()?.toLowerCase();

  const typeMap: Record<string, string> = {
    pdf: 'PDF Document',
    txt: 'Text File',
    md: 'Markdown',
    markdown: 'Markdown',
    csv: 'CSV Spreadsheet',
    json: 'JSON Data',
    xml: 'XML Document',
    html: 'HTML Document',
    htm: 'HTML Document',
    yaml: 'YAML Configuration',
    yml: 'YAML Configuration',
    log: 'Log File',
    rtf: 'Rich Text Format'
  };

  return typeMap[extension || ''] || 'Unknown Format';
}