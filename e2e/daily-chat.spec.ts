import { expect, test, type Page } from '@playwright/test'

async function openDailyChat(page: Page) {
  await page.goto('/?scenario=ai-connected')
  await page.getByRole('navigation').getByRole('button', { name: 'Chat', exact: true }).click()
}

test('Daily Chat filters by title while preserving and changing the selected transcript', async ({
  page,
}) => {
  await openDailyChat(page)
  const search = page.getByRole('searchbox', { name: 'Search conversations' })

  await expect(search).toBeVisible()
  await expect(page.getByRole('navigation', { name: 'Pagination for conversations' })).toBeVisible()

  await page.getByText('Morning reflections', { exact: true }).click()
  await expect(page.getByText(/Good morning! It's wonderful/)).toBeVisible()

  await search.fill('processing difficult week')
  await expect(page.getByText('Processing a difficult week', { exact: true })).toBeVisible()
  await expect(
    page.getByRole('complementary').getByText('Morning reflections', { exact: true }),
  ).toHaveCount(0)
  await expect(
    page.getByText('Selected conversation is outside these search results.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText(/Good morning! It's wonderful/)).toBeVisible()

  await page.getByText('Processing a difficult week', { exact: true }).click()
  await expect(page.getByText(/Honestly, this week has been rough/)).toBeVisible()
})

test('Daily Chat searches message content fuzzily, folds diacritics, and clears results', async ({
  page,
}) => {
  await openDailyChat(page)
  const search = page.getByRole('searchbox', { name: 'Search conversations' })

  await search.fill('30minwalk')
  await expect(page.getByText('Goal-setting for the month', { exact: true })).toBeVisible()
  await expect(page.getByText('Morning reflections', { exact: true })).toHaveCount(0)

  await search.fill('dann')
  await expect(page.getByText('New chat', { exact: true }).first()).toBeVisible()

  await search.fill('zzzzzz')
  await expect(page.getByText('No conversations match your search.', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: 'Clear conversation search' }).click()
  await expect(search).toHaveValue('')
  await expect(page.getByText('Morning reflections', { exact: true })).toBeVisible()
  await expect(page.getByText('Travel planning thoughts', { exact: true })).toBeVisible()
})
