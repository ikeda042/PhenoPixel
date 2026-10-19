import { expect, test, type Page } from 'playwright/test'

const filename = '対照 #1.nd2'
const dbName = 'extracted #1.db'
const extractionUrl = `/cell-extraction?filename=${encodeURIComponent(filename)}`
const annotationUrl = `/annotation?dbname=${encodeURIComponent(dbName)}`

async function openExtraction(page: Page) {
  const state = {
    jobCount: 0,
    jobStatus: 'completed',
    dbName,
    deleteStatus: 200,
    deletedFiles: [] as string[],
    waitForDelete: Promise.resolve(),
  }
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const path = new URL(request.url()).pathname.replace('/api/v1', '')
    const headers = { 'access-control-allow-origin': '*' }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          ...headers,
          'access-control-allow-methods': 'GET, POST, DELETE',
          'access-control-allow-headers': 'content-type',
        },
      })
      return
    }
    if (path.startsWith('/nd2_files/') && request.method() === 'DELETE') {
      state.deletedFiles.push(decodeURIComponent(path.slice('/nd2_files/'.length)))
      await state.waitForDelete
      await route.fulfill({ status: state.deleteStatus, headers, json: {} })
      return
    }
    let json: object = {}
    if (path === '/extract-cells' && request.method() === 'POST') {
      state.jobCount += 1
      json = { job_id: `job-${state.jobCount}`, status: 'running' }
    } else if (path.startsWith('/extract-cells/')) {
      json = {
        job_id: `job-${state.jobCount}`,
        status: state.jobStatus,
        error: 'Extraction failed',
        result: {
          nd2_stem: filename.slice(0, -4),
          databases: [{ db_name: state.dbName }],
        },
      }
    } else if (path.endsWith('/metadata')) {
      json = { reader: { sizes: { c: 2 } } }
    } else if (path === '/get-extracted-image-count') {
      json = { count: 0 }
    }
    await route.fulfill({ headers, json })
  })
  await page.goto(extractionUrl)
  await page.locator('label').filter({ hasText: 'Auto Annotation' }).click()
  return state
}

async function extract(page: Page) {
  await page.getByRole('button', { name: 'Extract Cells', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Go to annotation', exact: true })).toBeEnabled()
}

test('keeps the source through extraction and waits for deletion before annotation', async ({ page }) => {
  const state = await openExtraction(page)
  await extract(page)
  expect(state.deletedFiles).toEqual([])

  let finishDelete = () => {}
  state.waitForDelete = new Promise<void>((resolve) => { finishDelete = resolve })
  await page.getByRole('button', { name: 'Go to annotation', exact: true }).click()
  await expect.poll(() => state.deletedFiles).toEqual([filename])
  await expect(page).toHaveURL(extractionUrl)
  await expect(page.getByRole('button', { name: 'Deleting ND2...' })).toBeDisabled()
  await expect(page.getByRole('button', { name: 'Re-extract', exact: true })).toBeDisabled()

  finishDelete()
  await expect(page).toHaveURL(annotationUrl)
})

test('protects the source during re-extraction and uses the latest database', async ({ page }) => {
  const state = await openExtraction(page)
  await extract(page)
  state.jobStatus = 'running'
  await page.getByRole('button', { name: 'Re-extract', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Go to annotation', exact: true })).toBeDisabled()
  expect(state.deletedFiles).toEqual([])

  state.jobStatus = 'failed'
  await expect(page.getByText('Extraction failed', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Go to annotation', exact: true })).toBeDisabled()
  expect(state.deletedFiles).toEqual([])

  state.jobStatus = 'completed'
  state.dbName = 're-extracted #3.db'
  await page.getByRole('button', { name: 'Re-extract', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Go to annotation', exact: true })).toBeEnabled()
  expect(state.deletedFiles).toEqual([])
  await page.getByRole('button', { name: 'Go to annotation', exact: true }).click()
  await expect(page).toHaveURL(`/annotation?dbname=${encodeURIComponent(state.dbName)}`)
  expect(state.deletedFiles).toEqual([filename])
  expect(state.jobCount).toBe(3)
})

test('stays on extraction when deletion fails and allows retry', async ({ page }) => {
  const state = await openExtraction(page)
  await extract(page)
  state.deleteStatus = 500
  await page.getByRole('button', { name: 'Go to annotation', exact: true }).click()
  await expect(page.getByText('Failed to delete source ND2 (500). Please try again.')).toBeVisible()
  await expect(page).toHaveURL(extractionUrl)
  await expect(page.getByRole('button', { name: 'Re-extract', exact: true })).toBeEnabled()

  state.deleteStatus = 200
  await page.getByRole('button', { name: 'Go to annotation', exact: true }).click()
  await expect(page).toHaveURL(annotationUrl)
  expect(state.deletedFiles).toEqual([filename, filename])
})

test('opens annotation when the source was already deleted', async ({ page }) => {
  const state = await openExtraction(page)
  await extract(page)
  state.deleteStatus = 404
  await page.getByRole('button', { name: 'Go to annotation', exact: true }).click()
  await expect(page).toHaveURL(annotationUrl)
  expect(state.deletedFiles).toEqual([filename])
})
