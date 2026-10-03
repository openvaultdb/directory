// Checks on what a page shows, for the journey spec (CC0-1.0). Two functions run in the page
// (Playwright's page.evaluate) and only collect what is there; the judging is plain code on
// plain data, so self-test.mjs can test it without a site.

// ---- synonyms ----

// In the page: what a concept page lists under "Synonyms". Finds the element that is the label (it holds
// only the word "Synonyms", optionally with a colon or a count) and returns what follows it: the siblings after the
// label, up to the next heading or the next element that holds a heading, as groups of leaf texts (a group is one
// language's tag and synonyms, or one list). Or, when the label and the list are one line ("Synonyms: a, b"),
// the items after the colon. Returns null when the page has no such label.
export function synonymBlocks() {
  const leafTexts = (element) => (element.children.length === 0 ? [element.textContent.trim()] : [...element.querySelectorAll('*')].filter((node) => node.children.length === 0).map((node) => node.textContent.trim())).filter(Boolean);
  const everything = [...document.body.querySelectorAll('*')].filter((node) => node.children.length === 0);
  const label = everything.find((node) => /^synonyms?(\s*\(\d+\))?\s*:?$/i.test(node.textContent.trim()));
  if (label) {
    const groups = [];
    for (let next = label.nextElementSibling; next; next = next.nextElementSibling) {
      if (/^H[1-6]$/.test(next.tagName) || next.querySelector('h1, h2, h3, h4, h5, h6')) break;
      groups.push(leafTexts(next));
    }
    return { text: groups.flat().join(' | '), groups };
  }
  const inline = everything.map((node) => /^synonyms?(?:\s*\(\d+\))?\s*:\s*(.*)$/is.exec(node.textContent.trim())).find(Boolean);
  if (!inline) return null;
  const items = inline[1].split(/[,;|·•]/).map((item) => item.trim()).filter(Boolean);
  return { text: inline[1], groups: [items] };
}

// A language tag ("en", "ru", "pt-BR") that a list of synonyms starts with: a BCP 47 shape that is a language
// the runtime knows (so a synonym such as "usa" is not taken for one).
const languageShape = /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/;
function isLanguageTag(text) {
  if (!languageShape.test(text)) return false;
  try { return new Intl.DisplayNames(['en'], { type: 'language', fallback: 'none' }).of(text) !== undefined; } catch { return false; }
}

// An item that is a short word or phrase (letters, marks, digits, spaces and a few punctuation marks real phrases use).
const synonymPattern = /^\p{L}[\p{L}\p{M}\p{N} '’.()\/&-]{0,59}$/u;
// An item that is a placeholder: the whole text says there is nothing, or nothing yet. The list is not complete and
// does not pretend to be: the structure (a label, then items, a tag that is not an item) does the main work.
const placeholder = /^(undefined|null|nan|unknown|none|nil|nothing|empty|loading(\.\.\.|…)?|pending|missing|n\/?a|tb[acd]|todo|no synonyms?( (listed|yet|available))?|none (yet|listed|available)|not (yet )?(available|listed|added|set|known)|to be (added|announced|determined|decided)|coming soon|(\w+ )?will (appear|be added)( here)?|under review|no data)\.?$/i;

// What the page's synonyms are, from what synonymBlocks collected: null when the page has no label, else
// { text, items, problem } with the language tags removed (the first item of a group, when it is a tag) and `problem`
// null only when at least one item is left and every item is a short phrase that is not a placeholder.
export function synonymsFrom(blocks) {
  if (blocks === null) return null;
  const items = [];
  for (const group of blocks.groups) {
    const rest = [...group];
    if (rest.length > 0 && isLanguageTag(rest[0])) rest.shift();
    items.push(...rest);
  }
  let problem = null;
  if (items.length === 0) problem = 'there is no synonym under the label (an empty list, or only a language tag, or the next heading follows at once)';
  else if (items.some((item) => placeholder.test(item))) problem = 'an item says there are none, or none yet, or is a placeholder';
  else if (items.some((item) => !synonymPattern.test(item))) problem = 'an item is not a word or a short phrase';
  return { text: blocks.text, items, problem };
}

// ---- example cards ----

// In the page: the example cards on the Directory home. A card is the smallest item that has a heading of its own
// (one heading, 2 to 80 characters, more than the words "example" or "sample") and says "example" or "sample" in its
// own text (links and buttons aside) or in the label just before its list, and is not a database of this Directory (its heading is not a link to
// a /databases/ page). Links and list items that only use the word are not cards. Returns the distinct headings.
export function exampleCardTitles() {
  const labelled = /\b(examples?|samples?)\b/i;
  const boundary = /^(UL|OL|TABLE|TBODY|SECTION|FORM|NAV|MAIN|BODY|HTML|HEADER|FOOTER)$/;
  // The text of an item without its links and buttons: "Browse sample databases" is a link, not a label.
  const plainText = (element) => {
    const copy = element.cloneNode(true);
    copy.querySelectorAll('a, button').forEach((node) => node.remove());
    const words = [];
    for (const walker = document.createTreeWalker(copy, NodeFilter.SHOW_TEXT); walker.nextNode();) words.push(walker.currentNode.textContent);
    return words.join(' ');
  };
  // The label just before a card or its list: the nearest earlier sibling (of the card, then of its parent, and so on, never
  // across a section) that is not a heading and not another card. "Sample catalogue content" before a grid is one.
  const labelBefore = (card) => {
    for (let node = card; node && !boundary.test(node.tagName); node = node.parentElement) {
      for (let sibling = node.previousElementSibling; sibling; sibling = sibling.previousElementSibling) {
        if (/^H[1-6]$/.test(sibling.tagName) || sibling.querySelector('h1, h2, h3, h4, h5, h6, [role="heading"]')) continue;
        const text = plainText(sibling).replace(/\s+/g, ' ').trim();
        if (text) return text.length <= 60 ? text : '';
      }
    }
    return '';
  };
  const headings = [...document.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')];
  const cards = [];
  for (const heading of headings) {
    const title = heading.innerText.replace(/\s+/g, ' ').trim();
    const stripped = title.replace(/\b(examples?|samples?)\b/gi, '').replace(/[^\p{L}\p{N}]/gu, '');
    if (title.length < 2 || title.length > 80 || stripped.length < 3) continue;
    if (heading.querySelector('a[href*="/databases/"]') || heading.closest('a[href*="/databases/"]')) continue;
    if (heading.closest('nav, header, footer')) continue;
    let card = heading;
    for (let node = heading.parentElement; node && !boundary.test(node.tagName); node = node.parentElement) {
      if (node.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]').length > 1) break;
      card = node;
    }
    if (card === heading) continue;
    if (labelled.test(plainText(card)) || labelled.test(labelBefore(card))) cards.push({ title, card });
  }
  const owned = cards.filter(({ card }) => !cards.some((other) => other.card !== card && card.contains(other.card)));
  return [...new Set(owned.map(({ title }) => title))];
}
