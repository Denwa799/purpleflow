// Картинка или видео в диффе: было и стало рядом (новый или удалённый файл — одна версия). Байты приходят из ядра,
// показываем через blob-URL — CSP окна пускает видео только так.
import { useEffect, useState } from 'react';
import type { DiffFile, DiffMedia } from '@purpleflow/core';

function useBlobUrl(data: Uint8Array | undefined, mime: string): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!data) return setUrl(null);
    const u = URL.createObjectURL(new Blob([data as BlobPart], { type: mime }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [data, mime]);
  return url;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} МБ` : n >= 1024 ? `${Math.round(n / 1024)} КБ` : `${n} Б`);

function Side({ label, data, mime, path }: { label: string; data?: Uint8Array; mime: string; path: string }) {
  const url = useBlobUrl(data, mime);
  const [dims, setDims] = useState<string | null>(null);
  if (!data || !url) return null;
  const video = mime.startsWith('video/');
  return (
    <figure className="diff-media-side">
      <div className="diff-media-frame">
        {video ? (
          <video
            src={url}
            controls
            muted
            playsInline
            aria-label={`${path} — ${label}`}
            onLoadedMetadata={(e) => setDims(`${e.currentTarget.videoWidth}×${e.currentTarget.videoHeight}`)}
          />
        ) : (
          <img
            src={url}
            alt={`${path} — ${label}`}
            onLoad={(e) => setDims(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
          />
        )}
      </div>
      <figcaption>
        <strong>{label}</strong>
        <span className="muted">
          {dims ? `${dims} · ` : ''}
          {kb(data.length)}
        </span>
      </figcaption>
    </figure>
  );
}

export function DiffMediaView({ file, media }: { file: DiffFile; media: DiffMedia }) {
  const both = Boolean(media.original && media.modified);
  return (
    <div className={`diff-media ${both ? 'is-pair' : ''}`}>
      {media.original && <Side label={file.status === 'D' ? 'Удалено' : 'Было'} data={media.original} mime={media.mime} path={file.path} />}
      {media.modified && (
        <Side label={file.status === 'A' ? 'Новый файл' : 'Стало'} data={media.modified} mime={media.mime} path={file.path} />
      )}
      {media.tooLarge && (
        <p className="diff-binary">
          {both || media.original || media.modified
            ? 'Одна из версий слишком большая — не показана.'
            : 'Файл слишком большой для просмотра в диффе.'}
        </p>
      )}
    </div>
  );
}
