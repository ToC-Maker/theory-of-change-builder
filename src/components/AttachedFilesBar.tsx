import React, { useCallback, useMemo, useRef, useState } from 'react';
import { XMarkIcon, ArrowPathIcon } from '@heroicons/react/24/outline';

export type AttachedFileStatus = 'uploading' | 'ready' | 'error';

export interface AttachedFile {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes?: number;
  status: AttachedFileStatus;
  progress?: number; // 0-100 while status === 'uploading'
  error?: string;
}

export interface AttachedFilesBarProps {
  files: AttachedFile[];
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
  onDropFiles?: (files: File[]) => void;
  className?: string;
}

const TRUNCATE_AT = 20;

function truncateFilename(name: string): string {
  if (name.length <= TRUNCATE_AT) return name;
  return `${name.slice(0, TRUNCATE_AT - 1)}…`;
}

function formatSize(bytes?: number): string | null {
  if (bytes == null || bytes <= 0) return null;
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const decimals = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(decimals)} ${units[unit]}`;
}

function iconForMime(mime: string, filename: string): string {
  const lower = (mime || '').toLowerCase();
  const ext = filename.toLowerCase().split('.').pop() ?? '';
  if (lower === 'application/pdf' || ext === 'pdf') return '📄';
  if (lower.startsWith('text/markdown') || ext === 'md' || ext === 'markdown') return '📝';
  if (lower.startsWith('text/plain') || ext === 'txt') return '📝';
  if (
    lower.includes('csv') ||
    lower.includes('json') ||
    lower.includes('xml') ||
    ext === 'csv' ||
    ext === 'json' ||
    ext === 'xml'
  ) {
    return '📊';
  }
  return '📎';
}

/**
 * File chip row for the composer. Displays inline chips for each attached
 * file with upload progress / error affordances, and optionally acts as a
 * drop target when `onDropFiles` is provided.
 *
 * Renders `null` when there are no files AND no `onDropFiles` handler, so
 * the composer lays out naturally. When `onDropFiles` is provided the bar
 * stays mounted even with zero files so it can receive drag events and
 * surface the "Drop files to attach" overlay.
 */
export function AttachedFilesBar({
  files,
  onRemove,
  onRetry,
  onDropFiles,
  className,
}: AttachedFilesBarProps) {
  const [isDragging, setIsDragging] = useState(false);
  // `dragDepth` counts enter vs leave events so that hovering over a child
  // doesn't flip `isDragging` off (dragenter fires on each child). We use a
  // ref rather than state since the value only drives an imperative branch
  // in the leave handler.
  const dragDepthRef = useRef(0);

  const acceptsDrop = Boolean(onDropFiles);

  const handleDragEnter = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!acceptsDrop) return;
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      dragDepthRef.current += 1;
      setIsDragging(true);
    },
    [acceptsDrop]
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!acceptsDrop) return;
      if (!Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    [acceptsDrop]
  );

  const handleDragLeave = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!acceptsDrop) return;
      e.preventDefault();
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) setIsDragging(false);
    },
    [acceptsDrop]
  );

  const handleDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      if (!acceptsDrop || !onDropFiles) return;
      e.preventDefault();
      dragDepthRef.current = 0;
      setIsDragging(false);
      const dropped = Array.from(e.dataTransfer.files ?? []);
      if (dropped.length > 0) onDropFiles(dropped);
    },
    [acceptsDrop, onDropFiles]
  );

  const liveStatus = useMemo(() => {
    const uploading = files.filter((f) => f.status === 'uploading').length;
    const failed = files.filter((f) => f.status === 'error').length;
    if (uploading > 0) {
      return `Uploading ${uploading} file${uploading === 1 ? '' : 's'}`;
    }
    if (failed > 0) {
      return `${failed} upload${failed === 1 ? '' : 's'} failed`;
    }
    return '';
  }, [files]);

  // When no files are attached and the component doesn't accept drops, render
  // nothing so the parent composer lays out naturally. When `onDropFiles` is
  // provided we must stay mounted so we can receive drag events even with
  // zero files.
  if (files.length === 0 && !acceptsDrop) return null;

  const wrapperClass = [
    'relative flex flex-col gap-2',
    files.length === 0 ? 'min-h-[2rem]' : '',
    className ?? '',
  ]
    .filter(Boolean)
    .join(' ');

  const failedFiles = files.filter((f) => f.status === 'error' && f.error);

  return (
    <div
      className={wrapperClass}
      onDragEnter={acceptsDrop ? handleDragEnter : undefined}
      onDragOver={acceptsDrop ? handleDragOver : undefined}
      onDragLeave={acceptsDrop ? handleDragLeave : undefined}
      onDrop={acceptsDrop ? handleDrop : undefined}
    >
      <div className="flex flex-wrap items-center gap-2">
        {files.map((file) => (
          <FileChip
            key={file.id}
            file={file}
            onRemove={onRemove}
            onRetry={onRetry}
          />
        ))}
      </div>

      {/* Full error text lives outside the chip so long messages wrap
          naturally — chips stay compact; users still see the whole
          message (no "Anthropic limits PDFs to 600 pag…" cut-off). */}
      {failedFiles.length > 0 && (
        <ul className="flex flex-col gap-1 text-xs text-red-800 bg-red-50 border border-red-200 rounded px-2 py-1.5">
          {failedFiles.map((file) => (
            <li key={file.id} className="leading-snug">
              <span className="font-medium">{file.filename}:</span>{' '}
              <span className="font-normal">{file.error}</span>
            </li>
          ))}
        </ul>
      )}

      <span className="sr-only" aria-live="polite" aria-atomic="true">
        {liveStatus}
      </span>

      {acceptsDrop && isDragging && (
        <div
          className="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg border-2 border-dashed border-blue-500 bg-blue-100/90 text-sm font-medium text-blue-800"
          aria-hidden
        >
          Drop files to attach
        </div>
      )}
    </div>
  );
}

interface FileChipProps {
  file: AttachedFile;
  onRemove?: (id: string) => void;
  onRetry?: (id: string) => void;
}

function FileChip({ file, onRemove, onRetry }: FileChipProps) {
  const icon = iconForMime(file.mimeType, file.filename);
  const size = formatSize(file.sizeBytes);
  const truncated = truncateFilename(file.filename);
  const canRemove = Boolean(onRemove) && file.status !== 'uploading';

  const baseClass =
    'group inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-sm border transition-colors';
  const statusClass =
    file.status === 'error'
      ? 'bg-red-50 border-red-200 text-red-800'
      : file.status === 'uploading'
      ? 'bg-gray-100 border-gray-200 text-gray-700'
      : 'bg-gray-100 border-gray-200 text-gray-800';

  return (
    <span
      className={`${baseClass} ${statusClass}`}
      title={file.filename}
      data-status={file.status}
    >
      <span aria-hidden className="text-base leading-none">
        {icon}
      </span>
      <span className="max-w-[14rem] truncate">{truncated}</span>
      {size && file.status === 'ready' && (
        <span className="text-xs text-gray-500">{size}</span>
      )}

      {file.status === 'uploading' && (
        <UploadIndicator progress={file.progress} />
      )}

      {file.status === 'error' && (
        <span className="flex items-center gap-1.5">
          <span
            className="inline-block w-1.5 h-1.5 rounded-full bg-red-500"
            aria-hidden
          />
          {/* Error text moved out of the chip — see the list below the
              chip row. Keeping the chip compact lets long error messages
              wrap naturally instead of truncating with ellipsis. */}
          {onRetry && (
            <button
              type="button"
              onClick={() => onRetry(file.id)}
              className="inline-flex items-center gap-0.5 text-xs font-medium text-red-700 hover:text-red-900 focus:outline-none focus:underline"
              aria-label={`Retry upload of ${file.filename}`}
            >
              <ArrowPathIcon className="w-3 h-3" aria-hidden />
              Retry
            </button>
          )}
        </span>
      )}

      {canRemove && (
        <button
          type="button"
          onClick={() => onRemove?.(file.id)}
          className="ml-0.5 rounded-full p-0.5 text-gray-500 hover:text-gray-900 hover:bg-gray-200 opacity-0 group-hover:opacity-100 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-gray-400 transition-opacity"
          aria-label={`Remove ${file.filename}`}
        >
          <XMarkIcon className="w-3.5 h-3.5" aria-hidden />
        </button>
      )}
    </span>
  );
}

interface UploadIndicatorProps {
  progress?: number;
}

function UploadIndicator({ progress }: UploadIndicatorProps) {
  const clamped =
    typeof progress === 'number' ? Math.max(0, Math.min(100, progress)) : undefined;
  return (
    <span
      className="inline-flex items-center gap-1 text-xs text-gray-500"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <span
        className="w-3 h-3 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"
        aria-hidden
      />
      {clamped !== undefined ? `${Math.round(clamped)}%` : null}
    </span>
  );
}

export default AttachedFilesBar;
