// Area 3 review fixes: where new rulers, text and erasing go when sheets
// are hidden, the picture export's first size and file size, and the
// small helpers behind plain words (tool names, the date box, tours for
// someone in no club, waiting out "Too many tries").

import { describe, expect, it } from 'vitest';
import { createDefaultLayoutDoc } from '@cld/ydoc';
import { addLayer, ensureAreaLayer, ensureRulerLayer, ensureTextLayer, setLayerVisible, shownAreaLayer, sheetForNew } from '../mutations';
import { aboutSize, defaultExportSize, estimateImageBytes } from '../exportRender';
import { toolLabel } from '../Toolbar';
import { fromIsoDate, isoDate } from '../GeneralInfoDialog';
import { forClubless, getTour } from '../../tours/tours';
import { waitFromTooMany } from '../../admin/tabs/LibrariesTab';
import { studsPerUnit } from '../VenueDimensionsDialog';
import { sheetName } from '../activeSheet';

describe('new rulers and text go on a sheet you can see', () => {
  it('the active sheet of that kind when shown, else the first shown, else a hidden one', () => {
    const doc = createDefaultLayoutDoc();
    const a = ensureRulerLayer(doc);
    const b = addLayer(doc, 'ruler');
    expect(sheetForNew(doc, 'ruler', b)).toBe(b);
    setLayerVisible(doc, a, false);
    expect(ensureRulerLayer(doc)).toBe(b);
    setLayerVisible(doc, b, false);
    // Only hidden ones: the first (the editor then says it's hidden).
    expect(ensureRulerLayer(doc, b)).toBe(a);
    const t = ensureTextLayer(doc);
    setLayerVisible(doc, t, false);
    const t2 = addLayer(doc, 'text');
    expect(ensureTextLayer(doc)).toBe(t2);
  });

  it('erasing finds the shown area sheet and never makes an empty one', () => {
    const doc = createDefaultLayoutDoc();
    expect(shownAreaLayer(doc)).toBeNull();
    const before = doc.getArray('layers').length;
    expect(shownAreaLayer(doc)).toBeNull();
    expect(doc.getArray('layers').length).toBe(before);
    const area = ensureAreaLayer(doc);
    expect(shownAreaLayer(doc)).toBe(area);
    setLayerVisible(doc, area, false);
    expect(shownAreaLayer(doc)).toBeNull();
  });
});

describe('Export as image', () => {
  it('starts at 2x, but no more than 4,000 px on the longest side', () => {
    expect(defaultExportSize({ width: 800, height: 400 })).toEqual({ width: 1600, height: 800 });
    // Fordyce: 8,192 x 4,598 scene px was 16,384 x 9,196 at 2x.
    expect(defaultExportSize({ width: 8192, height: 4598 })).toEqual({ width: 4000, height: 2245 });
  });

  it('says roughly how big the file will be', () => {
    expect(aboutSize(estimateImageBytes(16384, 9196, 'png'))).toBe('about 115 MB');
    expect(estimateImageBytes(4000, 2245, 'jpeg', 90)).toBeLessThan(estimateImageBytes(4000, 2245, 'png'));
    expect(aboutSize(500_000)).toBe('about 488 KB');
    expect(aboutSize(3 * 1024 * 1024)).toBe('about 3.0 MB');
  });
});

describe('plain words', () => {
  it('the status bar names tools the way the rail does', () => {
    expect(toolLabel('rulerLinear')).toBe('Measure');
    expect(toolLabel('rotate')).toBe('Turn');
    expect(toolLabel('venueObstacle')).toBe('Obstacle');
  });

  it('the date box round-trips the map date, and an empty box keeps it', () => {
    expect(isoDate({ day: 7, month: 3, year: 2026 })).toBe('2026-03-07');
    expect(fromIsoDate('2026-03-07')).toEqual({ day: 7, month: 3, year: 2026 });
    expect(fromIsoDate('')).toBeNull();
  });

  it('an unnamed sheet is called by its kind', () => {
    expect(sheetName({ name: '', type: 'grid' })).toBe('Grid');
    expect(sheetName({ name: 'Layer 2', type: 'brick' })).toBe('Sheet 2');
  });

  it('venue sizes in meters and centimeters (1 stud = 8 mm)', () => {
    expect(studsPerUnit('m')).toBe(125);
    expect(studsPerUnit('cm')).toBe(1.25);
    expect(studsPerUnit('ft')).toBeCloseTo(38.098, 3);
  });
});

describe('the Clubs tour for someone in no club', () => {
  it('leaves out the step about their clubs’ things', () => {
    const tour = getTour('clubs')!;
    expect(tour.steps.map((s) => s.target)).toContain('owners.filter');
    expect(forClubless(tour, false).steps.map((s) => s.target)).toEqual(['publish.owner', 'clubs.page', 'clubs.join']);
    expect(forClubless(tour, true)).toBe(tour);
  });
});

describe('installing many part libraries in a row', () => {
  it('waits as long as "Too many tries" says, and gives up on any other error', () => {
    expect(waitFromTooMany(new Error('Too many tries. Please wait 30 seconds and try again.'))).toBe(30_500);
    expect(waitFromTooMany(new Error('Too many tries. Please wait 1 minute and try again.'))).toBe(60_500);
    expect(waitFromTooMany(new Error('Too many tries. Please wait a little and try again.'))).toBe(30_000);
    expect(waitFromTooMany(new Error('The download failed.'))).toBeNull();
  });
});
