// Part list export — port of desktop edit/PartList.cpp, laid out like
// vanilla BlueBrick's PartUsageView export: HTML (with each part's
// picture), text and CSV, one table or one per layer, with budget columns.

import type { BbmMap } from '@cld/model';
import type { PartWire } from '../api';
import { colorName } from './colorNames';
import { effectiveLimit, limitFor } from './budgetUsage';
import { libraryItems } from './sets';
import { defuseFormula } from '../csvSafety';

export const COLUMN_TITLES = ['Part', 'In Use', 'Color', 'Description', 'Budgeted', 'Missing', 'Part Usage %'] as const;

export interface PartListRow {
  /** Part id as used on the map, upper-cased ("2865.8"). */
  partNumber: string;
  /** Part number without the color code ("2865"). */
  part: string;
  colorName: string;
  description: string;
  count: number;
  /** Limit; -1 unlimited. Only with a budget. */
  budget: number;
  missing: number;
  /** Percent; negative = unbudgeted. */
  usage: number;
}

export interface PartListGroup {
  /** Layer name when split by layer, else empty. */
  name: string;
  rows: PartListRow[];
  total: PartListRow;
}

export interface PartListOptions {
  splitPerLayer?: boolean;
  /** Default true, like desktop partList/includeHiddenLayers. */
  includeHiddenLayers?: boolean;
  /** The layout's budget limits; empty or absent = no budget. */
  limits?: ReadonlyMap<string, number>;
  defaultBudgetIsInfinite?: boolean;
}

const emptyRow = (): PartListRow => ({
  partNumber: '', part: '', colorName: '', description: '', count: 0, budget: 0, missing: 0, usage: 0,
});

/** Budget.getUsagePercentage. */
function usageOf(count: number, budget: number): number {
  if (budget < 0) return -1;
  if (budget === 0) return (count + 1) * 100;
  return (count * 100) / budget;
}

/** BlueBrick's text bar: tenths as full blocks, a partial block, dashes, then "N%". */
export function percentageBar(percent: number): string {
  let tenth = Math.trunc(percent * 0.1);
  if (tenth > 10) tenth = 10;
  if (tenth < 0) tenth = 0;
  let bar = '█'.repeat(tenth);
  if (tenth < 10) {
    const remain = percent - tenth * 10;
    let c = '▏';
    if (remain >= 8.75) c = '█';
    else if (remain >= 7.5) c = '▉';
    else if (remain >= 6.25) c = '▊';
    else if (remain >= 5.0) c = '▋';
    else if (remain >= 3.75) c = '▌';
    else if (remain >= 2.5) c = '▍';
    else if (remain >= 1.25) c = '▎';
    bar += c;
    tenth++;
  }
  bar += '╌'.repeat(10 - tenth);
  // .NET "N0": rounded, with thousands separators.
  return `${bar} ${Math.round(percent).toLocaleString('en-US')}%`;
}

