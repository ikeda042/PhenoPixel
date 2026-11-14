import { expect, test, type Page } from 'playwright/test'

const dbName = 'sample #1.db'
const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="160" height="160"><rect width="160" height="160" fill="#168477"/></svg>'

async function openCells(page: Page, mode = 'e-means') {
  const state = { requests: [] as URL[], status: 200, waitForPlot: Promise.resolve(), completed: 0 }
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const path = url.pathname.replace('/api/v1/', '')
    const headers = { 'access-control-allow-origin': '*' }
    if (path === 'get-cell-e-means' || path === 'get-cell-e-means-spots') {
      state.requests.push(url)
      await state.waitForPlot
      if (state.status !== 200) {
        await route.fulfill({ headers, status: state.status,
          json: { detail: 'Clusters cannot exceed the number of cell pixels (2)' } })
      } else {
        await route.fulfill({ headers, contentType: 'image/svg+xml', body: svg })
      }
      state.completed += 1
    } else if (path === 'get-cell-ids' || path === 'get-cell-ids-by-label') {
      await route.fulfill({ headers, json: ['F0C0', 'F0C1'] })
    } else if (path === 'get-manual-labels') {
      await route.fulfill({ headers, json: ['1', '2', '3'] })
    } else if (path === 'get-cell-label') {
      await route.fulfill({ headers, json: '1' })
    } else if (path === 'get-cell-image' || path === 'get-cell-replot') {
      await route.fulfill({ headers, contentType: 'image/svg+xml', body: svg })
    } else {
      await route.fulfill({ headers, json: {} })
    }
  })
  await page.goto(`/cells?db=${encodeURIComponent(dbName)}`)
  await expect(page.getByRole('button', { name: 'Next', exact: true })).toBeEnabled()
  await page.getByLabel('Draw mode', { exact: true }).selectOption(mode)
  return state
}

test('calculates only on Calc using the current cell and requested cluster count', async ({ page }) => {
  const state = await openCells(page)
  const clusters = page.getByRole('spinbutton', { name: 'Clusters', exact: true })
  const calculate = page.getByRole('button', { name: 'Calc', exact: true })
  const plot = page.getByRole('img', { name: 'F0C0 e-means clustering', exact: true })
  await expect(clusters).toHaveValue('3')
  await clusters.fill('4')
  expect(state.requests).toHaveLength(0)
  await calculate.click()
  await expect(plot).toBeVisible()
  expect(state.requests).toHaveLength(1)
  expect(Object.fromEntries(state.requests[0].searchParams)).toEqual({
    dbname: dbName, cell_id: 'F0C0', n_clusters: '4', dark_mode: 'true',
  })
  await clusters.fill('2')
  await expect(plot).toHaveCount(0)
  expect(state.requests).toHaveLength(1)
  await calculate.click()
  await expect(plot).toBeVisible()
  expect(state.requests[1].searchParams.get('n_clusters')).toBe('2')

  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(plot).toHaveCount(0)
  expect(state.requests).toHaveLength(2)
  await expect(clusters).toHaveValue('2')
  await calculate.click()
  await expect(page.getByRole('img', { name: 'F0C1 e-means clustering', exact: true })).toBeVisible()
  expect(state.requests[2].searchParams.get('cell_id')).toBe('F0C1')
  await page.getByLabel('Draw mode', { exact: true }).selectOption('replot')
  await expect(page.getByRole('img', { name: 'F0C1 replot', exact: true })).toBeVisible()
  await page.getByLabel('Draw mode', { exact: true }).selectOption('e-means')
  await expect(page.getByRole('img', { name: /e-means clustering/ })).toHaveCount(0)
  await expect(clusters).toHaveValue('2')
  expect(state.requests).toHaveLength(3)
})

test('validates integer cluster counts before sending a request', async ({ page }) => {
  const state = await openCells(page)
  const clusters = page.getByRole('spinbutton', { name: 'Clusters', exact: true })
  const calculate = page.getByRole('button', { name: 'Calc', exact: true })
  for (const invalid of ['', '0', '-1', '65', '2.5']) {
    await clusters.fill(invalid)
    await expect(clusters).toHaveAttribute('aria-invalid', 'true')
    await expect(calculate).toBeDisabled()
  }
  for (const valid of ['1', '64']) {
    await clusters.fill(valid)
    await expect(clusters).toHaveAttribute('aria-invalid', 'false')
    await expect(calculate).toBeEnabled()
  }
  expect(state.requests).toHaveLength(0)
})

