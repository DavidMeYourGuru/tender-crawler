/** Gemeinsamer Detaildatenvertrag für Portaladapter. */

export function cleanDetailText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

export function makeTextSection({ sectionKey, title = null, sourceUrl = null, text = '', status = 'complete' }) {
  return {
    sectionKey,
    title: title || sectionKey,
    sourceUrl,
    text: cleanDetailText(text),
    status,
  };
}

export function makeFact({ sectionKey = null, key = null, label, value, normalizedValue = null, dataType = null, sourceUrl = null }) {
  const labelText = cleanDetailText(label);
  const valueText = value == null ? null : cleanDetailText(value);
  if (!labelText || !valueText) return null;
  const factKey = key || `${sectionKey || 'detail'}:${labelText.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/^-|-$/g, '')}`;
  return {
    factKey,
    sectionKey,
    label: labelText,
    valueText,
    normalizedValue,
    dataType,
    sourceUrl,
  };
}

export function uniqueFacts(facts = []) {
  const byKey = new Map();
  for (const fact of facts) {
    if (!fact?.factKey) continue;
    byKey.set(fact.factKey, fact);
  }
  return [...byKey.values()];
}

export function factsFromMetadata(metadata, sectionKey, sourceUrl) {
  const facts = [];
  for (const [key, value] of Object.entries(metadata || {})) {
    if (value == null || value === '' || key === 'rawText' || key === 'pageKind') continue;
    if (Array.isArray(value)) {
      if (!value.length) continue;
      facts.push(makeFact({ sectionKey, key: `${sectionKey}:${key}`, label: key, value: value.join(', '), normalizedValue: value, dataType: 'array', sourceUrl }));
    } else if (typeof value === 'object') {
      for (const [childKey, childValue] of Object.entries(value)) {
        if (childValue == null || childValue === '') continue;
        facts.push(makeFact({
          sectionKey,
          key: `${sectionKey}:${key}.${childKey}`,
          label: `${key}.${childKey}`,
          value: typeof childValue === 'boolean' ? (childValue ? 'Ja' : 'Nein') : childValue,
          normalizedValue: childValue,
          dataType: typeof childValue,
          sourceUrl,
        }));
      }
    } else {
      facts.push(makeFact({
        sectionKey,
        key: `${sectionKey}:${key}`,
        label: key,
        value,
        normalizedValue: value,
        dataType: typeof value,
        sourceUrl,
      }));
    }
  }
  return facts.filter(Boolean);
}

export function extractFactsFromRows(rows, sectionKey, sourceUrl) {
  const facts = [];
  for (const row of rows || []) {
    if (!Array.isArray(row) || row.length < 2) continue;
    const label = cleanDetailText(row[0]);
    const value = cleanDetailText(row.slice(1).join(' '));
    const fact = makeFact({ sectionKey, label, value, sourceUrl });
    if (fact) facts.push(fact);
  }
  return uniqueFacts(facts);
}

/**
 * Extrahiert Fakten nur aus semantisch gepaarten DOM-Elementen. Freie
 * Fließtextzeilen (z. B. beliebige `p`-Elemente mit Doppelpunkt) werden
 * absichtlich nicht als Label/Wert interpretiert. Das verhindert, dass
 * Layout- oder Beschreibungstext als vermeintliche Stammdaten endet.
 */
export function extractFactsFromDom($, sectionKey, sourceUrl) {
  const facts = [];
  const add = (label, value, key = null) => {
    const fact = makeFact({ sectionKey, key, label, value, sourceUrl });
    if (fact) facts.push(fact);
  };
  if (!$ || typeof $ !== 'function') return [];

  $('dl').each((_, dl) => {
    const children = $(dl).children().toArray();
    for (let i = 0; i < children.length; i += 1) {
      if (!$(children[i]).is('dt')) continue;
      const valueNode = children.slice(i + 1).find((node) => $(node).is('dd'));
      if (!valueNode) continue;
      add($(children[i]).text(), $(valueNode).text());
    }
  });

  $('label[for]').each((_, labelNode) => {
    const id = $(labelNode).attr('for');
    if (!id) return;
    const control = $('[id]').filter((_, node) => $(node).attr('id') === id).first();
    if (!control.length) return;
    const value = control.is('select') ? control.find('option:selected').text()
      : (control.val?.() || control.attr('value') || control.text());
    add($(labelNode).text(), value);
  });

  $('.control-group').each((_, group) => {
    const label = $(group).find('.control-label, .field-label, label, dt, th').first();
    const value = $(group).find('.controls, .control-value, .field-value, dd').first();
    if (label.length && value.length) add(label.text(), value.text());
  });

  $('tr').each((_, row) => {
    const cells = $(row).children('th,td').toArray();
    if (cells.length < 2) return;
    const label = cleanDetailText($(cells[0]).text());
    const value = cleanDetailText(cells.slice(1).map((cell) => $(cell).text()).join(' '));
    if (label && value && !/^aktions?link|navigation|seite$/i.test(label)) add(label, value);
  });
  return uniqueFacts(facts);
}

export default {
  cleanDetailText, makeTextSection, makeFact, uniqueFacts, factsFromMetadata,
  extractFactsFromRows, extractFactsFromDom,
};