export function buildPartList(
  map: BbmMap,
  parts: ReadonlyMap<string, PartWire>,
  options: PartListOptions = {},
): PartListGroup[] {
  const includeHidden = options.includeHiddenLayers ?? true;
  const limits = options.limits && options.limits.size > 0 ? options.limits : null;
  const defaultInfinite = options.defaultBudgetIsInfinite ?? true;
  const counts: { name: string; byPart: Map<string, number> }[] = [];
  if (!options.splitPerLayer) counts.push({ name: '', byPart: new Map() });
  for (const layer of map.layers) {
    if (layer.type !== 'brick') continue;
    if (!includeHidden && !layer.visible) continue;
    if (options.splitPerLayer) counts.push({ name: layer.name, byPart: new Map() });
    const c = counts[counts.length - 1]!;
    // BlueBrick's LibraryBrickList: a set counts once, not its parts.
    for (const part of libraryItems(layer)) {
      const id = part.toUpperCase();
      c.byPart.set(id, (c.byPart.get(id) ?? 0) + 1);
    }
  }

  const out: PartListGroup[] = [];
  for (const c of counts) {
    if (options.splitPerLayer && c.byPart.size === 0) continue;
    const ids = [...c.byPart.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const total = emptyRow();
    let budgetOfUsed = 0;
    let budgetedCount = 0;
    const rows = ids.map((id) => {
      const dot = id.lastIndexOf('.');
      const r: PartListRow = {
        ...emptyRow(),
        partNumber: id,
        part: dot > 0 ? id.slice(0, dot) : id,
        colorName: colorName(dot > 0 ? id.slice(dot + 1) : ''),
        description: parts.get(id.toLowerCase())?.description ?? '',
        count: c.byPart.get(id)!,
      };
      if (limits) {
        r.budget = effectiveLimit(limits, id, defaultInfinite);
        r.usage = usageOf(r.count, r.budget);
        r.missing = r.budget < 0 ? r.count : Math.max(0, r.count - r.budget);
        if (limitFor(limits, id) !== undefined) {
          budgetOfUsed += r.budget;
          budgetedCount += r.count;
        }
      }
      total.count += r.count;
      total.missing += r.missing;
      return r;
    });
    if (limits) {
      // Budget.getTotalUsagePercentage / getUsagePercentageForLayer.
      total.budget = budgetOfUsed;
      total.usage = budgetOfUsed === 0 ? 0 : (budgetedCount * 100) / budgetOfUsed;
    }
    out.push({ name: c.name, rows, total });
  }
  return out;
}

/** One row's cells in column order (BlueBrick's ListViewItem texts). */
function cells(r: PartListRow, isTotal: boolean, hasBudget: boolean): string[] {
  const out = [isTotal ? 'Total' : r.part, String(r.count), r.colorName, r.description];
  if (!hasBudget) out.push('N/A', 'N/A', 'N/A');
  else if (!isTotal && r.usage < 0) out.push('Unbudgeted', String(r.missing), 'Unbudgeted');
  else out.push(String(r.budget), String(r.missing), percentageBar(r.usage));
  return out;
}

/** Map info for the header: author, LUG, event, the date in US long form, comment. */
function longDate(map: BbmMap): string {
  const { day, month, year } = map.date;
  const d = new Date(Date.UTC(year, month - 1, day));
  return new Intl.DateTimeFormat('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' }).format(d);
}

export function partListText(map: BbmMap, groups: readonly PartListGroup[], title: string, hasBudget: boolean): string {
  const width: number[] = COLUMN_TITLES.map((t) => t.length);
  const widen = (row: string[]) => row.forEach((c, i) => (width[i] = Math.max(width[i]!, c.length)));
  for (const g of groups) {
    for (const r of g.rows) widen(cells(r, false, hasBudget));
    widen(cells(g.total, true, hasBudget));
  }
  const ruleLength = width.reduce((n, w) => n + w + 3, -1);
  const rule = `+${'-'.repeat(ruleLength)}+`;
  const line = (row: readonly string[]) =>
    '| ' + row.map((c, i) => c + ' '.repeat(width[i]! - c.length + 1) + (i + 1 === row.length ? '|\n' : '| ')).join('');
  const indent = ' '.repeat(20);
  const frame = `+=${'='.repeat(title.length)}=+`;
  let out = `${indent}${frame}\n${indent}| ${title} |\n${indent}${frame}\n\n`;
  out += `Author: ${map.author}\nLUG: ${map.lug}\nEvent: ${map.event}\nDate: ${longDate(map)}\nComment:\n${map.comment}\n\n\n`;
  for (const g of groups) {
    if (g.name) out += `| ${g.name}\n`;
    out += `${rule}\n${line(COLUMN_TITLES)}${rule}\n`;
    for (const r of g.rows) out += line(cells(r, false, hasBudget));
    out += `${rule}\n${line(cells(g.total, true, hasBudget))}${rule}\n`;
    if (g.name) out += '\n';
  }
  return out;
}

export function partListCsv(groups: readonly PartListGroup[], hasBudget: boolean): string {
  const row = (r: PartListRow, isTotal: boolean) => {
    const c = cells(r, isTotal, hasBudget);
    c[3] = c[3]!.replaceAll(',', ' ');
    c[0] = c[0]!.replaceAll(',', ' ');
    // Just the number, as BlueBrick, without the thousands comma
    // ("2,600" would split into two columns).
    if (hasBudget && (isTotal || r.usage >= 0)) c[6] = c[6]!.slice(11, -1).replaceAll(',', '');
    // Otherwise BlueBrick's bytes, but a name a spreadsheet would run as a
    // formula ("=HYPERLINK(…)", "+1", "@SUM", "-cmd") gets a leading '.
    return c.map(defuseFormula).join(',') + '\n';
  };
  let out = '';
  for (const g of groups) {
    if (g.name) out += `${defuseFormula(g.name)}\n`;
    out += COLUMN_TITLES.join(',') + '\n';
    for (const r of g.rows) out += row(r, false);
    out += row(g.total, true);
    if (g.name) out += '\n';
  }
  return out;
}

