import { expect, test } from 'playwright/test'
import { strToU8, zipSync } from 'fflate'

test('FITC threshold is sent to the API and changing it clears the previous result', async ({ page }) => {
  const requests: URL[] = []
  await page.route('**/api/v1/**', async (route) => {
    const url = new URL(route.request().url())
    const headers = { 'access-control-allow-origin': '*' }
    if (url.pathname.endsWith('/get-annotation-zip')) {
      await route.fulfill({ headers, contentType: 'application/zip',
        body: Buffer.from(zipSync({ 'manifest.json': strToU8('[]') })) })
    } else if (url.pathname.endsWith('/get-fitc-aggregation-plot')) {
      requests.push(url)
      await route.fulfill({ headers, contentType: 'image/svg+xml',
        body: '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"/>' })
    } else {
      await route.fulfill({ headers, json: {} })
    }
  })
  await page.goto('/bulk-engine?dbname=sample.db')
  await page.getByLabel('Analysis mode').selectOption('fitc-aggregation')
  const threshold = page.getByRole('spinbutton', { name: 'Threshold', exact: true })
  const calculate = page.getByRole('button', { name: 'Calc ratio', exact: true })
  const plot = page.getByRole('img', { name: 'FITC aggregation ratio bar chart' })

  await expect(threshold).toHaveValue('0.7414')
  await calculate.click()
  await expect(plot).toBeVisible()
  expect(requests[0].searchParams.get('threshold')).toBe('0.7414')
  expect(requests[0].searchParams.get('channel')).toBe('fluo1')

  await threshold.fill('0.71414')
  await expect(plot).toHaveCount(0)
  await calculate.click()
  await expect(plot).toBeVisible()
  expect(requests[1].searchParams.get('threshold')).toBe('0.71414')

  for (const invalid of ['', '-0.1', '1.1']) {
    await threshold.fill(invalid)
    await expect(calculate).toBeDisabled()
    await expect(threshold).toHaveAttribute('aria-invalid', 'true')
  }
  expect(requests).toHaveLength(2)
  for (const boundary of ['0', '1']) {
    await threshold.fill(boundary)
    await expect(calculate).toBeEnabled()
    await calculate.click()
    await expect(plot).toBeVisible()
    expect(requests.at(-1)?.searchParams.get('threshold')).toBe(boundary)
  }
})
