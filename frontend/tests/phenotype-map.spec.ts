import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from 'playwright/test'

const dbName = 'sample #1.db'
const otherDbName = 'treatment #2.db'
const missingDbName = 'removed.db'
const mapUrl = `/bulk-engine?${new URLSearchParams({ dbname: dbName, mode: 'phenotype-map' })}`
const localizationKeys = ['entropy_norm', 'hoyer_sparsity', 'top10_fraction', 'polar_enrichment',
  'midcell_enrichment', 'axial_spread', 'axial_offset', 'axial_asymmetry', 'background_intensity'] as const
const patterns = [
  [0.2, 0.8, 0.9, 0.5, 0.8, 0.15, 0.2, 0.1, 100],
  [0.4, 0.6, 0.7, 2.0, 0.0, 0.12, 0.8, 0.9, 100],
  [0.7, 0.3, 0.3, 1.5, 0.6, 0.30, 0.1, 0.1, 100],
  [0.8, 0.2, 0.2, 1.0, 1.2, 0.27, 0.0, 0.0, 100],
]
const cells = [
  { cell_id: 'F0C0', manual_label: '1', length_px: 10, width_mean_px: 2, width_median_px: 2,
    area_px2: 20, fluo1_normalized_median: 0.2, fluo2_normalized_median: 0.3 },
  { cell_id: 'F0C1', manual_label: '1', length_px: 20, width_mean_px: 4, width_median_px: 4,
    area_px2: 80, fluo1_normalized_median: 0.6, fluo2_normalized_median: null },
  { cell_id: 'F0C2', manual_label: '2', length_px: 30, width_mean_px: 6, width_median_px: 6,
    area_px2: 180, fluo1_normalized_median: null, fluo2_normalized_median: 0.8 },
  { cell_id: 'F0C3', manual_label: 'N/A', length_px: null, width_mean_px: null, width_median_px: null,
    area_px2: 40, fluo1_normalized_median: 0.4, fluo2_normalized_median: 0.5 },
].map((cell, index) => ({ ...cell, ...Object.fromEntries(
  (['fluo1', 'fluo2'] as const).flatMap((channel) => localizationKeys.map((key, metricIndex) =>
    [`${channel}_${key}`, cell[`${channel}_normalized_median`] === null ? null : patterns[index][metricIndex]],
  )),
) }))
const otherCells = [
  { ...cells[0], fluo1_entropy_norm: 0.1, fluo1_polar_enrichment: 1.4, fluo2_entropy_norm: 0.7 },
  { ...cells[1], cell_id: 'F0C4', fluo1_entropy_norm: 0.9, fluo1_polar_enrichment: 0.8 },
  { ...cells[3], cell_id: 'F0C5', ...Object.fromEntries(localizationKeys.filter((key) => key !== 'background_intensity').map((key) => [`fluo1_${key}`, null])), fluo2_entropy_norm: 0.2 },
]

