export function renderMetadata(element, item, { duration = false } = {}) {
  element.replaceChildren();
  const add = (value, className = '') => {
    const span = element.ownerDocument.createElement('span');
    span.className = className;
    span.textContent = String(value);
    element.append(span);
  };
  if (item.year) add(item.year);
  if (duration && item.duration) add(`${item.duration}m`);
  if (item.contentRating) add(item.contentRating, 'badge');
  if (item.audienceRating && Number.isFinite(Number(item.audienceRating))) add(Number(item.audienceRating).toFixed(1), 'rating');
}
