// Browse an actual offline site build. Every browser request is intercepted;
// provider-resource links are inspected, never followed. Supply the renderer's
// generated output with OVDB_W3_BUILD_DIR to run this opt-in local journey.
import { readFileSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import { test, expect } from '@playwright/test';

const build = process.env.OVDB_W3_BUILD_DIR;
const origin = 'https://directory-w3.test';
const ids = ['cisa-kev', 'govuk-bank-holidays', 'cldr48-windows-zones', 'iana-http-status-codes', 'iana-application-media-types'];
const index = JSON.parse(readFileSync(new URL('../../index.json', import.meta.url)));
const sources = index.sources.filter(source => ids.includes(source.id));
test.skip(!build, 'OVDB_W3_BUILD_DIR must name an actual offline Directory website build');

test('W3 browse search, details, reload and sitemap request zero provider bytes', async ({ page }) => {
  const external = [];
  let blockedFonts = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) {
      // The unmodified renderer references this optional stylesheet. Abort it
      // without bytes; every other external request remains a failed journey.
      if (url.href === 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap') blockedFonts++;
      else external.push(url.href);
      return route.abort();
    }
    const pathname = decodeURIComponent(url.pathname);
    const file = resolve(build, `.${pathname}`, ...(pathname.endsWith('/') ? ['index.html'] : []));
    if (!file.startsWith(resolve(build) + sep)) return route.abort();
    try {
      const contentType = file.endsWith('.html') ? 'text/html' : file.endsWith('.css') ? 'text/css' : file.endsWith('.js') ? 'application/javascript' : file.endsWith('.xml') ? 'application/xml' : 'application/octet-stream';
      await route.fulfill({ status: 200, contentType, body: readFileSync(file) });
    } catch { await route.fulfill({ status: 404, body: 'Missing build asset' }); }
  });
  expect(sources).toHaveLength(5);
  for (const source of sources) {
    await page.goto(`${origin}/`);
    await page.locator('#directory-search').fill(source.title);
    await page.locator('#search').evaluate(form => form.requestSubmit());
    const card = page.locator('.source-card:visible');
    await expect(card).toHaveCount(1);
    await expect(card).toContainText('Inactive');
    await card.getByRole('link', { name: source.title, exact: true }).click();
    await expect(page).toHaveURL(`${origin}/sources/${source.id}/`);
    await expect(page.getByRole('heading', { name: 'Query activation blocked', exact: true })).toBeVisible();
    await expect(page.locator('main')).toContainText('No source rows are served here');
    await expect(page.getByRole('link', { name: source.resource_url, exact: true })).toHaveAttribute('href', source.resource_url);
    await expect(page.getByRole('link', { name: 'Source conditions', exact: true })).toHaveAttribute('href', source.terms_url);
    for (const rs of source.recordsets) {
      const section = page.locator(`#recordset-${rs.name}`);
      await expect(section).toContainText(rs.description);
      for (const field of rs.fields) await expect(section.locator(`#field-${rs.name}-${field.name}`)).toContainText(field.description);
    }
    await expect(page.locator('main a[href*="modelspec.org"], main a[href*="meaninggraph.io"], main a[href*="dtql"], main a[href*="/ovdb/dbs/"], main button')).toHaveCount(0);
    await page.reload();
    await expect(page.getByRole('heading', { level: 1, name: source.title, exact: true })).toBeVisible();
  }
  await page.goto(`${origin}/sitemap.xml`);
  const sitemap = await page.locator('body').innerText();
  for (const id of ids) expect(sitemap).toContain(`/sources/${id}/`);
  expect(external).toEqual([]);
  await test.info().attach('request-receipt', { contentType: 'application/json', body: JSON.stringify({ providerRequests: external, externalBytes: 0, blockedFonts }) });
});