async function openMap(page: Page, failFirst = false, empty = false) {
  const state = { featureRequests: 0, comparisonRequests: [] as { dbnames: string[]; background_mode: string }[],
    imageRequests: [] as URL[], zipRequests: 0, failRequests: failFirst }
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const headers = { 'access-control-allow-origin': '*' }
    if (route.request().method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: { ...headers, 'access-control-allow-methods': 'GET, POST, OPTIONS', 'access-control-allow-headers': 'content-type' } })
      return
    }
    if (url.pathname.endsWith('/get-databases')) {
      await route.fulfill({ headers, json: [dbName, otherDbName, missingDbName] })
    } else if (url.pathname.endsWith('/get-phenotype-comparison')) {
      const request = route.request().postDataJSON() as { dbnames: string[]; background_mode: string }
      state.comparisonRequests.push(request)
      const mode = request.background_mode
      const selected = request.dbnames.flatMap((name) => name === missingDbName ? [] :
        (name === dbName ? cells : otherCells).map((cell) => ({ ...cell, dbname: name })))
      await route.fulfill({ headers, json: {
        comparison_version: '1', feature_version: '2', source_fingerprint: `comparison-${mode}`, degree: 4,
        localization: { background_mode: mode, background_ring_px: 3, pole_fraction: 0.2,
          midcell_start: 0.4, midcell_end: 0.6, top_fraction: 0.1, coordinate: 'normalized_centerline_arc_length' },
        units: { area_px2: 'px^2', length_px: 'px', fluo1_entropy_norm: 'dimensionless', fluo2_entropy_norm: 'dimensionless' },
        datasets: request.dbnames.map((name) => ({ dbname: name,
          cell_count: selected.filter((cell) => cell.dbname === name).length,
          source_fingerprint: name === missingDbName ? null : `source-${name}-${mode}`,
          error: name === missingDbName ? 'Database not found' : null })),
        cells: selected,
      } })
    } else if (url.pathname.endsWith('/get-phenotype-features')) {
      state.featureRequests += 1
      const requestedDb = url.searchParams.get('dbname')
      expect([dbName, otherDbName, missingDbName]).toContain(requestedDb)
      if (requestedDb === missingDbName) {
        await route.fulfill({ status: 404, headers, json: { detail: 'Database not found' } })
        return
      }
      await route.fulfill({ status: state.failRequests ? 500 : 200, headers, json: {
        dbname: requestedDb, feature_version: '2', source_fingerprint: `test-source-${url.searchParams.get('background_mode')}`, degree: 4,
        localization: { background_mode: url.searchParams.get('background_mode'), background_ring_px: 3,
          pole_fraction: 0.2, midcell_start: 0.4, midcell_end: 0.6, top_fraction: 0.1,
          coordinate: 'normalized_centerline_arc_length' },
        units: { length_px: 'px', width_mean_px: 'px', width_median_px: 'px', area_px2: 'px^2',
          fluo1_normalized_median: 'dimensionless', fluo2_normalized_median: 'dimensionless' },
        cells: empty ? [] : requestedDb === dbName ? cells : otherCells,
      } })
    } else if (url.pathname.endsWith('/get-cell-image')) {
      state.imageRequests.push(url)
      if (url.searchParams.get('image_type') === 'fluo2' && url.searchParams.get('cell_id') === 'F0C1') {
        await route.fulfill({ status: 404, headers, json: { detail: 'Cell image not found' } })
        return
      }
      await route.fulfill({ headers, contentType: 'image/svg+xml', body:
        '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#e4e4df"/><rect x="25" y="63" width="110" height="34" rx="17" fill="#9ca29b" stroke="#168477" stroke-width="2"/></svg>' })
    } else {
      if (url.pathname.endsWith('/get-annotation-zip')) state.zipRequests += 1
      await route.fulfill({ headers, json: {} })
    }
  })
  await page.goto(mapUrl)
  return state
}

test('links points to cells and exports exactly the selected IDs with nulls intact', async ({ page }) => {
  const state = await openMap(page)
  await expect(page.getByTestId('phenotype-counts')).toContainText('Plotted 3 / 4 cells')
  await page.getByRole('button', { name: 'Select cell F0C1', exact: true }).click()
  await expect(page.getByTestId('phenotype-gallery').getByRole('button')).toHaveCount(1)
  await expect(page.getByRole('link', { name: 'Open Cell Viewer' })).toHaveAttribute('href',
    `/cells?${new URLSearchParams({ db: dbName, cell_id: 'F0C1' })}`)
  await expect.poll(() => state.imageRequests.some((url) => url.searchParams.get('cell_id') === 'F0C1' &&
    url.searchParams.get('image_type') === 'fluo1')).toBe(true)
  await page.getByRole('button', { name: 'Select cell F0C0', exact: true }).click({ modifiers: ['Shift'] })
  await expect(page.getByTestId('phenotype-gallery').getByRole('button')).toHaveCount(2)

  const csvPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export selected CSV' }).click()
  const csv = await csvPromise
  const csvText = await readFile((await csv.path())!, 'utf8')
  const [headers, ...csvRows] = csvText.split('\r\n').map((line) => line.split(','))
  expect(csvRows.map((row) => row[headers.indexOf('cell_id')])).toEqual(['F0C0', 'F0C1'])
  expect(csvRows[0][headers.indexOf('fluo1_polar_enrichment')]).toBe('0.5')
  expect(csvRows[1][headers.indexOf('fluo1_entropy_norm')]).toBe('0.4')
  expect(csvRows[1][headers.indexOf('fluo2_normalized_median')]).toBe('')
  expect(csvRows[1][headers.indexOf('fluo2_polar_enrichment')]).toBe('')
  expect(headers).toContain('area_px2')
  const jsonPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export selection JSON' }).click()
  const json = JSON.parse(await readFile((await (await jsonPromise).path())!, 'utf8'))
  expect(json.cells.map((cell: { cell_id: string }) => cell.cell_id)).toEqual(['F0C0', 'F0C1'])
  expect(json.source_fingerprint).toBe('test-source-local_ring')
  expect(json.settings.x_metric).toBe('entropy_norm')
  expect(json.localization.background_mode).toBe('local_ring')
  expect(json.localization.pole_fraction).toBe(0.2)
  expect(json.units.area_px2).toBe('px^2')
  expect(json.cells[1].fluo2_normalized_median).toBeNull()
  await page.getByLabel('Fluorescence channel').selectOption('fluo2')
  await page.getByRole('button', { name: 'Inspect cell F0C1', exact: true }).click()
  await expect(page.getByText('No FLUO2 image')).toBeVisible()
  expect(state.zipRequests).toBe(0)
})