/** QString::toHtmlEscaped: & < > and ". */
const escapeHtml = (s: string) =>
  s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

const HEADER_CLASS = ['partIdHeader', 'partCountHeader', 'colorHeader', 'descriptionHeader', 'budgetHeader', 'missingHeader', 'partUsageHeader'];
const CELL_CLASS = ['partId', 'partCount', 'color', 'description', 'budget', 'missing', 'partUsage'];

const STYLE = `\t<style type="text/css" >
\th2.title { text-align: center; font-weight: bold; font-variant: small-caps; margin: 2.5%; background-color: #bdffc0; border: 2px solid black; padding: 10px;}
\ttd.info { text-align: right; vertical-align: top; font-weight: bold; }
\ttr.groupName { background-color: #90d7ff; font-weight: bold; }
\ttr.header { background-color: #bfe8ff; font-style: italic; }
\ttd.partIdHeader { text-align: center; width: 20% }
\ttd.partCountHeader { text-align: center; width: 5% }
\ttd.budgetHeader { text-align: center; width: 5% }
\ttd.missingHeader { text-align: center; width: 5% }
\ttd.partUsageHeader { text-align: center; width: 10% }
\ttd.colorHeader { text-align: center; width: 10% }
\ttd.descriptionHeader { text-align: center; width: 46% }
\ttd.partId { text-align: center; }
\ttd.partId img { max-width: 100%; max-height: 8em; }
\ttd.partCount { text-align: center; }
\ttd.budget { text-align: center; }
\ttd.missing { text-align: center; }
\ttd.partUsage { }
\ttd.color { text-align: center; }
\ttd.description { }
\ttr.total { background-color: #feffea; }
\t</style>
`;

/**
 * HTML part list. `picture` gives a part's image as a data: URL (or null);
 * desktop embeds a PNG scaled to 160 px.
 */
export function partListHtml(
  map: BbmMap,
  groups: readonly PartListGroup[],
  title: string,
  hasBudget: boolean,
  picture?: (partNumber: string) => string | null,
): string {
  let out = `<html>\n<head>\n\t<meta charset="utf-8">\n\t<title>${escapeHtml(title)}</title>\n${STYLE}`;
  out += `</head>\n<body>\n<h2 class="title">${escapeHtml(title)}</h2>\n`;
  out += '<table border="0" style="margin-left: 3%">\n';
  const info = (label: string, value: string) => (out += `\t<tr><td class="info">${escapeHtml(label)}</td><td>${value}</td></tr>\n`);
  info('Author:', escapeHtml(map.author));
  info('LUG:', escapeHtml(map.lug));
  info('Event:', escapeHtml(map.event));
  info('Date:', escapeHtml(longDate(map)));
  info('Comment:', escapeHtml(map.comment).replaceAll('\n', '<br/>'));
  out += '</table>\n<br/>\n<br/>\n\n';
  const headerRow = () => {
    out += '<tr class="header">\n';
    COLUMN_TITLES.forEach((t, i) => (out += `\t<td class="${HEADER_CLASS[i]}">${escapeHtml(t)}</td>\n`));
    out += '</tr>\n';
  };
  const row = (r: PartListRow, isTotal: boolean) => {
    out += isTotal ? '<tr class="total">\n' : '<tr>\n';
    cells(r, isTotal, hasBudget).forEach((c, i) => {
      let text = escapeHtml(c);
      if (i === 0 && !isTotal && picture) {
        const src = picture(r.partNumber);
        if (src) text = `<img src="${src}"><br/>${text}`;
      }
      out += `\t<td class="${CELL_CLASS[i]}">${text}</td>\n`;
    });
    out += '</tr>\n';
  };
  for (const g of groups) {
    out += '<table border="1" width="95%" cellpadding="10" style="margin: auto">\n';
    if (g.name) out += `<tr class="groupName"><td colspan="${COLUMN_TITLES.length}"><b>${escapeHtml(g.name)}</b></td></tr>\n`;
    headerRow();
    for (const r of g.rows) row(r, false);
    row(g.total, true);
    out += '</table>\n';
    if (g.name) out += '<br/>\n';
  }
  return out + '</body>\n</html>\n';
}
