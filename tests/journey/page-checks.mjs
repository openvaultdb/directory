// Checks on what a page says, for the journey spec (CC0-1.0). They are plain functions of
// text, so self-test.mjs can test them without a browser and without sites.

// Words that say a list is empty or not there yet, however politely.
const absence = /\b(none|no|nothing|nil|n\/a|na|not|tbd|todo|yet|empty|unavailable|missing|pending|soon|added?|available|listed)\b/i;
// One synonym: a short word or phrase of letters, spaces, apostrophes and hyphens.
const synonymPattern = /^\p{L}[\p{L}\p{M} '’-]{0,39}$/u;

// The synonyms a concept page lists: a line that starts with "Synonyms" (the list is on that line after an
// optional colon, or on the next non-empty line). Returns null when the page has no such label, else
// { text, items, problem } where `problem` is null only when there is at least one item and every item is
// a short word or phrase that does not say there are none ("none yet", "n/a", "(none)", "—", "to be added", ...).
export function synonymsOf(bodyText) {
  const lines = bodyText.split('\n').map((line) => line.trim());
  for (let position = 0; position < lines.length; position += 1) {
    const label = /^synonyms?\b\s*:?\s*(.*)$/i.exec(lines[position]);
    if (!label) continue;
    const text = label[1] || lines.slice(position + 1).find(Boolean) || '';
    const items = text.split(/[,;|·•]/).map((item) => item.trim()).filter(Boolean);
    let problem = null;
    if (items.length === 0) problem = 'the list is empty';
    else if (items.some((item) => absence.test(item))) problem = 'the text says there are none (or not yet)';
    else if (items.some((item) => !synonymPattern.test(item))) problem = 'an item is not a word or a short phrase';
    return { text, items, problem };
  }
  return null;
}

// In the page (Playwright's page.evaluate): the example cards on the Directory home. An example card is the
// smallest item (a list item, article, table row or link) whose text says "example" or "sample", that is not a
// link to a real database, and that has something more to say than the label: three bare "Example" labels, or
// a heading and a paragraph that use the word, are not three cards. Returns the distinct texts, one per card.
export function exampleCardTexts() {
  const labelled = /\b(examples?|samples?)\b/i;
  const candidates = [...document.querySelectorAll('li, article, tr, dd, [role="listitem"], a')].filter((element) => labelled.test(element.innerText) && !element.querySelector('a[href*="/databases/"]') && !element.closest('a[href*="/databases/"]'));
  const cards = candidates.filter((element) => !candidates.some((other) => other !== element && element.contains(other)));
  const substance = (text) => text.replace(/\b(examples?|samples?)\b/gi, '').replace(/[^\p{L}\p{N}]/gu, '');
  return [...new Set(cards.map((element) => element.innerText.replace(/\s+/g, ' ').trim()).filter((text) => substance(text).length >= 5))];
}