test('compares localization descriptors and records the selected background correction', async ({ page }) => {
  const state = await openMap(page)
  await expect(page.getByLabel('X axis', { exact: true })).toHaveValue('entropy_norm')
  await expect(page.getByLabel('Y axis', { exact: true })).toHaveValue('polar_enrichment')
  await expect(page.getByRole('button', { name: 'Select cell F0C0', exact: true })).toBeVisible()
  const initialRequests = state.featureRequests
  for (const key of localizationKeys.filter((key) => key !== 'background_intensity')) {
    await page.getByLabel('X axis', { exact: true }).selectOption(key)
    await expect(page.getByRole('button', { name: 'Select cell F0C0', exact: true })).toBeVisible()
  }
  await page.getByRole('button', { name: 'Poles × midcell', exact: true }).click()
  await expect(page.getByLabel('X axis', { exact: true })).toHaveValue('polar_enrichment')
  await expect(page.getByLabel('Y axis', { exact: true })).toHaveValue('midcell_enrichment')
  await page.getByRole('button', { name: 'Spread × offset', exact: true }).click()
  await expect(page.getByLabel('X axis', { exact: true })).toHaveValue('axial_spread')
  await expect(page.getByLabel('Y axis', { exact: true })).toHaveValue('axial_offset')
  expect(state.featureRequests).toBe(initialRequests)
  await page.getByRole('button', { name: 'Select cell F0C0', exact: true }).click()
  await page.getByLabel('Background correction').selectOption('none')
  await expect(page.getByTestId('phenotype-counts')).toContainText('Selected: 0')
  expect(state.featureRequests).toBe(initialRequests + 1)
  await page.getByRole('button', { name: 'Select cell F0C0', exact: true }).click()
  const downloadPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export selection JSON' }).click()
  const json = JSON.parse(await readFile((await (await downloadPromise).path())!, 'utf8'))
  expect(json.localization.background_mode).toBe('none')
  expect(json.settings.background_mode).toBe('none')
})

test('opens from the Analysis mode selector even when preview images are unavailable', async ({ page }) => {
  await openMap(page)
  await page.goto(`/bulk-engine?${new URLSearchParams({ dbname: dbName })}`)
  await page.getByLabel('Analysis mode').selectOption('phenotype-map')
  await expect(page.getByTestId('phenotype-counts')).toContainText('Plotted 3 / 4 cells')
  await expect(page.getByRole('button', { name: 'Select cell F0C0', exact: true })).toBeVisible()
})

