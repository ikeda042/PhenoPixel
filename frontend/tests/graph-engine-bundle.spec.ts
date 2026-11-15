import { expect, test } from 'playwright/test'
import { zipSync } from 'fflate'

test('Graph Engine loads the four plots in one request per CSV', async ({ page }) => {
  const paths: string[] = []
  const png = new Uint8Array(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/a1sAAAAASUVORK5CYII=',
    'base64',
  ))
  await page.route('**/api/v1/**', async (route) => {
    const path = new URL(route.request().url()).pathname
    paths.push(path)
    const headers = { 'access-control-allow-origin': '*' }
    if (path.endsWith('/graph_engine/images')) {
      await route.fulfill({ headers, contentType: 'application/zip', body: Buffer.from(zipSync({
        'abs.png': png, 'rel.png': png, 'dist.png': png, 'dist_box.png': png,
      })) })
    } else if (path.endsWith('/graph_engine/HU_aggregation_ratio')) {
      await route.fulfill({ headers, json: [{ filename: 'sample.csv', mean_length: 2, nagg_rate: 0.5 }] })
    } else {
      await route.fulfill({ headers, json: {} })
    }
  })
  await page.goto('/graph-engine')
  await page.locator('input[type=file][multiple]').setInputFiles({
    name: 'sample.csv', mimeType: 'text/csv', buffer: Buffer.from('0,1\n1,2\n'),
  })
  await page.getByRole('button', { name: 'Analyze' }).click()
  for (const name of ['heatmap abs', 'heatmap rel', 'distribution', 'distribution box']) {
    await expect(page.getByRole('img', { name, exact: true })).toBeVisible()
  }
  expect(paths.filter((path) => path.endsWith('/graph_engine/images'))).toHaveLength(1)
  expect(paths.filter((path) => /graph_engine\/(heatmap_|distribution)/.test(path))).toHaveLength(0)
})
