/** Rectangle occupied by the source pixels, including contain/cover scaling. */
export function getVideoContentRect(video) {
  const rect = video.getBoundingClientRect();
  const width = Number(video.videoWidth), height = Number(video.videoHeight);
  if (!width || !height || !rect.width || !rect.height) return rect;
  const fit = video.style?.objectFit || (typeof getComputedStyle === 'function' ? getComputedStyle(video).objectFit : '') || 'contain';
  if (fit !== 'contain' && fit !== 'cover') return rect;
  const scale = fit === 'cover' ? Math.max(rect.width / width, rect.height / height) : Math.min(rect.width / width, rect.height / height);
  const contentWidth = width * scale, contentHeight = height * scale;
  return { left: rect.left + (rect.width - contentWidth) / 2, top: rect.top + (rect.height - contentHeight) / 2,
    width: contentWidth, height: contentHeight };
}

export function containsPoint(rect, x, y) {
  return rect.width > 0 && rect.height > 0 && x >= rect.left && x <= rect.left + rect.width && y >= rect.top && y <= rect.top + rect.height;
}