test('rectangle selection, zoom and local axis/channel filtering preserve cell correspondence', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 })
  const state = await openMap(page)
  const point = page.getByRole('button', { name: 'Select cell F0C1', exact: true })
  await expect(point).toBeVisible()
  await point.scrollIntoViewIfNeeded()
  const requestsAfterLoad = state.featureRequests
  const box = (await point.boundingBox())!
  await page.mouse.move(box.x - 9, box.y - 9)
  await page.mouse.down()
  await page.mouse.move(box.x + box.width + 9, box.y + box.height + 9, { steps: 8 })
  await page.mouse.up()
  await expect(page.getByTestId('phenotype-counts')).toContainText('Selected: 1')
  await expect(page.getByTestId('phenotype-gallery').getByRole('button', { name: 'Inspect cell F0C1' })).toBeVisible()
  await page.getByRole('button', { name: 'Zoom to selection' }).click()
  await expect(page.locator('[data-cell-id]')).toHaveCount(1)
  await page.getByRole('button', { name: 'Reset view' }).click()
  await expect(page.locator('[data-cell-id]')).toHaveCount(3)

  await page.getByLabel('X axis', { exact: true }).selectOption('area_px2')
  await page.getByLabel('Y axis', { exact: true }).selectOption('normalized_median')
  await expect(page.getByRole('button', { name: 'Select cell F0C3', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select cell F0C2', exact: true })).toHaveCount(0)
  await page.getByLabel('Fluorescence channel').selectOption('fluo2')
  await expect(page.getByRole('button', { name: 'Select cell F0C2', exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select cell F0C1', exact: true })).toHaveCount(0)
  await page.getByLabel('Color by').selectOption('area_px2')
  await page.getByLabel('Manual label', { exact: true }).filter({ visible: true }).selectOption('1')
  await expect(page.getByTestId('phenotype-counts')).toContainText('Plotted 1 / 2 cells · Missing axis measurements: 1 · Selected: 0')
  await expect(page.getByRole('button', { name: 'Export selected CSV' })).toBeDisabled()
  expect(state.featureRequests).toBe(requestsAfterLoad)
})

test('supports keyboard selection and renders the map at desktop and mobile widths', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1100 })
  await openMap(page)
  const point = page.getByRole('button', { name: 'Select cell F0C0', exact: true })
  await point.press('Enter')
  await expect(point).toHaveAttribute('aria-pressed', 'true')
  await page.screenshot({ path: 'test-results/phenotype-map-desktop.png', fullPage: true })
  await page.setViewportSize({ width: 390, height: 844 })
  await expect(page.getByTestId('phenotype-scatter')).toBeVisible()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await expect(page.getByRole('banner')).toHaveCount(1)
  await page.getByTestId('phenotype-scatter').scrollIntoViewIfNeeded()
  await page.screenshot({ path: 'test-results/phenotype-map-mobile.png' })
  await page.getByRole('button', { name: 'Inspect cell F0C0', exact: true }).scrollIntoViewIfNeeded()
  await expect(page.getByRole('button', { name: 'Inspect cell F0C0', exact: true })).toBeInViewport()
})

test('handles an empty database and allows retry after a failed request', async ({ page }) => {
  const state = await openMap(page, true)
  await expect(page.getByRole('alert')).toContainText('Could not load phenotype features (500)')
  state.failRequests = false
  await page.getByRole('button', { name: 'Refresh measurements' }).click()
  await expect(page.getByTestId('phenotype-counts')).toContainText('Plotted 3 / 4 cells')
  expect(state.featureRequests).toBeGreaterThanOrEqual(2)
  await page.unroute('**/api/v1/**')
  await openMap(page, false, true)
  await expect(page.getByText('No cells match this label.')).toBeVisible()
  await expect(page.getByRole('button', { name: 'Select all visible' })).toBeDisabled()
})

test('compares the same channel across databases without merging matching cell IDs', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  const state = await openMap(page)
  await expect(page.getByRole('button', { name: 'Select cell F0C0', exact: true })).toBeVisible()
  await page.getByLabel(`Compare database ${otherDbName}`, { exact: true }).check()
  await page.getByRole('button', { name: 'Apply databases (2)' }).click()
  await expect(page.getByTestId('phenotype-counts')).toContainText('Plotted 5 / 7 cells')
  await expect(page.getByLabel('Color by')).toHaveValue('database')
  const primary = page.getByRole('button', { name: `Select cell F0C0 in ${dbName}`, exact: true })
  const secondary = page.getByRole('button', { name: `Select cell F0C0 in ${otherDbName}`, exact: true })
  await primary.click()
  await secondary.click({ modifiers: ['Shift'] })
  await expect(primary).toHaveAttribute('aria-pressed', 'true')
  await expect(secondary).toHaveAttribute('aria-pressed', 'true')
  await expect(page.getByTestId('phenotype-gallery').getByRole('button')).toHaveCount(2)
  await expect(page.getByRole('link', { name: 'Open Cell Viewer' })).toHaveAttribute('href',
    `/cells?${new URLSearchParams({ db: otherDbName, cell_id: 'F0C0' })}`)
  await expect.poll(() => state.imageRequests.some((url) => url.searchParams.get('dbname') === otherDbName &&
    url.searchParams.get('cell_id') === 'F0C0' && url.searchParams.get('image_type') === 'fluo1')).toBe(true)

  const csvPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export selected CSV' }).click()
  const [header, ...rows] = (await readFile((await (await csvPromise).path())!, 'utf8')).split('\r\n').map((line) => line.split(','))
  expect(rows.map((row) => [row[header.indexOf('dbname')], row[header.indexOf('cell_id')]])).toEqual([
    [dbName, 'F0C0'], [otherDbName, 'F0C0'],
  ])
  expect(rows.map((row) => Number(row[header.indexOf('fluo1_entropy_norm')]))).toEqual([0.2, 0.1])
  const jsonPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export selection JSON' }).click()
  const exported = JSON.parse(await readFile((await (await jsonPromise).path())!, 'utf8'))
  expect(exported.datasets.map((dataset: { dbname: string }) => dataset.dbname)).toEqual([dbName, otherDbName])
  expect(exported.cells.map((cell: { dbname: string }) => cell.dbname)).toEqual([dbName, otherDbName])
  expect(exported.settings.channel).toBe('fluo1')
  expect(exported.settings.distribution_metric).toBe('entropy_norm')
  const requests = state.comparisonRequests.length
  await page.getByLabel('Fluorescence channel').selectOption('fluo2')
  await expect.poll(() => state.imageRequests.some((url) => url.searchParams.get('dbname') === otherDbName &&
    url.searchParams.get('cell_id') === 'F0C0' && url.searchParams.get('image_type') === 'fluo2')).toBe(true)
  expect(state.comparisonRequests).toHaveLength(requests)
  await page.getByLabel('Distribution metric').selectOption('axial_spread')
  await page.getByLabel('Background correction').selectOption('none')
  await expect(page.getByTestId('phenotype-counts')).toContainText('Selected: 0')
  await expect(page.getByLabel('Distribution metric')).toHaveValue('axial_spread')
  expect(state.comparisonRequests).toHaveLength(requests + 1)
  expect(state.comparisonRequests.at(-1)).toEqual({ dbnames: [dbName, otherDbName], background_mode: 'none' })
})