test('shows backend errors and allows retry', async ({ page }) => {
  const state = await openCells(page)
  state.status = 400
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByRole('alert')).toHaveText('Clusters cannot exceed the number of cell pixels (2)')
  state.status = 200
  await page.getByRole('spinbutton', { name: 'Clusters', exact: true }).fill('2')
  await expect(page.getByRole('alert')).toHaveCount(0)
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByRole('img', { name: 'F0C0 e-means clustering', exact: true })).toBeVisible()
})

test('discards in-flight results after changing clusters or cells', async ({ page }) => {
  const state = await openCells(page)
  for (const change of ['clusters', 'cell']) {
    let finish = () => {}
    state.waitForPlot = new Promise<void>((resolve) => { finish = resolve })
    await page.getByRole('button', { name: 'Calc', exact: true }).click()
    await expect.poll(() => state.requests.length).toBe(change === 'clusters' ? 1 : 2)
    await expect(page.getByRole('status')).toHaveText('Calculating e-means...')
    if (change === 'clusters') {
      await page.getByRole('spinbutton', { name: 'Clusters', exact: true }).fill('4')
    } else {
      await page.getByRole('button', { name: 'Next', exact: true }).click()
    }
    finish()
    await expect.poll(() => state.completed).toBe(change === 'clusters' ? 1 : 2)
    await expect(page.getByRole('img', { name: /e-means clustering/ })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Calc', exact: true })).toBeEnabled()
  }
})

test('spot mode sends fixed maximum count, channel, widths and SNR only on Calc', async ({ page }) => {
  const state = await openCells(page, 'e-means-spots')
  await page.getByLabel('Spot tuning', { exact: true }).selectOption('manual')
  const calculate = page.getByRole('button', { name: 'Calc', exact: true })
  const image = page.getByRole('img', { name: 'F0C0 e-means spots', exact: true })
  await page.getByLabel('Spot channel', { exact: true }).selectOption('fluo2')
  await page.getByRole('spinbutton', { name: 'Min σ', exact: true }).fill('0.8')
  await page.getByRole('spinbutton', { name: 'Max σ', exact: true }).fill('3.5')
  await page.getByRole('spinbutton', { name: 'Min SNR', exact: true }).fill('6')
  expect(state.requests).toHaveLength(0)
  await calculate.click()
  await expect(image).toBeVisible()
  expect(state.requests[0].pathname).toBe('/api/v1/get-cell-e-means-spots')
  expect(Object.fromEntries(state.requests[0].searchParams)).toEqual({
    dbname: dbName, cell_id: 'F0C0', dark_mode: 'true', channel: 'fluo2',
    max_spots: '10', sigma_min: '0.8', sigma_max: '3.5', min_snr: '6', auto_tune: 'false',
  })
  await page.getByLabel('Spot channel', { exact: true }).selectOption('fluo1')
  await expect(image).toHaveCount(0)
  await calculate.click()
  await expect(image).toBeVisible()
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(image).toHaveCount(0)
  await expect(page.getByRole('spinbutton', { name: 'Max σ', exact: true })).toHaveValue('3.5')
  await expect(page.getByRole('spinbutton', { name: 'Min SNR', exact: true })).toHaveValue('6')
  expect(state.requests).toHaveLength(2)
})

test('spot mode rejects invalid widths and SNR', async ({ page }) => {
  const state = await openCells(page, 'e-means-spots')
  await page.getByLabel('Spot tuning', { exact: true }).selectOption('manual')
  const calculate = page.getByRole('button', { name: 'Calc', exact: true })
  for (const [name, invalids, valid] of [
    ['Min σ', ['', '0.4', '4', '5'], '1'],
    ['Max σ', ['', '0.8', '1', '11'], '4'],
    ['Min SNR', ['', '1', '31'], '4'],
  ] as const) {
    const input = page.getByRole('spinbutton', { name, exact: true })
    for (const value of invalids) {
      await input.fill(value)
      await expect(input).toHaveAttribute('aria-invalid', 'true')
      await expect(calculate).toBeDisabled()
    }
    await input.fill(valid)
    await expect(calculate).toBeEnabled()
  }
  expect(state.requests).toHaveLength(0)
})

test('changing spot parameters cancels a running calculation', async ({ page }) => {
  const state = await openCells(page, 'e-means-spots')
  await page.getByLabel('Spot tuning', { exact: true }).selectOption('manual')
  let finish = () => {}
  state.waitForPlot = new Promise<void>((resolve) => { finish = resolve })
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect.poll(() => state.requests.length).toBe(1)
  await page.getByRole('spinbutton', { name: 'Max σ', exact: true }).fill('3')
  finish()
  await expect.poll(() => state.completed).toBe(1)
  await expect(page.getByRole('img', { name: /e-means spots/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Calc', exact: true })).toBeEnabled()
})

test('spots default to Auto with a fixed count cap', async ({ page }) => {
  const state = await openCells(page, 'e-means-spots')
  const tuning = page.getByLabel('Spot tuning', { exact: true })
  await expect(tuning).toHaveValue('auto')
  await expect(page.getByRole('spinbutton', { name: 'Min SNR', exact: true })).toHaveCount(0)
  await expect(page.getByRole('spinbutton', { name: 'Min σ', exact: true })).toHaveCount(0)
  await page.getByLabel('Spot channel', { exact: true }).selectOption('fluo2')
  expect(state.requests).toHaveLength(0)
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByRole('img', { name: 'F0C0 e-means spots', exact: true })).toBeVisible()
  expect(Object.fromEntries(state.requests[0].searchParams)).toEqual({
    dbname: dbName, cell_id: 'F0C0', dark_mode: 'true', channel: 'fluo2', max_spots: '10', auto_tune: 'true',
  })
  await page.getByRole('button', { name: 'Next', exact: true }).click()
  await expect(page.getByRole('img', { name: /e-means spots/ })).toHaveCount(0)
  await expect(tuning).toHaveValue('auto')
  await expect(page.getByText('Max spots: 10', { exact: true })).toBeVisible()
})

test('Auto ignores hidden invalid manual values and restores them on return', async ({ page }) => {
  const state = await openCells(page, 'e-means-spots')
  const tuning = page.getByLabel('Spot tuning', { exact: true })
  const calculate = page.getByRole('button', { name: 'Calc', exact: true })
  await tuning.selectOption('manual')
  await page.getByRole('spinbutton', { name: 'Min σ', exact: true }).fill('5')
  await expect(calculate).toBeDisabled()
  await tuning.selectOption('auto')
  await expect(calculate).toBeEnabled()
  await calculate.click()
  await expect(page.getByRole('img', { name: /e-means spots/ })).toBeVisible()
  expect(state.requests[0].searchParams.has('sigma_min')).toBe(false)
  await tuning.selectOption('manual')
  await expect(page.getByRole('img', { name: /e-means spots/ })).toHaveCount(0)
  await expect(page.getByRole('spinbutton', { name: 'Min σ', exact: true })).toHaveValue('5')
  await expect(calculate).toBeDisabled()
})

test('switching from Auto to Manual cancels a running calculation', async ({ page }) => {
  const state = await openCells(page, 'e-means-spots')
  let finish = () => {}
  state.waitForPlot = new Promise<void>((resolve) => { finish = resolve })
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect.poll(() => state.requests.length).toBe(1)
  await page.getByLabel('Spot tuning', { exact: true }).selectOption('manual')
  finish()
  await expect.poll(() => state.completed).toBe(1)
  await expect(page.getByRole('img', { name: /e-means spots/ })).toHaveCount(0)
  await expect(page.getByRole('button', { name: 'Calc', exact: true })).toBeEnabled()
})


test('spot count stays fixed independently of the clustering count', async ({ page }) => {
  const state = await openCells(page)
  const clusters = page.getByRole('spinbutton', { name: 'Clusters', exact: true })
  await clusters.fill('')
  await page.getByLabel('Draw mode', { exact: true }).selectOption('e-means-spots')
  await expect(page.getByText('Max spots: 10', { exact: true })).toBeVisible()
  await expect(page.getByRole('spinbutton', { name: 'Max spots', exact: true })).toHaveCount(0)
  await page.getByRole('button', { name: 'Calc', exact: true }).click()
  await expect(page.getByRole('img', { name: 'F0C0 e-means spots', exact: true })).toBeVisible()
  expect(state.requests[0].searchParams.get('max_spots')).toBe('10')
  await page.getByLabel('Draw mode', { exact: true }).selectOption('e-means')
  await expect(clusters).toHaveValue('')
  await expect(page.getByRole('button', { name: 'Calc', exact: true })).toBeDisabled()
})
