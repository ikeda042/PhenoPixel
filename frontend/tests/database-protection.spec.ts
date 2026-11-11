import { expect, test, type Page } from 'playwright/test'

const protectedName = 'test_database.db'
const ordinaryName = 'experiment.db'

async function openDatabases(page: Page) {
  const state = { names: [ordinaryName, protectedName], mutations: [] as string[] }
  await page.route('**/api/v1/**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const path = url.pathname.replace('/api/v1', '')
    const headers = { 'access-control-allow-origin': '*' }
    if (request.method() === 'OPTIONS') {
      await route.fulfill({
        status: 204,
        headers: {
          ...headers,
          'access-control-allow-methods': 'GET, POST, PATCH, DELETE',
          'access-control-allow-headers': 'content-type',
        },
      })
      return
    }
    if (path === '/get-databases') {
      await route.fulfill({ headers, json: state.names })
      return
    }
    if (path.startsWith('/database_files') && request.method() !== 'GET') {
      state.mutations.push(`${request.method()} ${path}`)
      const name = decodeURIComponent(path.slice('/database_files/'.length))
      if (request.method() === 'DELETE') {
        state.names = state.names.filter((item) => item !== name)
      } else if (request.method() === 'PATCH') {
        state.names = state.names.map((item) => item === name ? url.searchParams.get('new_name')! : item)
      }
    }
    await route.fulfill({ headers, json: {} })
  })
  await page.goto('/databases')
  await expect(page.getByRole('button', { name: `Delete ${protectedName}`, exact: true })).toBeVisible()
  return state
}

test('disables deletion and rename of the bundled database while allowing downloads', async ({ page }) => {
  const state = await openDatabases(page)
  await expect(page.getByText('Protected', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: `Delete ${protectedName}`, exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: `Rename ${protectedName}`, exact: true })).toBeDisabled()
  await expect(page.getByRole('button', { name: `Download ${protectedName}`, exact: true })).toBeEnabled()
  const selection = page.getByRole('checkbox', { name: `Select ${protectedName}`, exact: true })
  await selection.press('Space')
  await expect(selection).toBeChecked()
  await expect(page.getByRole('button', { name: 'Download ZIP', exact: true })).toBeEnabled()
  expect(state.mutations).toEqual([])
})

test('blocks uploads and rename targets that would replace the bundled database', async ({ page }) => {
  const state = await openDatabases(page)
  await page.locator('input[type="file"]').setInputFiles({
    name: protectedName,
    mimeType: 'application/octet-stream',
    buffer: Buffer.from('replacement database'),
  })
  await expect(page.getByText(/is a bundled database and cannot be deleted/)).toBeVisible()
  expect(state.mutations).toEqual([])

  await page.getByRole('button', { name: `Rename ${ordinaryName}`, exact: true }).click()
  await page.getByRole('textbox').last().fill(protectedName)
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByText(/is a bundled database and cannot be deleted/)).toBeVisible()
  expect(state.mutations).toEqual([])
})

test('still allows renaming and deleting ordinary databases', async ({ page }) => {
  const state = await openDatabases(page)
  await page.getByRole('button', { name: `Rename ${ordinaryName}`, exact: true }).click()
  await page.getByRole('textbox').last().fill('renamed.db')
  await page.getByRole('button', { name: 'Save', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Delete renamed.db', exact: true })).toBeEnabled()
  page.once('dialog', (dialog) => dialog.accept())
  await page.getByRole('button', { name: 'Delete renamed.db', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Delete renamed.db', exact: true })).toHaveCount(0)
  await expect(page.getByRole('button', { name: `Delete ${protectedName}`, exact: true })).toBeDisabled()
  expect(state.mutations).toEqual([
    `PATCH /database_files/${ordinaryName}`,
    'DELETE /database_files/renamed.db',
  ])
})