test('shows normalized database distributions, known quartiles and unavailable sources', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 1200 })
  const state = await openMap(page)
  await page.getByLabel(`Compare database ${otherDbName}`, { exact: true }).check()
  await page.getByLabel(`Compare database ${missingDbName}`, { exact: true }).check()
  await page.getByRole('button', { name: 'Apply databases (3)' }).click()
  await expect(page.getByRole('alert')).toContainText(`${missingDbName}: Database not found`)
  const table = page.getByRole('table', { name: 'Database distribution summary' })
  const primaryRow = table.getByRole('row').filter({ hasText: dbName })
  const otherRow = table.getByRole('row').filter({ hasText: otherDbName })
  await expect(primaryRow.getByRole('cell')).toHaveText(['4', '3', '1', '0.4', '0.3 – 0.6'])
  await expect(otherRow.getByRole('cell')).toHaveText(['3', '2', '1', '0.5', '0.3 – 0.7'])
  await expect(page.locator('svg[aria-label="Database cumulative distributions"] path[data-dbname]')).toHaveCount(2)
  const csvPromise = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Export database summary CSV' }).click()
  const csv = (await readFile((await (await csvPromise).path())!, 'utf8')).split('\r\n').map((line) => line.split(','))
  expect(csv[1].slice(0, 8)).toEqual([dbName, 'fluo1', 'local_ring', 'All', 'entropy_norm', '4', '3', '1'])
  expect(Number(csv[1][8])).toBeCloseTo(0.3)
  expect(Number(csv[2][9])).toBeCloseTo(0.5)
  expect(csv[1][11]).toBe('2')
  expect(csv[1][12]).toBe(`source-${dbName}-local_ring`)
  expect(csv[3].at(-1)).toBe('Database not found')
  await page.getByTestId('database-comparison').screenshot({ path: 'test-results/phenotype-database-comparison.png' })
  const requests = state.comparisonRequests.length
  await page.getByLabel('Fluorescence channel').selectOption('fluo2')
  await expect(otherRow.getByRole('cell')).toHaveText(['3', '2', '1', '0.45', '0.325 – 0.575'])
  await page.getByLabel('Distribution metric').selectOption('polar_enrichment')
  expect(state.comparisonRequests).toHaveLength(requests)
  await page.setViewportSize({ width: 390, height: 844 })
  await page.getByTestId('database-comparison').scrollIntoViewIfNeeded()
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
  await page.screenshot({ path: 'test-results/phenotype-database-comparison-mobile.png' })
})

test('allows a different single database and prevents an empty source selection', async ({ page }) => {
  await openMap(page)
  await expect(page.getByRole('button', { name: 'Select cell F0C0', exact: true })).toBeVisible()
  await page.getByLabel(`Compare database ${dbName}`, { exact: true }).uncheck()
  await expect(page.getByRole('button', { name: 'Apply databases (0)' })).toBeDisabled()
  await page.getByLabel(`Compare database ${otherDbName}`, { exact: true }).check()
  await page.getByRole('button', { name: 'Apply databases (1)' }).click()
  await expect(page.getByTestId('phenotype-counts')).toContainText('Plotted 2 / 3 cells')
  await page.getByRole('button', { name: 'Select cell F0C0', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Open Cell Viewer' })).toHaveAttribute('href',
    `/cells?${new URLSearchParams({ db: otherDbName, cell_id: 'F0C0' })}`)
  await expect(page.getByTestId('database-comparison')).toHaveCount(0)
})
