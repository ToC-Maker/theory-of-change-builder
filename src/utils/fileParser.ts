/**
 * File handling for chat uploads.
 *
 * Text-like files (txt, md, csv, json, xml, html, yaml, log, rtf) are read
 * client-side and the extracted text is passed to the model inline.
 *
 * PDFs are NOT parsed client-side. We perform a lightweight header validation
 * (size + page count) and return an upload-intent signal; the caller is
 * responsible for POSTing the binary to Anthropic's Files API and passing
 * the resulting file_id as a `document` content block.
 */

const MAX_PDF_BYTES = 20 * 1024 * 1024; // 20 MB
const MAX_PDF_PAGES = 100;
const PDF_HEADER_SCAN_BYTES = 500 * 1024; // 500 KB — enough to find the root /Pages tree in most PDFs

export type ParsedFile =
  // Text files: content is already extracted and ready to inline into the prompt.
  | { kind: 'text'; success: true; content: string; filename: string; sizeBytes: number }
  // PDFs: binary must be uploaded to the Files API by the caller.
  | {
      kind: 'upload';
      success: true;
      content: '';
      mimeType: 'application/pdf';
      filename: string;
      sizeBytes: number;
      pageCount: number;
    }
  // Any parse/validation failure.
  | { kind: 'error'; success: false; content: ''; error: string };

/**
 * Dispatch a file to the right handler based on extension/MIME type.
 */
export async function parseFile(file: File): Promise<ParsedFile> {
  const fileExtension = file.name.split('.').pop()?.toLowerCase();
  const isPdf = file.type === 'application/pdf' || fileExtension === 'pdf';

  try {
    if (isPdf) {
      const { pageCount, sizeBytes } = await validatePdf(file);
      return {
        kind: 'upload',
        success: true,
        content: '',
        mimeType: 'application/pdf',
        filename: file.name,
        sizeBytes,
        pageCount,
      };
    }

    switch (fileExtension) {
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

      default: {
        // Try to parse as text for unknown formats
        const result = await parseText(file);
        if (result.success && result.content.trim()) {
          return result;
        }
        return {
          kind: 'error',
          success: false,
          content: '',
          error: `Unsupported file format: .${fileExtension}`,
        };
      }
    }
  } catch (error) {
    return {
      kind: 'error',
      success: false,
      content: '',
      error: error instanceof Error ? error.message : 'Failed to parse file',
    };
  }
}

/**
 * Lightweight PDF validation without loading a PDF parser library.
 *
 * Enforces size and page-count caps by reading only the first ~500 KB of the
 * file and scanning for the root pages tree's `/Count` entry. This is a
 * heuristic (PDFs can have nested page trees, linearization dictionaries,
 * etc.), but it's good enough for an upfront sanity check — Anthropic's
 * Files API enforces its own ceilings as a backstop.
 *
 * Throws on: oversize file, or >MAX_PDF_PAGES pages detected.
 */
export async function validatePdf(
  file: File,
): Promise<{ pageCount: number; sizeBytes: number }> {
  const sizeBytes = file.size;
  if (sizeBytes > MAX_PDF_BYTES) {
    throw new Error(
      `PDF too large: ${(sizeBytes / 1024 / 1024).toFixed(1)} MB (max ${MAX_PDF_BYTES / 1024 / 1024} MB)`,
    );
  }

  const chunk = await file.slice(0, PDF_HEADER_SCAN_BYTES).arrayBuffer();
  // latin1 decodes each byte 1:1 so binary regions don't throw; we only look
  // for ASCII markers inside PDF dictionary syntax.
  const text = new TextDecoder('latin1').decode(chunk);

  // Prefer the page-tree root: /Type /Pages ... /Count N. Fall back to
  // counting individual /Type /Page markers within the scanned region, which
  // is a LOWER bound only (we're looking at the head of the file) — better
  // than rejecting a valid PDF outright; the Files API enforces real limits.
  const countMatch = text.match(/\/Type\s*\/Pages[^]*?\/Count\s+(\d+)/);
  const pageCount = countMatch
    ? parseInt(countMatch[1], 10)
    : (text.match(/\/Type\s*\/Page\b/g)?.length ?? 0);

  if (pageCount > MAX_PDF_PAGES) {
    throw new Error(
      `PDF has ${pageCount} pages; maximum is ${MAX_PDF_PAGES}. Split into chapters.`,
    );
  }

  return { pageCount, sizeBytes };
}

/**
 * Parse text-based files
 */
async function parseText(file: File): Promise<ParsedFile> {
  try {
    const content = await file.text();

    if (!content || content.length === 0) {
      return {
        kind: 'error',
        success: false,
        content: '',
        error: 'File appears to be empty',
      };
    }

    // Reject files that look like binary masquerading as text (>10%
    // non-printable characters).
    const nonPrintableCount = (content.match(/[\x00-\x08\x0E-\x1F\x7F-\x9F]/g) || []).length;
    const isProbablyBinary = nonPrintableCount / content.length > 0.1;

    if (isProbablyBinary) {
      return {
        kind: 'error',
        success: false,
        content: '',
        error: 'File appears to contain binary data and cannot be parsed as text',
      };
    }

    return {
      kind: 'text',
      success: true,
      content,
      filename: file.name,
      sizeBytes: file.size,
    };
  } catch (error) {
    return {
      kind: 'error',
      success: false,
      content: '',
      error: `Failed to read file: ${error instanceof Error ? error.message : 'Unknown error'}`,
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
    rtf: 'Rich Text Format',
  };

  return typeMap[extension || ''] || 'Unknown Format';
}
