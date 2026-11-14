import { readFile } from 'node:fs/promises'
import { expect, test, type Page } from 'playwright/test'

const dbName = 'sample #1.db'
const settings = { sigma_min: .75, sigma_max: 4, min_snr: 4.5, min_bic: 10, auto_tune: true }
const spot = (id: number, long: number, lateral: number | null = .3) => ({
  spot_id: id, raw_x: 30, raw_y: 20, longitudinal: long, nearest_pole: Math.min(long, 1 - long),
  lateral, lateral_reason: lateral === null ? 'Local width is unreliable near a pole' : null,
  amplitude: 80, snr: 12, bic_improvement: 20,
})
const cells = [
  { cell_id: 'A', manual_label: '1', status: 'ok', error: null, length_px: 60, at_cap: false, settings,
    spots: [spot(1, .1), spot(2, .11), spot(3, .75, null)] },
  { cell_id: 'B', manual_label: '1', status: 'ok', error: null, length_px: 70, at_cap: false, settings, spots: [] },
  { cell_id: 'C', manual_label: 'N/A', status: 'skipped', error: 'Fluorescence image missing', length_px: null,
    at_cap: false, settings: null, spots: [] },
]
async function open(page: Page) {
  const state = { requests: [] as URL[], status: 200, wait: Promise.resolve(), empty: false, zero: false }
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const headers = { 'access-control-allow-origin': '*' }
    if (url.pathname.endsWith('/get-gfp-spot-localization')) {
      state.requests.push(url)
      await state.wait
      if (state.status !== 200) { await route.fulfill({ headers, status: state.status, json: { detail: 'Calculation unavailable' } }); return }
      await route.fulfill({ headers, json: {
        dbname: dbName, channel: url.searchParams.get('channel'), label: url.searchParams.get('label'),
        version: '1', max_spots: 10, auto_tune: true, coordinate_system: 'contour_centerline_arc_length_and_local_half_width', orientation: 'unassigned',
        cells: state.empty ? [] : state.zero ? [cells[1]] : cells,
        summary: state.empty ? { total_cells: 0, analyzed_cells: 0, skipped_cells: 0, positive_cells: 0, total_spots: 0, at_cap_cells: 0, unmapped_lateral_spots: 0 }
          : state.zero ? { total_cells: 1, analyzed_cells: 1, skipped_cells: 0, positive_cells: 0, total_spots: 0, at_cap_cells: 0, unmapped_lateral_spots: 0 }
          : { total_cells: 3, analyzed_cells: 2, skipped_cells: 1, positive_cells: 1, total_spots: 3, at_cap_cells: 0, unmapped_lateral_spots: 1 },
      } })
    } else if (url.pathname.endsWith('/get-manual-labels')) {
      await route.fulfill({ headers, json: ['1', '2', 'N/A'] })
    } else if (url.pathname.endsWith('/get-cell-image')) {
      await route.fulfill({ headers, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#182622"/><rect x="20" y="60" width="120" height="40" rx="20" fill="#79988b"/><circle cx="38" cy="80" r="6" fill="#56ef74"/></svg>' })
    } else { await route.fulfill({ headers, json: [] }) }
  })
  await page.goto(`/bulk-engine?${new URLSearchParams({ dbname: dbName, mode: 'gfp-spot-localization' })}`)
  await expect(page.getByTestId('spot-localization')).toBeVisible()
  return state
}

test('calculates explicitly, keeps zero cells in frequency denominator, and retains cell patterns', async ({ page }) => {
  const state = await open(page)
  expect(state.requests).toHaveLength(0)
  await expect(page.getByText('Auto · Max spots: 10 / cell', { exact: true })).toBeVisible()
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Normalized GFP spot map', exact: true })).toBeVisible()
  expect(Object.fromEntries(state.requests[0].searchParams)).toEqual({ dbname: dbName, channel: 'fluo1', label: 'All' })
  await expect(page.getByTestId('position-bin-4')).toHaveAttribute('data-value', '50')
  await expect(page.getByTestId('cell-row-B')).toContainText('0 spots')
  await expect(page.getByTestId('cell-row-C')).toContainText('Skipped: Fluorescence image missing')
  await expect(page.getByRole('img', { name: 'Normalized GFP spot map', exact: true }).locator('circle')).toHaveCount(2)
  await expect(page.getByRole('img', { name: 'A: 3 spots', exact: true }).locator('circle')).toHaveCount(3)
  await page.getByLabel('Distribution measure', { exact: true }).selectOption('spots')
  await expect(page.getByTestId('position-bin-4')).toHaveAttribute('data-value', '2')
  await page.getByLabel('Position axis', { exact: true }).selectOption('longitudinal')
  await expect(page.getByTestId('position-bin-2')).toHaveAttribute('data-value', '2')
  expect(state.requests).toHaveLength(1)
  await page.getByRole('button', { name: 'A', exact: true }).click()
  await expect(page.getByRole('link', { name: 'Open cell viewer ↗' })).toHaveAttribute('href', /cell_id=A/)
  await page.getByTestId('spot-localization').evaluate((element) => {
    for (let node: HTMLElement | null = element; node; node = node.parentElement) node.scrollTop = 0
  })
  await page.screenshot({ path: '/tmp/phenopixel-spot-localization-desktop.png', fullPage: true })
})

test('exports spot coordinates, zero and skipped cells, and SVG', async ({ page }) => {
  await open(page)
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Export spots CSV' })).toBeVisible()
  for (const [button, match] of [
    ['Export spots CSV', '"nearest_pole","lateral"'], ['Export cells CSV', '"B","1","ok","","0"'],
    ['Export map SVG', 'xmlns="http://www.w3.org/2000/svg"'],
  ]) {
    const pending = page.waitForEvent('download')
    await page.getByRole('button', { name: button, exact: true }).click()
    const downloaded = await pending
    expect(await readFile((await downloaded.path())!, 'utf8')).toContain(match)
  }
})

test('clears changed inputs, ignores stale requests, and retries errors', async ({ page }) => {
  const state = await open(page)
  let release = () => {}
  state.wait = new Promise<void>((resolve) => { release = resolve })
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect.poll(() => state.requests.length).toBe(1)
  await page.getByLabel('GFP channel', { exact: true }).selectOption('fluo2')
  release()
  await expect(page.getByRole('img', { name: 'Normalized GFP spot map', exact: true })).toHaveCount(0)
  state.status = 500
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Calculation unavailable')
  state.status = 200
  await page.getByLabel('Spot manual label', { exact: true }).selectOption('2')
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByRole('img', { name: 'Normalized GFP spot map', exact: true })).toBeVisible()
  expect(state.requests.at(-1)?.searchParams.get('channel')).toBe('fluo2')
  expect(state.requests.at(-1)?.searchParams.get('label')).toBe('2')
})

test('distinguishes empty selection from valid zero detections on a small screen', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 })
  const state = await open(page)
  state.empty = true
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByText('No cells match this label.', { exact: true })).toBeVisible()
  state.empty = false; state.zero = true
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByText('No spots met the acceptance criteria.', { exact: false })).toBeVisible()
  await expect(page.getByTestId('cell-row-B')).toContainText('0 spots')
  await page.screenshot({ path: '/tmp/phenopixel-spot-localization-mobile.png', fullPage: true })
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390)
})
